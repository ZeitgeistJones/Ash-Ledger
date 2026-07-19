// attribute.mjs — backfill tx→project map for causal burns.
//
// Usage:
//   node --env-file=.env.local attribute.mjs
//
// Strategy (no double-counting — only rebuckets Transfer.from):
//   1. Index Build Report Burned(uint256) logs → those txs = Build Report
//   2. Direct Transfer.from of a causal project → that project
//   3. Retry null/missing map entries via receipt + tx.to / log emitters
//      (covers DCA v3 USDC→CLAWD→dead where Transfer.from is the pool)

import { Redis } from "@upstash/redis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  projectFromReceipt,
  CAUSAL_SET,
  needsResolution,
  BUILD_REPORT,
  BUILD_BURNED_TOPIC,
} = require("./lib/attribution.js");

// CLAWD deploy block — Burned events can't predate the token.
const DEPLOY_BLOCK = 41337394;

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

async function getLogsChunked({ address, topics, fromBlock, toBlock, chunkSize = 5000 }) {
  const out = [];
  let lo = fromBlock;
  let size = chunkSize;
  while (lo <= toBlock) {
    let hi = Math.min(lo + size - 1, toBlock);
    let ok = false;
    while (!ok) {
      try {
        const logs = await rpc("eth_getLogs", [{
          address,
          topics,
          fromBlock: "0x" + lo.toString(16),
          toBlock: "0x" + hi.toString(16),
        }]);
        // Alchemy/others cap ~10k logs — split if we hit the ceiling.
        if (Array.isArray(logs) && logs.length >= 10000 && hi > lo) {
          hi = lo + Math.floor((hi - lo) / 2);
          size = Math.max(50, Math.floor(size / 2));
          continue;
        }
        out.push(...(logs || []));
        ok = true;
        if (logs?.length < 1000 && size < chunkSize) size = Math.min(chunkSize, size * 2);
      } catch (e) {
        if (hi <= lo) throw e;
        hi = lo + Math.max(0, Math.floor((hi - lo) / 2));
        size = Math.max(50, Math.floor(size / 2));
        if (hi < lo) throw e;
      }
    }
    lo = hi + 1;
    if (lo % 200000 < size) {
      process.stdout.write(`\r  events ${out.length} through block ${hi}`);
    }
  }
  return out;
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
  console.log(`Burns: ${burns.length}. Unique txs: ${txs.length}. Map size: ${Object.keys(attrMap).length}`);

  // --- 1) Build Report Burned(uint256) index (authoritative for buybacks) ---
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  console.log("Indexing Build Report Burned(uint256) events...");
  const burnedLogs = await getLogsChunked({
    address: BUILD_REPORT,
    topics: [BUILD_BURNED_TOPIC],
    fromBlock: DEPLOY_BLOCK,
    toBlock: latest,
    chunkSize: 10000,
  });
  let burnedHits = 0;
  for (const log of burnedLogs) {
    const tx = String(log.transactionHash).toLowerCase();
    if (attrMap[tx] !== BUILD_REPORT) burnedHits++;
    attrMap[tx] = BUILD_REPORT;
  }
  console.log(`\n  Burned events: ${burnedLogs.length} (newly/re-set ${burnedHits})`);

  // --- 2) Direct Transfer.from of causal projects ---
  for (const b of burns) {
    const tx = b.tx && String(b.tx).toLowerCase();
    if (!tx) continue;
    const from = String(b.rawFrom || b.from || "").toLowerCase();
    if (CAUSAL_SET.has(from) && !attrMap[tx]) attrMap[tx] = from;
  }

  // --- 3) Retry null / missing via receipt (DCA v3 pool burns, etc.) ---
  // Fast path: tx.to in CAUSAL_SET. Full receipt for pool-sourced burns.
  const POOL = "0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3";
  const burnFromByTx = new Map();
  for (const b of burns) {
    const tx = b.tx && String(b.tx).toLowerCase();
    if (!tx) continue;
    const from = String(b.rawFrom || b.from || "").toLowerCase();
    if (!burnFromByTx.has(tx)) burnFromByTx.set(tx, new Set());
    burnFromByTx.get(tx).add(from);
  }

  const pending = txs.filter(tx => needsResolution(attrMap, tx));
  // Pool burns first — these are the DCA3 / Build Report gaps.
  pending.sort((a, b) => {
    const ap = burnFromByTx.get(a)?.has(POOL) ? 0 : 1;
    const bp = burnFromByTx.get(b)?.has(POOL) ? 0 : 1;
    return ap - bp;
  });
  console.log(`Receipt-resolving ${pending.length} pending txs (pool-first)...`);

  let resolved = 0;
  let hits = 0;
  let failed = 0;
  const CONCURRENCY = 8;
  let cursor = 0;
  let lastSave = Date.now();

  async function save() {
    await redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 });
    lastSave = Date.now();
  }

  async function worker() {
    while (cursor < pending.length) {
      const idx = cursor++;
      const tx = pending[idx];
      if (attrMap[tx]) {
        resolved++;
        hits++;
        continue;
      }
      try {
        const froms = burnFromByTx.get(tx) || new Set();
        const needsReceipt = froms.has(POOL) || [...froms].some(f => CAUSAL_SET.has(f));
        const trx = await rpc("eth_getTransactionByHash", [tx]);
        const to = trx?.to && String(trx.to).toLowerCase();
        if (to && CAUSAL_SET.has(to)) {
          attrMap[tx] = to;
          hits++;
        } else if (needsReceipt) {
          const receipt = await rpc("eth_getTransactionReceipt", [tx]);
          const project = projectFromReceipt(receipt, trx);
          attrMap[tx] = project;
          if (project) hits++;
        } else {
          // Cheap confirm: top-level to isn't causal; leave null (checked).
          attrMap[tx] = null;
        }
      } catch (e) {
        failed++;
        if (attrMap[tx] === null) delete attrMap[tx];
        if (failed <= 5) console.warn(`\n  skip ${tx}: ${e.message || e}`);
      }
      resolved++;
      if (resolved % 100 === 0 || resolved === pending.length) {
        process.stdout.write(
          `\r  resolved ${resolved}/${pending.length} (hits ${hits}, failed ${failed})`
        );
      }
      if (Date.now() - lastSave > 60_000) await save();
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log("\nWriting attribution map...");
  await save();

  // Sanity: rebucketed amounts for Build Report + DCA v3
  const { attributeBurns, DCA_V3 } = require("./lib/attribution.js");
  const attributed = attributeBurns(burns, attrMap);
  const sum = (addr) => {
    let amt = 0n;
    const tset = new Set();
    for (const b of attributed) {
      if (String(b.from).toLowerCase() !== addr) continue;
      amt += BigInt(b.amount);
      if (b.tx) tset.add(String(b.tx).toLowerCase());
    }
    return { txs: tset.size, clawd: Number(amt) / 1e18 };
  };

  let totalHits = 0;
  for (const v of Object.values(attrMap)) if (v) totalHits++;

  console.log(
    `DONE — map ${Object.keys(attrMap).length}, causal hits ${totalHits}, ` +
      `receipt new hits ${hits}, failed ${failed}`
  );
  console.log("Build Report:", sum(BUILD_REPORT));
  console.log("DCA v3:", sum(DCA_V3));
}

main().catch(e => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
