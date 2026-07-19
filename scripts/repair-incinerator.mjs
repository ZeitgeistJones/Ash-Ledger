// scripts/repair-incinerator.mjs — find Incinerator Transfer→dead/zero missing
// from Redis cache (silent getLogs truncation) and merge them in.
import { Redis } from "@upstash/redis";

const INC = "0x536453350f2eee2eb8bfee1866baf4fca494a092";
const CLAWD = "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEPLOY = 41337394;
const CACHE_KEY = "ash-ledger:burns:v1";
const topicAddr = (a) => "0x" + a.slice(2).padStart(64, "0");

const RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
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
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(lastErr || "all RPCs failed");
}

async function getLogs(lo, hi, fromTopic) {
  let a = lo;
  let b = hi;
  for (let attempt = 0; attempt < 14; attempt++) {
    try {
      const logs = await rpc("eth_getLogs", [{
        address: CLAWD,
        topics: [TRANSFER, fromTopic, null],
        fromBlock: "0x" + a.toString(16),
        toBlock: "0x" + b.toString(16),
      }]);
      if (Array.isArray(logs) && logs.length >= 10000 && b > a) {
        const mid = a + Math.floor((b - a) / 2);
        const left = await getLogs(a, mid, fromTopic);
        const right = await getLogs(mid + 1, b, fromTopic);
        return left.concat(right);
      }
      return logs || [];
    } catch (e) {
      if (b - a < 20) throw e;
      b = a + Math.floor((b - a) / 2);
    }
  }
  throw new Error("getLogs failed " + lo + "-" + hi);
}

function decode(log) {
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

function burnKey(b) {
  return `${String(b.tx).toLowerCase()}|${String(b.from).toLowerCase()}|${b.amount}|${b.block}`;
}

const redis = Redis.fromEnv();
const cached = await redis.get(CACHE_KEY);
if (!cached?.burns) {
  console.error("No burn cache");
  process.exit(1);
}

const cacheTx = new Set(
  cached.burns
    .filter((b) => String(b.from).toLowerCase() === INC)
    .map((b) => String(b.tx).toLowerCase())
);
console.log("cache incinerator txs:", cacheTx.size);

const latest = parseInt(await rpc("eth_blockNumber", []), 16);
const fromTopic = topicAddr(INC);
const found = [];
const CHUNK = 25000;
for (let lo = DEPLOY; lo <= latest; ) {
  const wantHi = Math.min(lo + CHUNK - 1, latest);
  let cursor = lo;
  while (cursor <= wantHi) {
    let end = wantHi;
    let logs;
    for (;;) {
      try {
        logs = await getLogs(cursor, end, fromTopic);
        break;
      } catch (e) {
        if (end - cursor < 20) throw e;
        end = cursor + Math.floor((end - cursor) / 2);
      }
    }
    for (const l of logs) {
      const b = decode(l);
      if (b) found.push(b);
    }
    cursor = end + 1;
  }
  lo = wantHi + 1;
  process.stdout.write(`\r scanned ${Math.min(wantHi, latest)}/${latest} found ${found.length}`);
}

const missing = found.filter((b) => !cacheTx.has(b.tx));
const onAmt = found.reduce((s, b) => s + BigInt(b.amount), 0n);
console.log("\non-chain:", found.length, "txs, CLAWD", Number(onAmt) / 1e18);
console.log("missing from cache:", missing.length, "CLAWD", missing.reduce((s, b) => s + Number(BigInt(b.amount)) / 1e18, 0));

if (missing.length) {
  const keys = new Set(cached.burns.map(burnKey));
  let added = 0;
  for (const b of missing) {
    const k = burnKey(b);
    if (keys.has(k)) continue;
    cached.burns.push(b);
    keys.add(k);
    added++;
  }
  cached.cachedAt = Date.now();
  await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
  console.log("merged", added, "burns into cache. New incinerator txs:", cacheTx.size + added);
} else {
  console.log("cache already complete for Incinerator");
}
