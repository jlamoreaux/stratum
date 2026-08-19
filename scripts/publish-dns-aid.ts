/**
 * Publish DNS for AI Discovery (DNS-AID) records for a Cloudflare-hosted zone.
 *
 * Creates/updates the `_agents` well-known entrypoint as a ServiceMode HTTPS
 * record (RFC 9460) pointing at the Stratum instance, and reports the zone's
 * DNSSEC status (validating resolvers should get authenticated data).
 *
 *   _index._agents.<zone>. 3600 IN HTTPS 1 <target>. alpn="h2"
 *
 * Run with: npx tsx scripts/publish-dns-aid.ts [--dry-run] [--enable-dnssec]
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN  required — token with Zone:Read + DNS:Edit on the zone
 *   DNS_AID_ZONE          zone apex        (default: usestratum.dev)
 *   DNS_AID_TARGET        endpoint host    (default: app.usestratum.dev)
 *
 * See docs/runbooks/dns-aid.md for the full runbook (DNSSEC, validation,
 * self-hosting guidance).
 */

const API = "https://api.cloudflare.com/client/v4";

const TTL = 3600;
const RECORD_COMMENT = "DNS-AID agent discovery entrypoint (docs/runbooks/dns-aid.md)";

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  ttl: number;
  data?: { priority: number; target: string; value: string };
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const zoneName = process.env.DNS_AID_ZONE ?? "usestratum.dev";
const target = process.env.DNS_AID_TARGET ?? "app.usestratum.dev";
const dryRun = process.argv.includes("--dry-run");
const enableDnssec = process.argv.includes("--enable-dnssec");

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await res.json()) as CfResponse<T>;
  if (!res.ok || !body.success) {
    const detail = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
    throw new Error(`Cloudflare API ${init?.method ?? "GET"} ${path} failed — ${detail}`);
  }
  return body.result;
}

async function main() {
  if (!token) {
    console.error("❌ CLOUDFLARE_API_TOKEN is required (Zone:Read + DNS:Edit on the zone)");
    process.exit(1);
  }

  const zones = await cf<Array<{ id: string; name: string }>>(
    `/zones?name=${encodeURIComponent(zoneName)}`,
  );
  if (zones.length === 0) {
    console.error(`❌ Zone '${zoneName}' not found for this API token`);
    process.exit(1);
  }
  const zoneId = zones[0].id;
  console.log(`Zone ${zoneName} (${zoneId})`);

  // The well-known organizational entrypoint from the DNS-AID draft. Stratum's
  // agent surface is plain HTTPS (REST + git smart-HTTP), so an HTTPS record
  // with alpn h2 is the honest advertisement; add protocol-specific labels
  // (_a2a, _mcp) only if/when such endpoints are actually hosted.
  const desired = {
    type: "HTTPS",
    name: `_index._agents.${zoneName}`,
    ttl: TTL,
    comment: RECORD_COMMENT,
    data: { priority: 1, target, value: 'alpn="h2"' },
  };

  const existing = await cf<DnsRecord[]>(
    `/zones/${zoneId}/dns_records?type=HTTPS&name=${encodeURIComponent(desired.name)}`,
  );

  const record = existing[0];
  const upToDate =
    record &&
    record.ttl === desired.ttl &&
    record.data?.priority === desired.data.priority &&
    record.data?.target === desired.data.target &&
    record.data?.value === desired.data.value;

  const rendered = `${desired.name}. ${TTL} IN HTTPS ${desired.data.priority} ${target}. ${desired.data.value}`;
  if (upToDate) {
    console.log(`✅ Record already published: ${rendered}`);
  } else if (dryRun) {
    console.log(`🔎 [dry-run] Would ${record ? "update" : "create"}: ${rendered}`);
  } else if (record) {
    await cf(`/zones/${zoneId}/dns_records/${record.id}`, {
      method: "PUT",
      body: JSON.stringify(desired),
    });
    console.log(`✅ Updated: ${rendered}`);
  } else {
    await cf(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(desired),
    });
    console.log(`✅ Created: ${rendered}`);
  }

  // DNSSEC: report, and activate only when explicitly asked — flipping signing
  // state is a zone-wide change that also needs a DS record at the registrar.
  let dnssec = await cf<{ status: string; ds?: string }>(`/zones/${zoneId}/dnssec`);
  if (dnssec.status !== "active" && enableDnssec && !dryRun) {
    dnssec = await cf<{ status: string; ds?: string }>(`/zones/${zoneId}/dnssec`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
  }

  console.log(`\nDNSSEC status: ${dnssec.status}`);
  if (dnssec.status === "active") {
    console.log("✅ Zone is signed. Verify the chain of trust:");
    console.log(`   dig @1.1.1.1 ${desired.name} HTTPS +dnssec`);
  } else if (dnssec.status === "pending") {
    console.log("⏳ Signing enabled but not yet complete. If the DS record is not at the");
    console.log("   registrar yet, add the DS shown below (automatic on Cloudflare Registrar):");
    if (dnssec.ds) console.log(`   DS: ${dnssec.ds}`);
  } else {
    console.log(
      enableDnssec && dryRun
        ? "🔎 [dry-run] Would enable DNSSEC signing for the zone."
        : "⚠️  Zone is not signed. Re-run with --enable-dnssec, then publish the DS record",
    );
    if (!(enableDnssec && dryRun)) {
      console.log("   at the registrar. See docs/runbooks/dns-aid.md.");
    }
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
