// Repair Incinerator burns in Redis to match LIVE contract counters, then export.
// Success criteria = eth_call totalCalls()/totalBurned() — never hardcoded counts.
// Uses public Base RPCs with adaptive chunking to avoid silent eth_getLogs truncation.
import { Redis } from "@upstash/redis";
import fs from "fs";
import path from "path";

const INC = "0x536453350f2eee2eb8bfee1866baf4fca494a092";
const CLAWD = "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const START_BLOCK = 42039453;
const CACHE_KEY = "ash-ledger:burns:v1";
const OUT = "C:\\dev\\clawd-incinerator-seed\\incinerator-burns.json";
const TOTAL_CALLS_SEL = "0x3af3f24f";
const TOTAL_BURNED_SEL = "0xd89135cd";
const MAX_CHUNK = 2000;
const MIN_CHUNK = 50;
const TRUNCATION_WARN = 800; // many public RPCs silently cap well below 10k

const topicAddr = (a) => "0x" + a.slice(2).padStart(64, "0").toLowerCase();
const FROM_TOPIC = topicAddr(INC);

const LOG_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];
const CALL_RPCS = [process.env.RPC_URL, ...LOG_RPCS].filter(Boolean);

let logI = 0;
let callI = 0;

async function rpcOn(urls, stateKey, method, params, tries = urls.length * 6) {
  let lastErr;
  let idx = stateKey === "log" ? logI : callI;
  for (let i = 0; i < tries; i++) {
    const url = urls[idx % urls.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "rpc error");
      if (stateKey === "log") logI = idx;
      else callI = idx;
      return data.result;
    } catch (e) {
      clearTimeout(timeout);
      lastErr = e.name === "AbortError" ? "timeout" : (e.message || String(e));
      idx++;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (stateKey === "log") logI = idx;
  else callI = idx;
  throw new Error(lastErr || "rpc failed");
}

const rpcLogs = (m, p) => rpcOn(LOG_RPCS, "log", m, p);
const rpcCall = (m, p) => rpcOn(CALL_RPCS, "call", m, p);

async function ethCall(data) {
  return rpcCall("eth_call", [{ to: INC, data }, "latest"]);
}

function isIncineratorBurn(b) {
  const from = String(b.from || "").toLowerCase();
  const raw = String(b.rawFrom || "").toLowerCase();
  return from === INC || raw === INC;
}

function decode(log) {
  const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
  const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
  if (to !== DEAD && to !== ZERO) return null;
  if (from !== INC) return null;
  return {
    from: INC,
    rawFrom: INC,
    to,
    amount: log.data === "0x" ? "0x0" : log.data,
    block: parseInt(log.blockNumber, 16),
    tx: String(log.transactionHash).toLowerCase(),
  };
}

async function getLogsAdaptive(lo, hi) {
  if (hi < lo) return [];
  const logs = await rpcLogs("eth_getLogs", [{
    address: CLAWD,
    topics: [TRANSFER, FROM_TOPIC, null],
    fromBlock: "0x" + lo.toString(16),
    toBlock: "0x" + hi.toString(16),
  }]);
  const arr = logs || [];
  // Silent truncation guard: split whenever result looks capped.
  if (arr.length >= TRUNCATION_WARN && hi > lo) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const left = await getLogsAdaptive(lo, mid);
    const right = await getLogsAdaptive(mid + 1, hi);
    return left.concat(right);
  }
  return arr;
}

