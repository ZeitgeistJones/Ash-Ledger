// lib/ash-ledger.js
//
// Watches ONE thing: Transfer events on the CLAWD token where `to` is a known
// burn destination (dead address OR address(0)). This catches every burn
// mechanism across the whole ecosystem automatically — no need to know about
// or integrate with each individual contract. The registry (registry.js) is
// only used for LABELING who did the burning, not for finding the burns.

const CLAWD_TOKEN = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
const DEPLOY_BLOCK = 41337394; // CLAWD token creation, confirmed on basescan
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// topics use 32-byte padded addresses
const topicFor = (addr) => "0x" + addr.slice(2).padStart(64, "0").toLowerCase();
const DEAD_TOPIC = topicFor(DEAD_ADDRESS);
const ZERO_TOPIC = topicFor(ZERO_ADDRESS);

const RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
].filter(Boolean);

let rpcIndex = 0;
async function rpc(method, params, tries = RPCS.length * 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[rpcIndex % RPCS.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(url + " → http " + res.status);
      const data = await res.json();
      if (data.error) throw new Error(url + " → " + (data.error.message || "rpc error"));
      return data.result;
    } catch (e) {
      clearTimeout(timeout);
      lastErr = e.name === "AbortError" ? url + " → timed out" : (e.message || String(e));
      rpcIndex++;
    }
  }
  throw new Error(lastErr || "all RPCs failed");
}

function decodeBurn(log) {
  // topics: [Transfer sig, from (indexed), to (indexed)]; data: value
  if (!log.topics || log.topics.length < 3) return null;
  const from = "0x" + log.topics[1].slice(26);
  const to = "0x" + log.topics[2].slice(26);
  const value = log.data === "0x" ? "0x0" : log.data;
  return {
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    amount: value,
    block: parseInt(log.blockNumber, 16),
    tx: log.transactionHash,
  };
}

async function fetchChunk(from, to, toTopic) {
  let lo = from, hi = to, attempts = 0;
  while (attempts < 8) {
    try {
      return await rpc("eth_getLogs", [{
        address: CLAWD_TOKEN,
        topics: [TRANSFER_TOPIC, null, toTopic], // filter server-side on `to` — cheap and precise
        fromBlock: "0x" + lo.toString(16),
        toBlock: "0x" + hi.toString(16),
      }], 2);
    } catch (e) {
      attempts++;
      if (hi - lo < 200) throw e;
      hi = lo + Math.floor((hi - lo) / 2);
    }
  }
  throw new Error("chunk " + from + "-" + to + " failed after retries");
}

async function scanRange(fromBlock, toBlock) {
  const CHUNK_SIZE = 5000;
  const CONCURRENCY = 14;
  const ranges = [];
  for (let f = fromBlock; f <= toBlock; f += CHUNK_SIZE) {
    ranges.push([f, Math.min(f + CHUNK_SIZE - 1, toBlock)]);
  }
  if (!ranges.length) return [];

  // Two independent passes: one for burns to the dead address, one for real
  // burn() calls to address(0). Kept separate so a failure in one doesn't
  // block the other, and so results are clearly attributable to a mechanism.
  async function scanFor(toTopic) {
    const results = new Array(ranges.length);
    let cursor = 0, hardFailures = 0;
    async function worker() {
      while (cursor < ranges.length) {
        const idx = cursor++;
        const [f, t] = ranges[idx];
        try { results[idx] = await fetchChunk(f, t, toTopic); }
        catch (e) { results[idx] = []; hardFailures++; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, worker));
    if (hardFailures > ranges.length * 0.05) {
      throw new Error(hardFailures + " of " + ranges.length + " block ranges failed");
    }
    return results.flat();
  }

  const [deadLogs, zeroLogs] = await Promise.all([scanFor(DEAD_TOPIC), scanFor(ZERO_TOPIC)]);
  const burns = [...deadLogs.map(decodeBurn), ...zeroLogs.map(decodeBurn)].filter(Boolean);
  return burns;
}

function analyze(burns, registry) {
  const evs = [...burns].sort((a, b) => a.block - b.block);
  const bySource = new Map();
  const allTxs = new Set();
  const byCategory = { clawdbotatg: 0n, community: 0n, unlabeled: 0n };
  let totalBurned = 0n;

  for (const e of evs) {
    if (e.tx) allTxs.add(e.tx.toLowerCase());
    const amount = BigInt(e.amount);
    totalBurned += amount;
    const entry = registry[e.from];
    const category = entry?.category || "unlabeled";
    byCategory[category] = (byCategory[category] || 0n) + amount;

    const s = bySource.get(e.from) || {
      addr: e.from,
      name: entry?.name || null,
      project: entry?.project || entry?.name || null,
      category,
      note: entry?.note || null,
      txs: new Set(),
      burned: 0n,
      first: e.block,
      last: e.block,
    };
    if (e.tx) s.txs.add(e.tx.toLowerCase());
    s.burned += amount;
    s.last = e.block;
    bySource.set(e.from, s);
  }

  const sources = [...bySource.values()]
    .map(s => {
      const { txs, ...source } = s;
      return { ...source, count: txs.size, burned: s.burned.toString() };
    })
    .sort((a, b) => BigInt(b.burned) > BigInt(a.burned) ? 1 : -1);

  return {
    totalBurns: allTxs.size,
    totalTransfers: evs.length,
    totalBurned: totalBurned.toString(),
    uniqueSources: bySource.size,
    byCategory: {
      clawdbotatg: byCategory.clawdbotatg.toString(),
      community: byCategory.community.toString(),
      unlabeled: byCategory.unlabeled.toString(),
    },
    sources,
    events: evs, // raw, for the burn log table
  };
}

module.exports = {
  CLAWD_TOKEN, DEPLOY_BLOCK, DEAD_ADDRESS, ZERO_ADDRESS,
  rpc, scanRange, analyze, decodeBurn,
};
