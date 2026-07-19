// attribute.mjs — one-time (safe to re-run) backfill that maps burn txs to the
// project that caused them (Creature Feature, Build Report, DCA v3, …).
//
// Usage:
//   node --env-file=.env.local attribute.mjs
//
// Writes ash-ledger:attribution:v1 = { [txHash]: projectAddr | null }
// Does NOT change burn totals — only source attribution used at read time.

import { Redis } from "@upstash/redis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { projectFromReceipt, CAUSAL_SET } = require("./lib/attribution.js");

const RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
].filter(Boolean);

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("FATAL: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}

const redis = Redis.fromEnv();
const CACHE_KEY = "ash-ledger:burns:v1";
const ATTR_KEY = "ash-ledger:attribution:v1";

let rpcIndex = 0;
async function rpc(method, params, tries = RPCS.length * 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[rpcIndex % RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error(url + " → http " + res.status);
      const data = await res.json();
      if (data.error) throw new Error(url + " → " + (data.error.message || "rpc error"));
      return data.result;
    } catch (e) {
      lastErr = e.message || String(e);
      rpcIndex++;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error(lastErr || "all RPCs failed");
}

async function main() {
  const cached = await redis.get(CACHE_KEY);
  const burns = cached?.burns || [];
  if (!burns.length) {
    console.error("No burns in cache — run seed.mjs first.");
    process.exit(1);
  }

  const attrMap = (await redis.get(ATTR_KEY)) || {};
  const txs = [...new Set(burns.map(b => b.tx && String(b.tx).toLowerCase()).filter(Boolean))];
  console.log(`Burns: ${burns.length}. Unique txs: ${txs.length}. Already mapped: ${Object.keys(attrMap).length}`);

  let resolved = 0;
  let hits = 0;
  const CONCURRENCY = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < txs.length) {
      const idx = cursor++;
      const tx = txs[idx];
      if (Object.prototype.hasOwnProperty.call(attrMap, tx)) {
        if (attrMap[tx]) hits++;
        resolved++;
        continue;
      }
      try {
        const receipt = await rpc("eth_getTransactionReceipt", [tx]);
        const project = projectFromReceipt(receipt);
        // Also treat direct Transfer.from of a causal project as that project
        // when receipt lookup finds nothing else (already covered by from).
        attrMap[tx] = project;
        if (project) hits++;
      } catch (e) {
        console.warn(`  skip ${tx}: ${e.message || e}`);
      }
      resolved++;
      if (resolved % 50 === 0 || resolved === txs.length) {
        process.stdout.write(`\r  resolved ${resolved}/${txs.length} (causal hits ${hits})`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log("\nWriting attribution map...");
  await redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 });

  // Quick local sanity: how many burns would rebucket
  let moved = 0;
  for (const b of burns) {
    const tx = b.tx && String(b.tx).toLowerCase();
    const mapped = tx && attrMap[tx];
    if (mapped && mapped !== String(b.from).toLowerCase()) moved++;
  }
  console.log(`DONE — ${Object.keys(attrMap).length} txs mapped, ${hits} causal projects, ${moved} burns would rebucket.`);
}

main().catch(e => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