/** Serial adaptive scan — preferred for tip/gap catch-up (avoids parallel truncation). */
async function scanSerial(fromBlock, toBlock) {
  const found = [];
  let lo = fromBlock;
  let size = MAX_CHUNK;
  while (lo <= toBlock) {
    let hi = Math.min(lo + size - 1, toBlock);
    let ok = false;
    while (!ok) {
      try {
        const logs = await getLogsAdaptive(lo, hi);
        for (const l of logs) {
          const b = decode(l);
          if (b) found.push(b);
        }
        ok = true;
        if (logs.length < 20 && size < MAX_CHUNK) size = Math.min(MAX_CHUNK, size * 2);
      } catch (e) {
        if (hi <= lo) throw new Error("getLogs hard fail at " + lo + ": " + (e.message || e));
        hi = lo + Math.max(0, Math.floor((hi - lo) / 2));
        size = Math.max(MIN_CHUNK, Math.floor(size / 2));
      }
    }
    lo = hi + 1;
    if (lo % (MAX_CHUNK * 20) < size || lo > toBlock) {
      process.stdout.write(`\r  serial ${Math.min(lo - 1, toBlock)}/${toBlock} found ${found.length}   `);
    }
  }
  console.log("");
  // Dedupe by tx
  const map = new Map(found.map((b) => [b.tx, b]));
  return [...map.values()];
}

function summarizeIncinerator(burns) {
  const byTx = new Map();
  for (const b of burns) {
    if (!isIncineratorBurn(b)) continue;
    const tx = String(b.tx).toLowerCase();
    if (!byTx.has(tx)) byTx.set(tx, b);
  }
  let sum = 0n;
  let lastBlock = 0;
  for (const b of byTx.values()) {
    sum += BigInt(b.amount);
    if (b.block > lastBlock) lastBlock = b.block;
  }
  return {
    count: byTx.size,
    sum,
    lastBlock,
    rows: [...byTx.values()].sort((a, b) => a.block - b.block),
  };
}

function mergeOnchain(byTx, onchain) {
  let merged = 0;
  for (const b of onchain) {
    const existing = byTx.get(b.tx);
    if (!existing) {
      byTx.set(b.tx, b);
      merged++;
      continue;
    }
    const from = String(existing.from || "").toLowerCase();
    const raw = String(existing.rawFrom || "").toLowerCase();
    if (from !== INC && raw !== INC) {
      byTx.set(b.tx, { ...existing, rawFrom: INC, amount: b.amount, block: b.block, to: b.to });
      merged++;
    } else {
      byTx.set(b.tx, {
        ...existing,
        rawFrom: existing.rawFrom || INC,
        amount: existing.amount || b.amount,
        block: existing.block || b.block,
        to: existing.to || b.to,
      });
    }
  }
  return merged;
}

const redis = Redis.fromEnv();

console.log("=== 1) Live Incinerator counters (eth_call) ===");
const callsHex = await ethCall(TOTAL_CALLS_SEL);
const burnedHex = await ethCall(TOTAL_BURNED_SEL);
let targetCalls = BigInt(callsHex);
let targetBurned = BigInt(burnedHex);
console.log("totalCalls():", targetCalls.toString());
console.log("totalBurned():", targetBurned.toString(), `(${Number(targetBurned) / 1e18} CLAWD)`);

const latest = parseInt(await rpcCall("eth_blockNumber", []), 16);
console.log("chain tip:", latest);

const cached = (await redis.get(CACHE_KEY)) || { burns: [], scannedTo: START_BLOCK - 1 };
if (!Array.isArray(cached.burns)) cached.burns = [];

const byTx = new Map();
for (const b of cached.burns) {
  const tx = String(b.tx || "").toLowerCase();
  if (tx) byTx.set(tx, b);
}

let summary = summarizeIncinerator(cached.burns);
console.log("Redis incinerator before:", summary.count, "sum:", summary.sum.toString(), "lastBlock:", summary.lastBlock);

const shortCalls = targetCalls - BigInt(summary.count);
const shortBurned = targetBurned - summary.sum;
console.log("delta vs LIVE:", shortCalls.toString(), "calls,", shortBurned.toString(), "wei");

let onchain = [];

// Prefer tip/gap after last known burn — catches new ~8h burns without full history.
const tipFrom = Math.max(START_BLOCK, (summary.lastBlock || START_BLOCK) + 1);
if (tipFrom <= latest) {
  console.log(`\n=== 2a) Tip/gap scan ${tipFrom} → ${latest} (adaptive, public RPCs) ===`);
  const tipFound = await scanSerial(tipFrom, latest);
  console.log("tip/gap found:", tipFound.length);
  onchain = tipFound;
  mergeOnchain(byTx, tipFound);
  cached.burns = [...byTx.values()];
  summary = summarizeIncinerator(cached.burns);
}

