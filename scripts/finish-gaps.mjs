// scripts/finish-gaps.mjs — targeted repair: Incinerator gap fills + Burned/DCA attribution
import { Redis } from "@upstash/redis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  attributeBurns,
  projectFromReceipt,
  BUILD_REPORT,
  DCA_V3,
  BUILD_BURNED_TOPIC,
  CAUSAL_SET,
} = require("../lib/attribution.js");
const { analyze } = require("../lib/ash-ledger.js");
const registry = require("../lib/registry.js");

const INC = "0x536453350f2eee2eb8bfee1866baf4fca494a092";
const POOL = "0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3";
const CLAWD = "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DCA2 = "0xa16095e72936ad6dab012ec1b95222f6fcb5f5c2";
const CACHE_KEY = "ash-ledger:burns:v1";
const ATTR_KEY = "ash-ledger:attribution:v1";
const INTERVAL = 28800; // incinerator cadence (storage slot 3)
const topicAddr = (a) => "0x" + a.slice(2).padStart(64, "0");

const LOG_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
].filter(Boolean);
const TX_RPCS = [process.env.RPC_URL, "https://mainnet.base.org", "https://base-rpc.publicnode.com"].filter(Boolean);

async function rpcOn(urls, method, params, state) {
  let lastErr;
  for (let i = 0; i < urls.length * 4; i++) {
    const url = urls[state.i % urls.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "rpc error");
      return data.result;
    } catch (e) {
      lastErr = e.message || String(e);
      state.i++;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  throw new Error(lastErr || "rpc failed");
}
const logState = { i: 0 };
const txState = { i: 0 };
const rpcLogs = (m, p) => rpcOn(LOG_RPCS, m, p, logState);
const rpcTx = (m, p) => rpcOn(TX_RPCS, m, p, txState);

async function getLogsRange(address, topics, fromBlock, toBlock) {
  const out = [];
  let lo = fromBlock;
  let size = 20000;
  while (lo <= toBlock) {
    let hi = Math.min(lo + size - 1, toBlock);
    let ok = false;
    while (!ok) {
      try {
        const logs = await rpcLogs("eth_getLogs", [{
          address,
          topics,
          fromBlock: "0x" + lo.toString(16),
          toBlock: "0x" + hi.toString(16),
        }]);
        if (Array.isArray(logs) && logs.length >= 10000 && hi > lo) {
          hi = lo + Math.floor((hi - lo) / 2);
          size = Math.max(500, Math.floor(size / 2));
          continue;
        }
        out.push(...(logs || []));
        ok = true;
        if ((logs?.length || 0) < 100 && size < 20000) size = Math.min(20000, size * 2);
      } catch {
        if (hi <= lo) throw new Error("getLogs hard fail " + lo);
        hi = lo + Math.max(0, Math.floor((hi - lo) / 2));
        size = Math.max(500, Math.floor(size / 2));
      }
    }
    lo = hi + 1;
  }
  return out;
}

function burnKey(b) {
  return `${String(b.tx).toLowerCase()}|${String(b.from).toLowerCase()}|${b.amount}|${b.block}`;
}

function sumAddr(burns, addr) {
  let amt = 0n;
  const txs = new Set();
  for (const b of burns) {
    if (String(b.from).toLowerCase() !== addr) continue;
    amt += BigInt(b.amount);
    if (b.tx) txs.add(String(b.tx).toLowerCase());
  }
  return { txs: txs.size, clawd: Number(amt) / 1e18 };
}

function decodeInc(log) {
  const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
  if (to !== DEAD && to !== ZERO) return null;
  return {
    from: INC,
    to,
    amount: log.data === "0x" ? "0x0" : log.data,
    block: parseInt(log.blockNumber, 16),
    tx: String(log.transactionHash).toLowerCase(),
  };
}

const redis = Redis.fromEnv();
const cached = await redis.get(CACHE_KEY);
const burns = cached?.burns || [];
const attrMap = (await redis.get(ATTR_KEY)) || {};
if (!burns.length) {
  console.error("No burns");
  process.exit(1);
}

const totalBefore = burns.reduce((s, b) => s + BigInt(b.amount), 0n);
const before = {
  incinerator: sumAddr(burns, INC),
  build: sumAddr(attributeBurns(burns, attrMap), BUILD_REPORT),
  dca3: sumAddr(attributeBurns(burns, attrMap), DCA_V3),
  dca2: sumAddr(attributeBurns(burns, attrMap), DCA2),
  totalBurned: Number(totalBefore) / 1e18,
};
console.log("BEFORE", JSON.stringify(before, null, 2));

// Confirm on-chain incinerator counters from storage
const slot5 = BigInt(await rpcTx("eth_getStorageAt", [INC, "0x" + "5".padStart(64, "0"), "latest"]));
const slot6 = BigInt(await rpcTx("eth_getStorageAt", [INC, "0x" + "6".padStart(64, "0"), "latest"]));
console.log(`On-chain Incinerator storage: burns=${slot6} totalCLAWD=${Number(slot5) / 1e18}`);

const latest = parseInt(await rpcTx("eth_blockNumber", []), 16);
const fromTopic = topicAddr(INC);

// --- A) Scan only sparse gaps between known incinerator burns ---
console.log("\n[A] Incinerator gap fill...");
const knownBlocks = burns
  .filter((b) => String(b.from).toLowerCase() === INC)
  .map((b) => b.block)
  .sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < knownBlocks.length; i++) {
  const delta = knownBlocks[i] - knownBlocks[i - 1];
  // Skip the long inactive pause (~4.5M blocks); scan medium gaps that can hide burns
  if (delta > INTERVAL * 1.4 && delta < INTERVAL * 50) {
    gaps.push([knownBlocks[i - 1] + 1, knownBlocks[i] - 1]);
  }
}
// Also tip after last known
if (knownBlocks.length) gaps.push([knownBlocks[knownBlocks.length - 1] + 1, latest]);
// And early window before first (small)
if (knownBlocks[0] > 42050000) gaps.push([42050000, knownBlocks[0] - 1]);

