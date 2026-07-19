// scripts/attribute-buybacks.mjs
// Close Build Report + DCA v3 causal gaps via explorer logs + receipt rebucket.
// Rebuckets CLAWD→dead Transfers to the project — does NOT add Burned amounts.
//
// Usage:
//   node --env-file=.env.local scripts/attribute-buybacks.mjs

import { Redis } from "@upstash/redis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { fetchLogs, fetchTokenTxs } = require("../lib/etherscan.js");
const {
  attributeBurns,
  BUILD_REPORT,
  DCA_V3,
  BUILD_BURNED_TOPIC,
  CAUSAL_SET,
  projectFromReceipt,
} = require("../lib/attribution.js");

const CLAWD = "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = "0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3";
const DCA2 = "0xa16095e72936ad6dab012ec1b95222f6fcb5f5c2";
const INC = "0x536453350f2eee2eb8bfee1866baf4fca494a092";
const CACHE_KEY = "ash-ledger:burns:v1";
const ATTR_KEY = "ash-ledger:attribution:v1";
const DEPLOY = 41337394;

const RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
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
  return `${String(b.tx).toLowerCase()}|${String(b.from).toLowerCase()}|${BigInt(b.amount || "0x0")}|${b.block}`;
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

function clawdBurnsFromReceipt(receipt) {
  const out = [];
  for (const log of receipt?.logs || []) {
    if (String(log.address).toLowerCase() !== CLAWD) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
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
  console.error("FATAL: Upstash env missing");
  process.exit(1);
}

const redis = Redis.fromEnv();
const cached = await redis.get(CACHE_KEY);
const burns = cached?.burns || [];
const attrMap = (await redis.get(ATTR_KEY)) || {};
if (!burns.length) {
  console.error("No burns in cache");
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

// --- 1) Build Report Burned(uint256) via explorer ---
console.log("\n[1] Fetching Build Report Burned events...");
const burnedLogs = await fetchLogs({
  address: BUILD_REPORT,
  fromBlock: DEPLOY,
  toBlock: "latest",
  topic0: BUILD_BURNED_TOPIC,
  pageSize: 1000,
  delayMs: 250,
  onPage: (p, n, tot) => process.stdout.write(`\r  Burned page ${p} (+${n}) total ${tot}`),
});
console.log(`\n  Burned logs: ${burnedLogs.length}`);

let burnedSum = 0n;
const burnedTxs = new Set();
for (const log of burnedLogs) {
  const tx = String(log.transactionHash).toLowerCase();
  burnedTxs.add(tx);
  attrMap[tx] = BUILD_REPORT;
  const data = log.data === "0x" ? "0x0" : log.data;
  burnedSum += BigInt(data);
}
console.log(`  Burned(uint256) sum: ${Number(burnedSum) / 1e18}`);

// --- 2) DCA v3: token txs + contract logs that touch CLAWD burns ---
console.log("\n[2] Fetching DCA v3 related activity...");
let dcaTxs = new Set();
try {
  const dcaLogs = await fetchLogs({
    address: DCA_V3,
    fromBlock: DEPLOY,
    toBlock: "latest",
    pageSize: 1000,
    delayMs: 250,
    onPage: (p, n, tot) => process.stdout.write(`\r  DCA3 logs page ${p} (+${n}) total ${tot}`),
  });
  console.log(`\n  DCA3 contract logs: ${dcaLogs.length}`);
  for (const l of dcaLogs) dcaTxs.add(String(l.transactionHash).toLowerCase());
} catch (e) {
  console.warn("  DCA3 logs fetch failed:", e.message || e);
}

// Also: any CLAWD tokentx where the interacting address path includes DCA3 as tx.to
// Pool burns already handled via receipt; ensure all dcaTxs with burns get mapped.
for (const tx of dcaTxs) {
  if (attrMap[tx] === BUILD_REPORT) continue;
  attrMap[tx] = DCA_V3;
}

// --- 3) Ensure every Burned / DCA3 tx has its CLAWD→dead Transfer(s) in burn cache ---
console.log("\n[3] Filling missing Transfers for attributed txs...");
const cacheTx = new Set(burns.map((b) => String(b.tx).toLowerCase()));
const needReceipt = [...burnedTxs].filter((tx) => !cacheTx.has(tx));
// DCA3 txs that claim burns on site but may lack Transfer in cache
for (const tx of dcaTxs) {
  if (!cacheTx.has(tx)) needReceipt.push(tx);
}
const uniqNeed = [...new Set(needReceipt)];
console.log(`  txs needing receipt burn extract: ${uniqNeed.length}`);

const keys = new Set(burns.map(burnKey));
let addedBurns = 0;
for (let i = 0; i < uniqNeed.length; i++) {
  const tx = uniqNeed[i];
  try {
    const receipt = await rpc("eth_getTransactionReceipt", [tx]);
    const found = clawdBurnsFromReceipt(receipt);
    for (const b of found) {
      const k = burnKey(b);
      if (keys.has(k)) continue;
      burns.push(b);
      keys.add(k);
      addedBurns++;
    }
    // Re-confirm attribution from receipt
    const trx = await rpc("eth_getTransactionByHash", [tx]);
    const project = projectFromReceipt(receipt, trx);
    if (project) attrMap[tx] = project;
    else if (burnedTxs.has(tx)) attrMap[tx] = BUILD_REPORT;
    else if (dcaTxs.has(tx)) attrMap[tx] = DCA_V3;
  } catch (e) {
    console.warn(`  skip ${tx}: ${e.message || e}`);
  }
  if ((i + 1) % 10 === 0 || i + 1 === uniqNeed.length) {
    process.stdout.write(`\r  receipts ${i + 1}/${uniqNeed.length} addedBurns ${addedBurns}`);
  }
}
console.log("");

// --- 4) Retry nulls for pool-sourced burns still unmapped ---
console.log("\n[4] Retry null attribution for pool burns...");
let nullRetries = 0;
let nullHits = 0;
for (const b of burns) {
  const tx = b.tx && String(b.tx).toLowerCase();
  const from = String(b.rawFrom || b.from || "").toLowerCase();
  if (!tx) continue;
  if (CAUSAL_SET.has(from)) {
    attrMap[tx] = from;
    continue;
  }
  if (attrMap[tx] != null) continue;
  if (from !== POOL && from !== BUILD_REPORT && from !== DCA_V3) continue;
  nullRetries++;
  try {
    const [receipt, trx] = await Promise.all([
      rpc("eth_getTransactionReceipt", [tx]),
      rpc("eth_getTransactionByHash", [tx]),
    ]);
    const project = projectFromReceipt(receipt, trx);
    attrMap[tx] = project;
    if (project) nullHits++;
  } catch {
    delete attrMap[tx];
  }
}
console.log(`  pool/null retries ${nullRetries}, hits ${nullHits}`);

// Persist
cached.burns = burns;
cached.cachedAt = Date.now();
await redis.set(CACHE_KEY, cached, { ex: 60 * 60 * 24 * 30 });
await redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 });

const attributed = attributeBurns(burns, attrMap);
const totalAfter = burns.reduce((s, b) => s + BigInt(b.amount), 0n);
const after = {
  incinerator: sumAddr(burns, INC),
  build: sumAddr(attributed, BUILD_REPORT),
  dca3: sumAddr(attributed, DCA_V3),
  dca2: sumAddr(attributed, DCA2),
  totalBurned: Number(totalAfter) / 1e18,
  burnedEventSum: Number(burnedSum) / 1e18,
  addedBurns,
};
console.log("\nAFTER", JSON.stringify(after, null, 2));
console.log("totalBurned delta:", Number(totalAfter - totalBefore) / 1e18);
console.log(
  "targets: Build≈319486 BurnedSum=" +
    Number(burnedSum) / 1e18 +
    " | DCA3≈372793/7 | Inc=156/1560M"
);
console.log("DONE");