// If still short of LIVE counters, full adaptive history scan (small chunks).
if (BigInt(summary.count) < targetCalls || summary.sum < targetBurned) {
  console.log(`\n=== 2b) Full adaptive history scan ${START_BLOCK} → ${latest} ===`);
  console.log(`Redis still short of LIVE (have ${summary.count}/${targetCalls.toString()})`);
  const full = await scanSerial(START_BLOCK, latest);
  console.log("full scan found:", full.length);
  onchain = full;
  mergeOnchain(byTx, full);
  cached.burns = [...byTx.values()];
  summary = summarizeIncinerator(cached.burns);
} else if (onchain.length === 0) {
  console.log("\n=== 2) No tip gap and Redis already matches LIVE — skip full rescan ===");
}

cached.burns = [...byTx.values()];
cached.cachedAt = Date.now();
await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
console.log("cache rows:", cached.burns.length);

// Refresh LIVE after scan (a burn may land mid-run).
const callsHex2 = await ethCall(TOTAL_CALLS_SEL);
const burnedHex2 = await ethCall(TOTAL_BURNED_SEL);
targetCalls = BigInt(callsHex2);
targetBurned = BigInt(burnedHex2);
console.log("\n=== 3) Re-check LIVE counters ===");
console.log("totalCalls():", targetCalls.toString());
console.log("totalBurned():", targetBurned.toString(), `(${Number(targetBurned) / 1e18} CLAWD)`);

console.log("\n=== 4) Verify Redis vs LIVE ===");
summary = summarizeIncinerator(cached.burns);
console.log("redis incinerator count:", summary.count, "sum:", summary.sum.toString());

if (BigInt(summary.count) !== targetCalls || summary.sum !== targetBurned) {
  // Rebuild identity on any onchain rows we found, then re-check.
  if (onchain.length) {
    console.log("Rebuilding incinerator identity on scanned txs...");
    for (const b of onchain) {
      const prev = byTx.get(b.tx);
      byTx.set(b.tx, {
        ...(prev || {}),
        ...b,
        from: prev?.from && String(prev.from).toLowerCase() !== INC ? prev.from : INC,
        rawFrom: INC,
      });
    }
    cached.burns = [...byTx.values()];
    cached.cachedAt = Date.now();
    await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
    summary = summarizeIncinerator(cached.burns);
    console.log("after rebuild — count:", summary.count, "sum:", summary.sum.toString());
  }
}

if (BigInt(summary.count) !== targetCalls || summary.sum !== targetBurned) {
  console.error("UNRESOLVED: Redis still does not match LIVE contract counters.");
  console.error("  redis:", summary.count, summary.sum.toString());
  console.error("  chain:", targetCalls.toString(), targetBurned.toString());
  process.exit(2);
}

console.log("VERIFY OK — Redis matches LIVE totalCalls/totalBurned");

console.log("\n=== 5) Export ===");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const exportRows = summary.rows.map((b) => ({
  tx: String(b.tx).toLowerCase(),
  block: b.block,
  from: String(b.from || INC).toLowerCase(),
  rawFrom: String(b.rawFrom || b.from || INC).toLowerCase(),
  to: String(b.to).toLowerCase(),
  amountRaw: BigInt(b.amount).toString(),
}));
fs.writeFileSync(OUT, JSON.stringify(exportRows, null, 2));
const exportSum = exportRows.reduce((s, r) => s + BigInt(r.amountRaw), 0n);
console.log("wrote", OUT);
console.log("export rows:", exportRows.length, "sum:", exportSum.toString(), `(${Number(exportSum) / 1e18} CLAWD)`);
if (BigInt(exportRows.length) !== targetCalls || exportSum !== targetBurned) {
  console.error("Export mismatch vs LIVE");
  console.error("  export:", exportRows.length, exportSum.toString());
  console.error("  chain:", targetCalls.toString(), targetBurned.toString());
  process.exit(3);
}
console.log("EXPORT OK — matches LIVE eth_call counters");