console.log(`  scanning ${gaps.length} gap ranges...`);
const found = [];
for (const [a, b] of gaps) {
  if (b < a) continue;
  const logs = await getLogsRange(CLAWD, [TRANSFER, fromTopic, null], a, b);
  for (const l of logs) {
    const burn = decodeInc(l);
    if (burn) found.push(burn);
  }
  process.stdout.write(`\r  gap ${a}-${b}: found so far ${found.length}`);
}
console.log("");

const cacheIncTx = new Set(
  burns.filter((b) => String(b.from).toLowerCase() === INC).map((b) => String(b.tx).toLowerCase())
);
const missingInc = found.filter((b) => !cacheIncTx.has(b.tx));
console.log(`  found in gaps: ${found.length}, new to cache: ${missingInc.length}`);

// If still short of 156, do a full scan from first→last (public RPC, 20k chunks)
let stillNeed = Number(slot6) - (cacheIncTx.size + missingInc.length);
if (stillNeed > 0) {
  console.log(`  still short ${stillNeed} — full INC scan ${knownBlocks[0]}→${latest}`);
  const allLogs = await getLogsRange(CLAWD, [TRANSFER, fromTopic, null], knownBlocks[0], latest);
  for (const l of allLogs) {
    const burn = decodeInc(l);
    if (burn && !cacheIncTx.has(burn.tx) && !missingInc.some((m) => m.tx === burn.tx)) {
      missingInc.push(burn);
    }
  }
  console.log(`  after full scan, new to cache: ${missingInc.length}`);
}

if (missingInc.length) {
  const keys = new Set(burns.map(burnKey));
  for (const b of missingInc) {
    const k = burnKey(b);
    if (keys.has(k)) continue;
    burns.push(b);
    keys.add(k);
  }
  cached.burns = burns;
  cached.cachedAt = Date.now();
  await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
  console.log(`  merged ${missingInc.length} incinerator burns`);
}

// --- B) Build Report Burned events ---
console.log("\n[B] Build Report Burned(uint256)...");
const burnedLogs = await getLogsRange(BUILD_REPORT, [BUILD_BURNED_TOPIC], 43000000, latest);
let burnedEventAmt = 0n;
for (const log of burnedLogs) {
  const tx = String(log.transactionHash).toLowerCase();
  attrMap[tx] = BUILD_REPORT;
  burnedEventAmt += BigInt(log.data === "0x" ? "0x0" : log.data);
}
console.log(`  events=${burnedLogs.length} sum=${Number(burnedEventAmt) / 1e18}`);

