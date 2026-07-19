// scripts/finish-gaps.mjs — fast finish for Build Report, DCA v3, Incinerator gaps.
// Causal rebucket only (no double-count). Merges missing Incinerator Transfers into cache.
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
const DCA2 = "0x8d6fb6c5f77155fef58629325ad62e295329e22d"; // may differ — look up from registry
const CACHE_KEY = "ash-ledger:burns:v1";
const ATTR_KEY = "ash-ledger:attribution:v1";
const topicAddr = (a) => "0x" + a.slice(2).padStart(64, "0");

const RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
].filter(Boolean);

let rpcIndex = 0;
async function rpc(method, params, tries = RPCS.length * 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[rpcIndex % RPCS.length];
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
      rpcIndex++;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(lastErr || "rpc failed");
}

async function getLogsRange(address, topics, fromBlock, toBlock) {
  const out = [];
  let lo = fromBlock;
  let size = 50000;
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
        if (Array.isArray(logs) && logs.length >= 10000 && hi > lo) {
          hi = lo + Math.floor((hi - lo) / 2);
          size = Math.max(100, Math.floor(size / 2));
          continue;
        }
        out.push(...(logs || []));
        ok = true;
        if ((logs?.length || 0) < 500 && size < 50000) size = Math.min(50000, size * 2);
      } catch {
        if (hi <= lo) throw new Error("getLogs hard fail " + lo);
        hi = lo + Math.max(0, Math.floor((hi - lo) / 2));
        size = Math.max(100, Math.floor(size / 2));
      }
    }
    lo = hi + 1;
    if (out.length % 10 === 0 || lo > toBlock) {
      process.stdout.write(`\r  logs ${out.length} @ ${Math.min(hi, toBlock)}`);
    }
  }
  console.log("");
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

const redis = Redis.fromEnv();

const cached = await redis.get(CACHE_KEY);
const burns = cached?.burns || [];
if (!burns.length) {
  console.error("No burns");
  process.exit(1);
}
const attrMap = (await redis.get(ATTR_KEY)) || {};

const totalBefore = burns.reduce((s, b) => s + BigInt(b.amount), 0n);
const before = {
  incinerator: sumAddr(burns, INC),
  build: sumAddr(attributeBurns(burns, attrMap), BUILD_REPORT),
  dca3: sumAddr(attributeBurns(burns, attrMap), DCA_V3),
  totalBurned: Number(totalBefore) / 1e18,
};
console.log("BEFORE", JSON.stringify(before, null, 2));

const latest = parseInt(await rpc("eth_blockNumber", []), 16);

// --- A) Incinerator: scan Transfer from INC → dead/zero from first known activity ---
console.log("\n[A] Incinerator on-chain scan...");
const INC_START = 42000000; // first incinerate ~42.05M
const fromTopic = topicAddr(INC);
const incLogs = await getLogsRange(CLAWD, [TRANSFER, fromTopic, null], INC_START, latest);
const incBurns = [];
for (const l of incLogs) {
  const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
  if (to !== DEAD && to !== ZERO) continue;
  incBurns.push({
    from: INC,
    to,
    amount: l.data === "0x" ? "0x0" : l.data,
    block: parseInt(l.blockNumber, 16),
    tx: String(l.transactionHash).toLowerCase(),
  });
}
const cacheIncTx = new Set(
  burns.filter((b) => String(b.from).toLowerCase() === INC).map((b) => String(b.tx).toLowerCase())
);
const missingInc = incBurns.filter((b) => !cacheIncTx.has(b.tx));
console.log(`  on-chain incinerator burns: ${incBurns.length}, missing in cache: ${missingInc.length}`);
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
  console.log(`  merged ${missingInc.length} incinerator burns into Redis`);
}

