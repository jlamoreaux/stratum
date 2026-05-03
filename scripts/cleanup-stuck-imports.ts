/**
 * Cleanup script for imports stuck in "cancelling" status
 * Run with: npx tsx scripts/cleanup-stuck-imports.ts
 */

import { getPlatformProxy } from "wrangler";

interface ImportProgress {
  status: string;
  namespace: string;
  slug: string;
  startedAt: string;
  updatedAt?: string;
}

async function cleanupStuckImports() {
  console.log("🔍 Looking for imports stuck in 'cancelling' status...\n");
  
  const { env } = await getPlatformProxy<{
    STATE: KVNamespace;
  }>({
    configPath: "./wrangler.jsonc",
  });
  
  // List all import keys
  const importPrefix = "import:";
  const listResult = await env.STATE.list({ prefix: importPrefix });
  
  let stuckCount = 0;
  
  for (const key of listResult.keys) {
    try {
      const value = await env.STATE.get(key.name);
      if (!value) continue;
      
      const progress: ImportProgress = JSON.parse(value);
      
      if (progress.status === "cancelling") {
        stuckCount++;
        const { namespace, slug } = progress;
        
        console.log(`Found stuck import: ${namespace}/${slug}`);
        console.log(`  Started: ${progress.startedAt}`);
        console.log(`  Last updated: ${progress.updatedAt || 'unknown'}`);
        
        // Update to cancelled status
        const cancelledProgress = {
          ...progress,
          status: "cancelled",
          message: "Import was cancelled (cleanup script)",
          completedAt: new Date().toISOString(),
        };
        
        await env.STATE.put(key.name, JSON.stringify(cancelledProgress), {
          expirationTtl: 86400, // 24 hours
        });
        
        console.log(`  → Updated to 'cancelled' status\n`);
      }
    } catch (err) {
      console.error(`Error processing key ${key.name}:`, err);
    }
  }
  
  if (stuckCount === 0) {
    console.log("✅ No stuck imports found!");
  } else {
    console.log(`✅ Cleaned up ${stuckCount} stuck import(s)`);
  }
  
  process.exit(0);
}

cleanupStuckImports().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
