// Repair Incinerator burns in Redis to match live contract counters, then export.
// Uses public Base RPCs (not Alchemy free 10-block cap) with parallel chunks.
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
const CONCURRENCY = 12;
const CHUNK = 20000;

const topicAddr = (a) => "0x" + a.slice(2).padStart(64, "0").toLowerCase();
const FROM_TOPIC = topicAddr(INC);

// Prefer public RPCs for eth_getLogs — Alchemy free tier is 10-block and too slow.
const LOG_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];
const CALL_RPCS = [process.env.RPC_URL, ...LOG_RPCS].filter(Boolean);

let logI = 0;
let callI = 0;

async function rpcOn(urls, stateKey, method, params, tries = urls.length * 5) {
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
      await new Promise((r) => setTimeout(r, 80));
    }
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

async function getLogsRange(lo, hi) {
  let a = lo;
  let b = hi;
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      const logs = await rpcLogs("eth_getLogs", [{
        address: CLAWD,
        topics: [TRANSFER, FROM_TOPIC, null],
        fromBlock: "0x" + a.toString(16),
        toBlock: "0x" + b.toString(16),
      }]);
      if (Array.isArray(logs) && logs.length >= 10000 && b > a) {
        const mid = a + Math.floor((b - a) / 2);
        const left = await getLogsRange(a, mid);
        const right = await getLogsRange(mid + 1, b);
        return left.concat(right);
      }
      return logs || [];
    } catch (e) {
      if (b <= a) throw e;
      b = a + Math.max(0, Math.floor((b - a) / 2));
      if (b < a) throw e;
    }
  }
  throw new Error("getLogs failed " + lo + "-" + hi);
}

async function scanAll(fromBlock, toBlock) {
  const ranges = [];
  for (let f = fromBlock; f <= toBlock; f += CHUNK) {
    ranges.push([f, Math.min(f + CHUNK - 1, toBlock)]);
  }
  const found = [];
  let cursor = 0;
  let done = 0;
  let hardFail = 0;
  const errors = [];

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= ranges.length) return;
      const [lo, hi] = ranges[idx];
      try {
        const logs = await getLogsRange(lo, hi);
        for (const l of logs) {
          const b = decode(l);
          if (b) found.push(b);
        }
      } catch (e) {
        hardFail++;
        if (errors.length < 5) errors.push(`${e.message || e} [${lo}-${hi}]`);
      }
      done++;
      if (done % 10 === 0 || done === ranges.length) {
        process.stdout.write(`\r  chunks ${done}/${ranges.length} found ${found.length} fail ${hardFail}   `);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, () => worker()));
  console.log("");
  if (hardFail > 0) {
    // Retry failed ranges serially with smaller adaptive splits
    console.log(`retrying ${hardFail} failed chunk groups via smaller windows...`);
    // Re-scan entire range serially with adaptive size — only if we are short later
  }
  return { found, hardFail, errors, rangeCount: ranges.length };
}

function summarizeIncinerator(burns) {
  const byTx = new Map();
  for (const b of burns) {
    if (!isIncineratorBurn(b)) continue;
    const tx = String(b.tx).toLowerCase();
    if (!byTx.has(tx)) byTx.set(tx, b);
  }
  let sum = 0n;
  for (const b of byTx.values()) sum += BigInt(b.amount);
  return { count: byTx.size, sum, rows: [...byTx.values()].sort((a, b) => a.block - b.block) };
}

const redis = Redis.fromEnv();

console.log("=== 1) Live Incinerator counters ===");
const callsHex = await ethCall(TOTAL_CALLS_SEL);
const burnedHex = await ethCall(TOTAL_BURNED_SEL);
const targetCalls = BigInt(callsHex);
const targetBurned = BigInt(burnedHex);
console.log("totalCalls():", targetCalls.toString());
console.log("totalBurned():", targetBurned.toString(), `(${Number(targetBurned) / 1e18} CLAWD)`);

const latest = parseInt(await rpcCall("eth_blockNumber", []), 16);
console.log("chain tip:", latest, "scan from:", START_BLOCK);

console.log("\n=== 2) Targeted parallel getLogs repair (public RPCs) ===");
let { found: onchain, hardFail } = await scanAll(START_BLOCK, latest);