// --- B) Build Report Burned(uint256) index ---
console.log("\n[B] Build Report Burned events...");
// SwapAndBurn likely after CLAWD; start a bit before first pool burn activity (~45M+)
// Use broader window from 42M to be safe but skip empty early token deploy range.
const burnedLogs = await getLogsRange(
  BUILD_REPORT,
  [BUILD_BURNED_TOPIC],
  42000000,
  latest
);
let burnedSet = 0;
for (const log of burnedLogs) {
  const tx = String(log.transactionHash).toLowerCase();
  if (attrMap[tx] !== BUILD_REPORT) burnedSet++;
  attrMap[tx] = BUILD_REPORT;
}
console.log(`  Burned events: ${burnedLogs.length}, map updates: ${burnedSet}`);

// Sum Burned event amounts (for sanity vs site — do NOT add to totalBurned)
let burnedEventAmt = 0n;
for (const log of burnedLogs) {
  burnedEventAmt += BigInt(log.data === "0x" ? "0x0" : log.data);
}
console.log(`  Burned(uint256) sum: ${Number(burnedEventAmt) / 1e18}`);

// --- C) Causal receipt/tx.to for burns still null (pool-first) ---
console.log("\n[C] Resolve pending causal txs (pool + causal to)...");
const burnFromByTx = new Map();
for (const b of burns) {
  const tx = b.tx && String(b.tx).toLowerCase();
  if (!tx) continue;
  const from = String(b.rawFrom || b.from || "").toLowerCase();
  if (!burnFromByTx.has(tx)) burnFromByTx.set(tx, new Set());
  burnFromByTx.get(tx).add(from);
  if (CAUSAL_SET.has(from)) attrMap[tx] = from;
}

const pending = [...new Set(burns.map((b) => b.tx && String(b.tx).toLowerCase()).filter(Boolean))]
  .filter((tx) => !attrMap[tx]); // missing or null

// Prioritize pool-sourced
pending.sort((a, b) => {
  const ap = burnFromByTx.get(a)?.has(POOL) ? 0 : 1;
  const bp = burnFromByTx.get(b)?.has(POOL) ? 0 : 1;
  return ap - bp;
});

console.log(`  pending: ${pending.length}`);
let hits = 0;
let failed = 0;
const CONCURRENCY = 10;
let cursor = 0;

async function worker() {
  while (cursor < pending.length) {
    const idx = cursor++;
    const tx = pending[idx];
    if (attrMap[tx]) continue;
    try {
      const froms = burnFromByTx.get(tx) || new Set();
      const needsReceipt = froms.has(POOL);
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
        attrMap[tx] = null;
      }
    } catch (e) {
      failed++;
      if (attrMap[tx] === null) delete attrMap[tx];
    }
    if ((idx + 1) % 200 === 0 || idx + 1 === pending.length) {
      process.stdout.write(`\r  resolved ${idx + 1}/${pending.length} hits ${hits} fail ${failed}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log("");

await redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 });

const attributed = attributeBurns(burns, attrMap);
const totalAfter = burns.reduce((s, b) => s + BigInt(b.amount), 0n);

// Find DCA v2 address from registry
let dca2Addr = null;
for (const [addr, e] of Object.entries(registry)) {
  if (/dca.*v2/i.test(e.name || "") || /dca.*v2/i.test(e.project || "")) dca2Addr = addr;
}
const after = {
  incinerator: sumAddr(burns, INC),
  build: sumAddr(attributed, BUILD_REPORT),
  dca3: sumAddr(attributed, DCA_V3),
  dca2: dca2Addr ? sumAddr(attributed, dca2Addr) : null,
  totalBurned: Number(totalAfter) / 1e18,
  burnedEventSum: Number(burnedEventAmt) / 1e18,
};
console.log("\nAFTER", JSON.stringify(after, null, 2));
console.log("totalBurned delta:", Number(totalAfter - totalBefore) / 1e18);

const result = analyze(attributed, registry);
const pick = (name) => result.sources.find((s) => (s.name || "").toLowerCase().includes(name.toLowerCase()));
console.log("\nAnalyze sources:");
for (const n of ["Incinerator", "Build Report", "DCA"]) {
  const s = result.sources.filter((x) => (x.name || x.project || "").toLowerCase().includes(n.toLowerCase()));
  for (const row of s) {
    console.log(`  ${row.name || row.project}: count=${row.count} burned=${Number(row.burned) / 1e18}`);
  }
}
console.log("DONE");
