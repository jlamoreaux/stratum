import type { FC } from "hono/jsx";
import {
  type ApiTokenSummary,
  MAX_ACTIVE_TOKENS_PER_USER,
  MAX_TOKEN_EXPIRY_DAYS,
  MIN_TOKEN_EXPIRY_DAYS,
  isExpired,
} from "../../storage/api-tokens";
import type { OAuthGrantSummary } from "../../storage/oauth";
import type { ApiTokenScope } from "../../types";
import { Layout } from "../layout";

interface AgentSummary {
  id: string;
  name: string;
  model?: string;
  createdAt: string;
}

/**
 * A credential rendered exactly once, in the POST response that created it.
 * A union rather than a bag of optional fields so that, for instance, a scoped
 * token can never be displayed without the name its owner gave it.
 */
export type FreshCredential =
  | { kind: "api-key"; value: string }
  | { kind: "agent"; value: string; agentName?: string }
  | { kind: "scoped-token"; value: string; tokenName: string };

/** A one-off message about the action that just ran. */
export interface SettingsNotice {
  kind: "success" | "error";
  message: string;
}

interface SettingsPageProps {
  user: { id: string; email: string; username: string };
  agents: AgentSummary[];
  apiTokens: ApiTokenSummary[];
  /** MCP clients the user has authorized over OAuth (#349). */
  oauthGrants: OAuthGrantSummary[];
  /** True when the listing could not be READ, as opposed to being empty.
   * "No applications connected" is a reassurance, and it must not be shown to
   * someone whose connection list we simply failed to load. */
  oauthGrantsUnavailable: boolean;
  freshToken?: FreshCredential;
  notice?: SettingsNotice;
  /** Per-request CSP nonce for the copy-button script (only rendered with a fresh token). */
  nonce?: string;
  /** True when the user has opted out of product analytics (#257). */
  telemetryOptOut: boolean;
}

const SCOPE_LABEL: Record<ApiTokenScope, string> = {
  read: "Read-only",
  read_write: "Read & write",
};

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  // A timestamp we cannot parse is shown verbatim rather than as "Invalid Date":
  // the raw value is at least evidence of what is stored.
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}

/** Revoked beats expired: an explicitly revoked token stays revoked in the
 * listing even once its expiry has also passed. */
function tokenStatus(token: ApiTokenSummary, now: number): "Revoked" | "Expired" | "Active" {
  if (token.revokedAt !== undefined) return "Revoked";
  if (token.expiresAt !== undefined) {
    const expiresAt = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return "Expired";
  }
  return "Active";
}

/** Clipboard needs script; the value is read from the DOM, never re-serialized. */
const COPY_TOKEN_SCRIPT = `
(function () {
  var btn = document.getElementById('copy-fresh-token');
  var token = document.getElementById('fresh-token');
  if (!btn || !token) return;
  btn.addEventListener('click', function () {
    // Clipboard API can be missing (insecure context) or blocked by policy;
    // fall back to selecting the value so a manual Ctrl/Cmd+C still works.
    var fallback = function () {
      var range = document.createRange();
      range.selectNodeContents(token);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = 'Press Ctrl/Cmd+C';
      setTimeout(function () { btn.textContent = 'Copy'; }, 3000);
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fallback();
      return;
    }
    navigator.clipboard.writeText(token.textContent).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
    }, fallback);
  });
})();
`;

/**
 * One connected MCP client.
 *
 * `clientName` is self-asserted at registration by an anonymous caller, so it
 * is rendered as a plain string (JSX escapes it) and never as a link — and the
 * client_id is shown beside it, because that is the only part of the row the
 * user did not have to take on trust.
 */
const OAuthGrantRow: FC<{ grant: OAuthGrantSummary }> = ({ grant }) => (
  <tr>
    <td>{grant.clientName}</td>
    <td>
      <code>{grant.clientId}</code>
    </td>
    <td>{grant.scope.includes("mcp:write") ? "Read & write" : "Read-only"}</td>
    <td>{formatDate(grant.createdAt)}</td>
    <td>{grant.lastUsedAt === undefined ? "Never used" : formatDate(grant.lastUsedAt)}</td>
    <td>
      <form method="post" action={`/settings/connections/${grant.id}/revoke`}>
        <button type="submit" class="btn btn-small btn-danger">
          Disconnect
        </button>
      </form>
    </td>
  </tr>
);