// --- C) DCA3: any log from contract → attribute burns in those txs ---
console.log("\n[C] DCA v3 contract logs...");
const dcaLogs = await getLogsRange(DCA_V3, null, 43000000, latest);
const dcaTxs = new Set(dcaLogs.map((l) => String(l.transactionHash).toLowerCase()));
let dcaHits = 0;
for (const b of burns) {
  const tx = String(b.tx).toLowerCase();
  if (dcaTxs.has(tx)) {
    if (attrMap[tx] !== BUILD_REPORT) {
      attrMap[tx] = DCA_V3;
      dcaHits++;
    }
  }
}
console.log(`  DCA3 logs=${dcaLogs.length} uniqueTxs=${dcaTxs.size} burn-txs mapped=${dcaHits}`);

// --- D) Pool / causal receipt backfill for remaining nulls ---
console.log("\n[D] Pool + tx.to causal resolve...");
for (const b of burns) {
  const tx = b.tx && String(b.tx).toLowerCase();
  const from = String(b.rawFrom || b.from || "").toLowerCase();
  if (tx && CAUSAL_SET.has(from)) attrMap[tx] = from;
}

const burnFromByTx = new Map();
for (const b of burns) {
  const tx = b.tx && String(b.tx).toLowerCase();
  if (!tx) continue;
  if (!burnFromByTx.has(tx)) burnFromByTx.set(tx, new Set());
  burnFromByTx.get(tx).add(String(b.rawFrom || b.from || "").toLowerCase());
}

const pending = [...new Set(burns.map((b) => b.tx && String(b.tx).toLowerCase()).filter(Boolean))]
  .filter((tx) => attrMap[tx] == null);
pending.sort((a, b) => {
  const ap = burnFromByTx.get(a)?.has(POOL) ? 0 : 1;
  const bp = burnFromByTx.get(b)?.has(POOL) ? 0 : 1;
  return ap - bp;
});

let hits = 0;
let failed = 0;
let cursor = 0;
const CONCURRENCY = 12;
async function worker() {
  while (cursor < pending.length) {
    const idx = cursor++;
    const tx = pending[idx];
    if (attrMap[tx]) continue;
    try {
      const froms = burnFromByTx.get(tx) || new Set();
      const trx = await rpcTx("eth_getTransactionByHash", [tx]);
      const to = trx?.to && String(trx.to).toLowerCase();
      if (to && CAUSAL_SET.has(to)) {
        attrMap[tx] = to;
        hits++;
      } else if (froms.has(POOL)) {
        const receipt = await rpcTx("eth_getTransactionReceipt", [tx]);
        const project = projectFromReceipt(receipt, trx);
        attrMap[tx] = project;
        if (project) hits++;
      } else {
        attrMap[tx] = null;
      }
    } catch {
      failed++;
      if (attrMap[tx] === null) delete attrMap[tx];
    }
    if ((idx + 1) % 300 === 0 || idx + 1 === pending.length) {
      process.stdout.write(`\r  resolved ${idx + 1}/${pending.length} hits ${hits} fail ${failed}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log("");

await redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 });
if (missingInc.length) {
  cached.burns = burns;
  await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
}

const attributed = attributeBurns(burns, attrMap);
const totalAfter = burns.reduce((s, b) => s + BigInt(b.amount), 0n);
const after = {
  incinerator: sumAddr(burns, INC),
  build: sumAddr(attributed, BUILD_REPORT),
  dca3: sumAddr(attributed, DCA_V3),
  dca2: sumAddr(attributed, DCA2),
  totalBurned: Number(totalAfter) / 1e18,
  burnedEventSum: Number(burnedEventAmt) / 1e18,
  onchainIncBurns: Number(slot6),
  onchainIncClawd: Number(slot5) / 1e18,
};
console.log("\nAFTER", JSON.stringify(after, null, 2));
console.log("totalBurned delta:", Number(totalAfter - totalBefore) / 1e18);

const result = analyze(attributed, registry);
console.log("\nAnalyze:");
for (const row of result.sources) {
  const label = `${row.name || ""} ${row.project || ""}`.toLowerCase();
  if (/incinerator|build report|dca/.test(label)) {
    console.log(`  ${row.name}: txs=${row.count} clawd=${Number(row.burned) / 1e18}`);
  }
}
console.log("DONE");
