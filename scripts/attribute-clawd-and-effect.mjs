// scripts/attribute-clawd-and-effect.mjs
// Find Clawd & Effect tip→dead burns, fill cache gaps, set causal attribution.
// Rebuckets Transfer.from only — does not double-count.
//
// Usage:
//   node --env-file=.env.local scripts/attribute-clawd-and-effect.mjs

import { Redis } from "@upstash/redis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { fetchLogs } = require("../lib/etherscan.js");
const {
  attributeBurns,
  CLAWD_AND_EFFECT,
  projectFromReceipt,
} = require("../lib/attribution.js");

const CLAWD = "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const EFFECT = CLAWD_AND_EFFECT;
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CACHE_KEY = "ash-ledger:burns:v1";
const ATTR_KEY = "ash-ledger:attribution:v1";
const KNOWN_BURN_TX =
  "0x4fae91d557b5b2ee697a6ef3c8f38aeada638a3eb51fcd7adfbad0ed8ec67f75";

const RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
].filter(Boolean);

let rpcI = 0;
async function rpc(method, params) {
  let last;
  for (let t = 0; t < RPCS.length * 3; t++) {
    const url = RPCS[rpcI % RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.result;
    } catch (e) {
      last = e;
      rpcI++;
    }
  }
  throw last;
}

function burnKey(b) {
  return [
    String(b.tx).toLowerCase(),
    String(b.from).toLowerCase(),
    String(BigInt(b.amount || "0x0")),
    String(b.block),
  ].join("|");
}

function clawdBurnsFromReceipt(receipt) {
  const out = [];
  for (const log of receipt?.logs || []) {
    if (String(log.address).toLowerCase() !== CLAWD) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER) continue;
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    if (to !== DEAD && to !== ZERO) continue;
    out.push({
      from: ("0x" + log.topics[1].slice(26)).toLowerCase(),
      to,
      amount: log.data === "0x" ? "0x0" : log.data,
      block: parseInt(log.blockNumber, 16),
      tx: String(log.transactionHash || receipt.transactionHash).toLowerCase(),
    });
  }
  return out;
}

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("FATAL: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}

const redis = Redis.fromEnv();
const cached = await redis.get(CACHE_KEY);
if (!cached?.burns?.length) {
  console.error("No burns in cache — run seed.mjs first.");
  process.exit(1);
}

const burns = cached.burns;
const attrMap = (await redis.get(ATTR_KEY)) || {};
const keys = new Set(burns.map(burnKey));
const beforeCount = burns.length;
const beforeTotal = burns.reduce((s, b) => s + BigInt(b.amount), 0n);

const knownReceipt = await rpc("eth_getTransactionReceipt", [KNOWN_BURN_TX]);
const tipLog = (knownReceipt.logs || []).find(
  (l) => l.address?.toLowerCase() === EFFECT
);
const tipTopic0 = tipLog?.topics?.[0];
if (!tipTopic0) {
  console.error("Could not find Tip event on known burn tx");
  process.exit(1);
}
console.log("Tip topic0:", tipTopic0);

const deadTopic = "0x" + DEAD.slice(2).padStart(64, "0");
console.log("Fetching Tip events with winner=dead...");
const tipDeadLogs = await fetchLogs({
  address: EFFECT,
  fromBlock: 0,
  toBlock: "latest",
  topic0: tipTopic0,
  topic2: deadTopic,
  pageSize: 1000,
  delayMs: 400,
});
console.log("Tip→dead events:", tipDeadLogs.length);

const burnTxs = new Set([KNOWN_BURN_TX.toLowerCase()]);
for (const log of tipDeadLogs) {
  burnTxs.add(String(log.transactionHash).toLowerCase());
}

let added = 0;
let attributed = 0;
for (const tx of burnTxs) {
  const [receipt, trx] = await Promise.all([
    rpc("eth_getTransactionReceipt", [tx]),
    rpc("eth_getTransactionByHash", [tx]),
  ]);
  const project = projectFromReceipt(receipt, trx);
  const to = trx?.to && String(trx.to).toLowerCase();
  console.log(tx, "project=", project, "tx.to=", to);
  if (project === EFFECT || to === EFFECT) {
    attrMap[tx] = EFFECT;
    attributed++;
  }
  for (const b of clawdBurnsFromReceipt(receipt)) {
    const k = burnKey(b);
    if (keys.has(k)) {
      console.log("  already cached", Number(BigInt(b.amount)) / 1e18, "CLAWD");
      continue;
    }
    burns.push(b);
    keys.add(k);
    added++;
    console.log(
      "  ADDED",
      Number(BigInt(b.amount)) / 1e18,
      "CLAWD from",
      b.from,
      "block",
      b.block
    );
  }
}

cached.burns = burns;
cached.cachedAt = Date.now();
await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
await redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 });

const attributedBurns = attributeBurns(burns, attrMap);
let effectAmt = 0n;
const effectTxs = new Set();
for (const b of attributedBurns) {
  if (String(b.from).toLowerCase() !== EFFECT) continue;
  effectAmt += BigInt(b.amount);
  if (b.tx) effectTxs.add(String(b.tx).toLowerCase());
}
const afterTotal = burns.reduce((s, b) => s + BigInt(b.amount), 0n);

console.log(
  JSON.stringify(
    {
      beforeCount,
      afterCount: burns.length,
      added,
      attributed,
      effectTxs: [...effectTxs],
      effectClawd: Number(effectAmt) / 1e18,
      totalDelta: Number(afterTotal - beforeTotal) / 1e18,
      attrForKnown: attrMap[KNOWN_BURN_TX.toLowerCase()],
    },
    null,
    2
  )
);