// If parallel pass missed some (hard fails), do a careful serial full pass
if (hardFail > 0 || BigInt(onchain.length) !== targetCalls) {
  console.log(`parallel found ${onchain.length} (hardFail=${hardFail}); running serial adaptive full scan...`);
  const serial = [];
  let lo = START_BLOCK;
  let size = CHUNK;
  while (lo <= latest) {
    let hi = Math.min(lo + size - 1, latest);
    let ok = false;
    while (!ok) {
      try {
        const logs = await rpcLogs("eth_getLogs", [{
          address: CLAWD,
          topics: [TRANSFER, FROM_TOPIC, null],
          fromBlock: "0x" + lo.toString(16),
          toBlock: "0x" + hi.toString(16),
        }]);
        if (Array.isArray(logs) && logs.length >= 10000 && hi > lo) {
          hi = lo + Math.floor((hi - lo) / 2);
          size = Math.max(500, Math.floor(size / 2));
          continue;
        }
        for (const l of logs || []) {
          const b = decode(l);
          if (b) serial.push(b);
        }
        ok = true;
        if ((logs?.length || 0) < 50 && size < CHUNK) size = Math.min(CHUNK, size * 2);
      } catch {
        if (hi <= lo) throw new Error("serial getLogs hard fail at " + lo);
        hi = lo + Math.max(0, Math.floor((hi - lo) / 2));
        size = Math.max(500, Math.floor(size / 2));
      }
    }
    lo = hi + 1;
    if (lo % 100000 < size || lo > latest) {
      process.stdout.write(`\r  serial ${Math.min(lo - 1, latest)}/${latest} found ${serial.length}   `);
    }
  }
  console.log("");
  // Merge by tx
  const map = new Map(onchain.map((b) => [b.tx, b]));
  for (const b of serial) map.set(b.tx, b);
  onchain = [...map.values()];
}

const onchainSum = onchain.reduce((s, b) => s + BigInt(b.amount), 0n);
console.log("on-chain Transfer→dead/zero from Incinerator:", onchain.length, "sum", onchainSum.toString());

if (BigInt(onchain.length) !== targetCalls || onchainSum !== targetBurned) {
  console.error("UNRESOLVED: log scan does not match contract counters");
  console.error("  logs:", onchain.length, onchainSum.toString());
  console.error("  chain:", targetCalls.toString(), targetBurned.toString());
  process.exit(2);
}

const cached = (await redis.get(CACHE_KEY)) || { burns: [], scannedTo: START_BLOCK - 1 };
if (!Array.isArray(cached.burns)) cached.burns = [];

const byTx = new Map();
for (const b of cached.burns) {
  const tx = String(b.tx || "").toLowerCase();
  if (tx) byTx.set(tx, b);
}

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
    });
  }
}

cached.burns = [...byTx.values()];
cached.cachedAt = Date.now();
await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
console.log("merged/repaired rows:", merged, "total burns in cache:", cached.burns.length);

console.log("\n=== 4) Verify Redis vs live counters ===");
let summary = summarizeIncinerator(cached.burns);
console.log("redis incinerator count:", summary.count, "sum:", summary.sum.toString());

if (BigInt(summary.count) !== targetCalls || summary.sum !== targetBurned) {
  console.log("Rebuilding incinerator identity on matching txs...");
  const byTx2 = new Map(cached.burns.map((b) => [String(b.tx).toLowerCase(), b]));
  for (const b of onchain) {
    const prev = byTx2.get(b.tx);
    byTx2.set(b.tx, {
      ...(prev || {}),
      ...b,
      from: prev?.from && String(prev.from).toLowerCase() !== INC ? prev.from : INC,
      rawFrom: INC,
    });
  }
  cached.burns = [...byTx2.values()];
  cached.cachedAt = Date.now();
  await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
  summary = summarizeIncinerator(cached.burns);
  console.log("after rebuild — count:", summary.count, "sum:", summary.sum.toString());
}

if (BigInt(summary.count) !== targetCalls || summary.sum !== targetBurned) {
  console.error("UNRESOLVED: Redis still does not match contract counters.");
  console.error("  redis:", summary.count, summary.sum.toString());
  console.error("  chain:", targetCalls.toString(), targetBurned.toString());
  process.exit(2);
}

console.log("VERIFY OK — matches totalCalls/totalBurned");

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
  console.error("Export mismatch vs contract");
  process.exit(3);
}
console.log("EXPORT OK — matches step 1 live counters");
