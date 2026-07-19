// scripts/repair-incinerator-etherscan.mjs
// Fill missing Incinerator → dead/zero CLAWD burns via explorer APIs (Base),
// then merge into ash-ledger:burns:v1 without double-counting.
// Prefers Etherscan V2 when the key's plan includes Base; otherwise Blockscout.
//
// Usage:
//   node --env-file=.env --env-file=.env.local scripts/repair-incinerator-etherscan.mjs
//
// Requires: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// Optional: ETHERSCAN_API_KEY (used when plan covers chainid 8453)

import { Redis } from "@upstash/redis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { fetchTokenTxs, fetchLogs } = require("../lib/etherscan.js");

const INC = "0x536453350f2eee2eb8bfee1866baf4fca494a092";
const CLAWD = "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEPLOY = 41337394;
const CACHE_KEY = "ash-ledger:burns:v1";
const topicAddr = (a) => "0x" + a.slice(2).padStart(64, "0").toLowerCase();

function burnKey(b) {
  const amt = BigInt(b.amount || "0x0").toString();
  return `${String(b.tx).toLowerCase()}|${String(b.from).toLowerCase()}|${amt}|${b.block}`;
}

function sumInc(burns) {
  let amt = 0n;
  const txs = new Set();
  for (const b of burns) {
    if (String(b.from).toLowerCase() !== INC) continue;
    amt += BigInt(b.amount);
    if (b.tx) txs.add(String(b.tx).toLowerCase());
  }
  return { txs: txs.size, clawd: Number(amt) / 1e18 };
}

function toHexAmount(value) {
  // tokentx value is decimal string of raw units
  const n = BigInt(value);
  return "0x" + n.toString(16);
}

function burnFromTokenTx(row) {
  const from = String(row.from || "").toLowerCase();
  const to = String(row.to || "").toLowerCase();
  if (from !== INC) return null;
  if (to !== DEAD && to !== ZERO) return null;
  return {
    from: INC,
    to,
    amount: toHexAmount(row.value),
    block: Number(row.blockNumber),
    tx: String(row.hash || row.transactionHash).toLowerCase(),
  };
}

function burnFromLog(log) {
  if (!log.topics || log.topics.length < 3) return null;
  const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
  const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
  if (from !== INC) return null;
  if (to !== DEAD && to !== ZERO) return null;
  const data = log.data === "0x" ? "0x0" : log.data;
  return {
    from: INC,
    to,
    amount: data,
    block: parseInt(log.blockNumber, 16),
    tx: String(log.transactionHash).toLowerCase(),
  };
}

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("FATAL: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}
const redis = Redis.fromEnv();
const cached = await redis.get(CACHE_KEY);
if (!cached?.burns) {
  console.error("No burn cache at", CACHE_KEY);
  process.exit(1);
}

const before = sumInc(cached.burns);
console.log("BEFORE incinerator:", before);

// Primary: CLAWD tokentx involving Incinerator (paginated, polite delay)
console.log("Fetching Incinerator CLAWD tokentx via explorer...");
const tokenRows = await fetchTokenTxs({
  contractAddress: CLAWD,
  address: INC,
  startBlock: DEPLOY,
  pageSize: 100,
  delayMs: 300,
  onPage: (page, n, total) => {
    process.stdout.write(`\r  tokentx page ${page} (+${n}, total ${total})`);
  },
});
console.log("");

const fromToken = [];
for (const row of tokenRows) {
  const b = burnFromTokenTx(row);
  if (b) fromToken.push(b);
}
console.log(`  tokentx rows=${tokenRows.length}, burn candidates=${fromToken.length}`);

// Secondary: Transfer logs from INC (catches anything tokentx missed)
console.log("Fetching CLAWD Transfer logs from Incinerator via explorer...");
const logs = await fetchLogs({
  address: CLAWD,
  fromBlock: DEPLOY,
  toBlock: "latest",
  topic0: TRANSFER,
  topic1: topicAddr(INC),
  pageSize: 1000,
  delayMs: 300,
  onPage: (page, n, total) => {
    process.stdout.write(`\r  logs page ${page} (+${n}, total ${total})`);
  },
});
console.log("");

const fromLogs = [];
for (const log of logs) {
  const b = burnFromLog(log);
  if (b) fromLogs.push(b);
}
console.log(`  log rows=${logs.length}, burn candidates=${fromLogs.length}`);

// Union by burnKey
const foundMap = new Map();
for (const b of [...fromToken, ...fromLogs]) {
  foundMap.set(burnKey(b), b);
}
const found = [...foundMap.values()];
const onAmt = found.reduce((s, b) => s + BigInt(b.amount), 0n);
console.log(`Explorer union: ${found.length} burns, CLAWD ${Number(onAmt) / 1e18}`);

const cacheKeys = new Set(cached.burns.map(burnKey));

let added = 0;
for (const b of found) {
  const k = burnKey(b);
  if (cacheKeys.has(k)) continue;
  cached.burns.push(b);
  cacheKeys.add(k);
  added++;
}

if (added) {
  cached.cachedAt = Date.now();
  await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
}

const after = sumInc(cached.burns);
console.log("AFTER incinerator:", after);
console.log(`merged ${added} missing burns into ${CACHE_KEY}`);
if (after.txs < 156) {
  console.log(`note: still below site claim of 156 burns (have ${after.txs})`);
} else {
  console.log("incinerator burn count at or above expected 156");
}