const ApiTokenRow: FC<{ token: ApiTokenSummary; now: number }> = ({ token, now }) => {
  const status = tokenStatus(token, now);
  return (
    <tr>
      <td>{token.name}</td>
      <td>
        <code>{token.tokenPrefix}…</code>
      </td>
      <td>{SCOPE_LABEL[token.scope]}</td>
      <td>{token.expiresAt === undefined ? "Never" : formatDate(token.expiresAt)}</td>
      <td>{token.lastUsedAt === undefined ? "Never used" : formatDate(token.lastUsedAt)}</td>
      <td>{status}</td>
      <td>
        {status === "Revoked" ? (
          "—"
        ) : (
          <form method="post" action={`/settings/tokens/${token.id}/revoke`}>
            <button type="submit" class="btn btn-small btn-danger">
              Revoke
            </button>
          </form>
        )}
      </td>
    </tr>
  );
};

export const SettingsPage: FC<SettingsPageProps> = ({
  user,
  agents,
  apiTokens,
  oauthGrants,
  oauthGrantsUnavailable,
  freshToken,
  notice,
  nonce,
  telemetryOptOut,
}) => {
  const now = Date.now();
  // Mirrors the server-side cap in `createApiToken`: an expired row occupies no
  // slot, so showing it as active would tell a user they are full when they can
  // still create a token.
  const activeTokens = apiTokens.filter(
    (token) => token.revokedAt === undefined && !isExpired(token.expiresAt ?? null),
  ).length;
  return (
    <Layout title="Settings" user={user}>
      <div class="page-header">
        <h1>Settings</h1>
      </div>

      {notice && (
        <div class="card" style={notice.kind === "error" ? { borderColor: "#f87171" } : undefined}>
          <p
            class="settings-help"
            style={notice.kind === "error" ? { color: "#f87171" } : undefined}
          >
            {notice.message}
          </p>
        </div>
      )}

      {freshToken && (
        <div class="card settings-token-reveal">
          <h3 style={{ marginTop: 0 }}>
            {freshToken.kind === "api-key"
              ? "Your new API key"
              : freshToken.kind === "agent"
                ? `Token for agent ${freshToken.agentName ?? ""}`
                : `Token “${freshToken.tokenName}”`}
          </h3>
          <p class="settings-help">
            Copy it now — it is shown only once.{" "}
            {freshToken.kind === "api-key" ? "Your previous key no longer works." : ""}
          </p>
          <div class="token-reveal-row">
            <code class="settings-token" id="fresh-token">
              {freshToken.value}
            </code>
            <button type="button" class="btn btn-small" id="copy-fresh-token">
              Copy
            </button>
          </div>
          {nonce !== undefined && (
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: COPY_TOKEN_SCRIPT }} />
          )}
        </div>
      )}

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Account</h3>
        <dl class="detail-list">
          <dt>Username</dt>
          <dd>@{user.username}</dd>
          <dt>Email</dt>
          <dd>{user.email}</dd>
        </dl>
        <p class="settings-help">
          Your <a href="/profile">profile</a> has your account details and any invite codes you
          hold.
        </p>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Privacy</h3>
        <p class="settings-help">
          Stratum can send anonymous usage analytics. Two kinds of event are sent, and only these:
        </p>
        <ul class="settings-help">
          <li>
            One <code>api_request</code> per request, carrying the matched route pattern (e.g.{" "}
            <code>/:namespace/:slug/files</code>), the method, the status, and the latency.
          </li>
          <li>
            One event per repository activity (a change opening, a merge), carrying the event type
            and an opaque project id.
          </li>
        </ul>
        <p class="settings-help">
          Concrete URLs, namespaces, repository names, file paths, diffs, and request payloads are
          never sent. Turning this off stops future events for your account and for any agent token
          you own; it does not delete events already sent.
        </p>
        <form method="post" action="/settings/telemetry">
          <label>
            {/*
              The missing `value` is load-bearing: browsers submit a valueless
              checked box as "on", and POST /settings/telemetry accepts only
              that literal. Adding value="1" would opt every user out, because
              the route reads an unrecognized value as an opt-out (it fails
              toward privacy). The field is also the affirmative while the
              stored column is the negative, hence the inversion here.
            */}
            <input type="checkbox" name="analytics" checked={!telemetryOptOut} />
            Send anonymous usage analytics
          </label>
          <button type="submit" class="btn btn-primary">
            Save preference
          </button>
        </form>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>API tokens</h3>
        <p class="settings-help">
          Named tokens for the API, the CLI, and git over HTTPS, sent as{" "}
          <code>Authorization: Bearer stratum_user_…</code>. A read-only token can <code>GET</code>{" "}
          and <code>git clone</code>, and is refused on every write — so a leaked CI credential
          cannot push, merge, or delete. Each token can be revoked on its own without disturbing the
          others. Managing tokens requires a signed-in session; a token can never mint or revoke
          another.
        </p>
        {apiTokens.length === 0 ? (
          <p class="settings-help">
            No API tokens yet. Create one below — you will see its value only once.
          </p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Scope</th>
                <th>Expires</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {apiTokens.map((token) => (
                <ApiTokenRow key={token.id} token={token} now={now} />
              ))}
            </tbody>
          </table>
        )}
        <form method="post" action="/settings/tokens" class="settings-agent-form">
          <label>
            Token name
            <input type="text" name="name" required maxlength={100} placeholder="buildkite" />
          </label>
          <label>
            Scope
            {/* Read-only is the default: a token created without a deliberate
                choice must not be able to write. */}
            <select name="scope">
              <option value="read" selected>
                Read-only — GET/HEAD and git clone
              </option>
              <option value="read_write">Read &amp; write — everything you can do</option>
            </select>
          </label>
          <label>
            Expires in days (optional — blank never expires)
            <input
              type="number"
              name="expiresInDays"
              min={MIN_TOKEN_EXPIRY_DAYS}
              max={MAX_TOKEN_EXPIRY_DAYS}
              placeholder="90"
            />
          </label>
          <button type="submit" class="btn btn-primary">
            Create token
          </button>
        </form>
        <p class="settings-help">
          {activeTokens} of {MAX_ACTIVE_TOKENS_PER_USER} active tokens used. Revoked and expired
          tokens do not count towards the limit.
        </p>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Connected applications</h3>
        <p class="settings-help">
          Editors and agents you have authorized to reach Stratum over MCP at <code>/mcp</code>.
          Each one acts as you, within the access you granted it. Disconnecting takes effect
          immediately — the application&rsquo;s access token and its ability to refresh both stop
          working at once.
        </p>
        {oauthGrantsUnavailable ? (
          <p class="settings-help">
            Your connected applications could not be loaded, so this list is not showing them.
            Nothing has been disconnected &mdash; try again shortly.
          </p>
        ) : oauthGrants.length === 0 ? (
          <p class="settings-help">
            No applications connected. Point your editor&rsquo;s MCP client at <code>/mcp</code> on
            this instance and it will ask for access.
          </p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Client ID</th>
                <th>Access</th>
                <th>Connected</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {oauthGrants.map((grant) => (
                <OAuthGrantRow key={grant.id} grant={grant} />
              ))}
            </tbody>
          </table>
        )}
        <p class="settings-help">
          An application chooses its own display name when it registers, and nobody vets it. Treat a
          name you do not recognise as untrusted and disconnect it.
        </p>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Legacy API key</h3>
        <p class="settings-help">
          The single unnamed key every account was given before API tokens existed. It never
          expires, carries full read &amp; write access, and cannot be told apart from your other
          credentials in a log. Rotating replaces it; disabling makes it unusable for good. Your
          named API tokens above are unaffected either way.
        </p>
        <form method="post" action="/settings/rotate-token">
          <button type="submit" class="btn btn-danger">
            Rotate API key
          </button>
        </form>
        <form
          method="post"
          action="/settings/legacy-token/disable"
          style={{ marginTop: "0.75rem" }}
        >
          <button type="submit" class="btn btn-danger">
            Disable legacy API key
          </button>
        </form>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Agents</h3>
        <p class="settings-help">
          Agent tokens let automated agents fork workspaces, commit, and open changes under your
          account. Reviews remain human-only.
        </p>
        {agents.length === 0 ? (
          <p class="settings-help">No agents yet.</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Model</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td>{agent.name}</td>
                  <td>{agent.model ?? "—"}</td>
                  <td>{new Date(agent.createdAt).toLocaleDateString()}</td>
                  <td>
                    <form method="post" action={`/settings/agents/${agent.id}/delete`}>
                      <button type="submit" class="btn btn-small btn-danger">
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form method="post" action="/settings/agents" class="settings-agent-form">
          <label>
            Agent name
            <input type="text" name="name" required maxlength={100} />
          </label>
          <label>
            Model (optional)
            <input type="text" name="model" placeholder="claude-sonnet-4-6" maxlength={100} />
          </label>
          <button type="submit" class="btn btn-primary">
            Create agent token
          </button>
        </form>
      </div>

      <div class="card danger-zone">
        <h3 style={{ marginTop: 0 }}>Danger Zone</h3>
        <p class="settings-help">
          Permanently delete your account. All your projects and personal data are erased and your
          tokens stop working immediately. Contributions you left in other people's projects are
          anonymized, not deleted. This cannot be undone. Type <code>{user.username}</code> to
          confirm.
        </p>
        <form method="post" action="/api/users/me/delete">
          <input
            type="text"
            name="confirm"
            required
            autocomplete="off"
            placeholder={user.username}
          />
          <button type="submit" class="btn btn-danger">
            Delete account
          </button>
        </form>
      </div>
    </Layout>
  );
};
