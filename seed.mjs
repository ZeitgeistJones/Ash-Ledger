// seed.mjs — run this ONCE from your own computer to populate the cache
// pages/api/stats.js reads, so the live site never attempts the full
// ~7.5M-block historical scan inside a serverless function (which will time
// out, same issue Furnace Log hit).
//
// Usage:
//   1. npm install @upstash/redis
//   2. Create .env here with:
//        UPSTASH_REDIS_REST_URL=...
//        UPSTASH_REDIS_REST_TOKEN=...
//        RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY   (strongly recommended)
//   3. node --env-file=.env seed.mjs
//   4. Reload the live site once it prints "DONE — cache seeded."
//
// Safe to re-run any time — only scans blocks not already cached.

import { Redis } from "@upstash/redis";

const CLAWD_TOKEN = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
const DEPLOY_BLOCK = 41337394;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicFor = (a) => "0x" + a.slice(2).padStart(64, "0").toLowerCase();
const DEAD_TOPIC = topicFor("0x000000000000000000000000000000000000dead");
const ZERO_TOPIC = topicFor("0x0000000000000000000000000000000000000000");

const RPCS = [process.env.RPC_URL, "https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://1rpc.io/base"].filter(Boolean);

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("FATAL: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}
const redis = Redis.fromEnv();
const CACHE_KEY = "ash-ledger:burns:v1";

let rpcIndex = 0;
async function rpc(method, params, tries = RPCS.length * 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[rpcIndex % RPCS.length];
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!res.ok) throw new Error(url + " → http " + res.status);
      const data = await res.json();
      if (data.error) throw new Error(url + " → " + (data.error.message || "rpc error"));
      return data.result;
    } catch (e) {
      lastErr = e.message || String(e);
      rpcIndex++;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error(lastErr || "all RPCs failed");
}

function decodeBurn(log) {
  if (!log.topics || log.topics.length < 3) return null;
  const from = "0x" + log.topics[1].slice(26);
  const to = "0x" + log.topics[2].slice(26);
  return { from: from.toLowerCase(), to: to.toLowerCase(), amount: log.data === "0x" ? "0x0" : log.data, block: parseInt(log.blockNumber, 16), tx: log.transactionHash };
}

async function fetchChunk(from, to, toTopic) {
  let lo = from, hi = to, attempts = 0;
  while (attempts < 12) {
    try {
      const logs = await rpc("eth_getLogs", [{
        address: CLAWD_TOKEN,
        topics: [TRANSFER_TOPIC, null, toTopic],
        fromBlock: "0x" + lo.toString(16),
        toBlock: "0x" + hi.toString(16),
      }], 3);
      if (Array.isArray(logs) && logs.length >= 10000 && hi > lo) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const left = await fetchChunk(lo, mid, toTopic);
        const right = await fetchChunk(mid + 1, hi, toTopic);
        return left.concat(right);
      }
      return logs || [];
    } catch (e) {
      attempts++;
      if (hi - lo < 50) throw e;
      hi = lo + Math.floor((hi - lo) / 2);
    }
  }
  throw new Error("chunk " + from + "-" + to + " failed after retries");
}

async function main() {
  console.log("Reading existing cache...");
  const cached = await redis.get(CACHE_KEY);
  let burns = cached?.burns || [];
  let scannedTo = cached?.scannedTo || DEPLOY_BLOCK - 1;
  console.log(`Existing cache: ${burns.length} burns, scanned through block ${scannedTo}`);

  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  console.log(`Chain tip: block ${latest}. Need to scan ${(latest - scannedTo).toLocaleString()} blocks.`);

  if (scannedTo >= latest) {
    console.log("Already fully caught up — nothing to do.");
    return;
  }

  const CHUNK_SIZE = 2000;
  const CONCURRENCY = 6;
  const ranges = [];
  for (let f = scannedTo + 1; f <= latest; f += CHUNK_SIZE) ranges.push([f, Math.min(f + CHUNK_SIZE - 1, latest)]);

  async function scanFor(toTopic, label) {
    let completed = 0, cursor = 0;
    const results = new Array(ranges.length);
    async function worker() {
      while (cursor < ranges.length) {
        const idx = cursor++;
        const [f, t] = ranges[idx];
        results[idx] = await fetchChunk(f, t, toTopic);
        completed++;
        if (completed % 20 === 0 || completed === ranges.length) {
          process.stdout.write(`\r  [${label}] ${completed}/${ranges.length} chunks`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log("");
    return results.flat();
  }

  console.log("Scanning for dead-address burns...");
  const deadLogs = await scanFor(DEAD_TOPIC, "dead");
  console.log("Scanning for address(0) burns...");
  const zeroLogs = await scanFor(ZERO_TOPIC, "zero");

  const newBurns = [...deadLogs.map(decodeBurn), ...zeroLogs.map(decodeBurn)].filter(Boolean);
  // Dedupe by tx|from|amount|block so re-runs / overlap don't inflate totals.
  const keyOf = (b) => `${String(b.tx).toLowerCase()}|${b.from}|${b.amount}|${b.block}`;
  const seen = new Set(burns.map(keyOf));
  let added = 0;
  for (const b of newBurns) {
    const k = keyOf(b);
    if (seen.has(k)) continue;
    seen.add(k);
    burns.push(b);
    added++;
  }
  scannedTo = latest;

  console.log(`Found ${newBurns.length} new log rows, ${added} unique added. Total cached: ${burns.length}.`);
  console.log("Writing to Upstash...");
  await redis.set(CACHE_KEY, { burns, scannedTo, cachedAt: Date.now() }, { ex: 60 * 60 * 24 * 30 });
  console.log("DONE — cache seeded. The live site should now load instantly.");
}

main().catch(e => {
  console.error("\nFAILED:", e.message || e);
  console.error("Nothing was written for this run — safe to just re-run.");
  process.exit(1);
});
