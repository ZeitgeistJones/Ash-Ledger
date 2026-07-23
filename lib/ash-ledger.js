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

// General RPCs (blockNumber, receipts) — Alchemy OK here.
const RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
].filter(Boolean);

// eth_getLogs only — skip Alchemy (free tier often 10-block / rate-limits hard).
// Same idea as Furnace Log: public Base RPCs, sequential chunks.
const LOG_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];

let rpcIndex = 0;
let logRpcIndex = 0;

async function rpcOn(urls, state, method, params, tries = urls.length * 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = urls[state.i % urls.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
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
      state.i++;
    }
  }
  throw new Error(lastErr || "all RPCs failed");
}

const rpcState = { get i() { return rpcIndex; }, set i(v) { rpcIndex = v; } };
const logState = { get i() { return logRpcIndex; }, set i(v) { logRpcIndex = v; } };

async function rpc(method, params, tries) {
  return rpcOn(RPCS, rpcState, method, params, tries);
}

async function logRpc(method, params, tries) {
  return rpcOn(LOG_RPCS, logState, method, params, tries);
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

// eth_getLogs providers often cap ~10k results and silently truncate.
const LOG_RESULT_CAP = 10000;

async function fetchChunk(from, to, toTopic) {
  let lo = from, hi = to, attempts = 0;
  while (attempts < 12) {
    try {
      // Public log RPCs only — Furnace-style freshness (Alchemy free is too harsh).
      const logs = await logRpc("eth_getLogs", [{
        address: CLAWD_TOKEN,
        topics: [TRANSFER_TOPIC, null, toTopic], // filter server-side on `to` — cheap and precise
        fromBlock: "0x" + lo.toString(16),
        toBlock: "0x" + hi.toString(16),
      }], 3);
      // Hit provider cap → split so we don't permanently lose burns.
      if (Array.isArray(logs) && logs.length >= LOG_RESULT_CAP && hi > lo) {
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

/**
 * Scan CLAWD Transfer→dead/zero in [fromBlock, toBlock].
 * Default is Furnace-style: sequential chunks on public RPCs (reliable under
 * serverless). Pass { parallel: true } only for offline seed scripts.
 */
async function scanRange(fromBlock, toBlock, opts = {}) {
  const CHUNK_SIZE = opts.chunkSize || 2000;
  const parallel = opts.parallel === true;
  const CONCURRENCY = parallel ? (opts.concurrency || 6) : 1;
  const ranges = [];
  for (let f = fromBlock; f <= toBlock; f += CHUNK_SIZE) {
    ranges.push([f, Math.min(f + CHUNK_SIZE - 1, toBlock)]);
  }
  if (!ranges.length) return [];

  // Two passes: dead address, then address(0). Sequential by default so public
  // RPCs don't get hammered the way parallel tip catch-up used to.
  async function scanFor(toTopic) {
    const results = new Array(ranges.length);
    let hardFailures = 0;
    const errors = [];

    if (CONCURRENCY <= 1) {
      for (let idx = 0; idx < ranges.length; idx++) {
        const [f, t] = ranges[idx];
        try {
          results[idx] = await fetchChunk(f, t, toTopic);
        } catch (e) {
          results[idx] = null;
          hardFailures++;
          if (errors.length < 3) errors.push((e.message || String(e)) + ` [${f}-${t}]`);
          // Fail fast in sequential mode — caller keeps watermark, retries later.
          break;
        }
      }
    } else {
      let cursor = 0;
      async function worker() {
        while (cursor < ranges.length) {
          const idx = cursor++;
          const [f, t] = ranges[idx];
          try { results[idx] = await fetchChunk(f, t, toTopic); }
          catch (e) {
            results[idx] = null;
            hardFailures++;
            if (errors.length < 3) errors.push((e.message || String(e)) + ` [${f}-${t}]`);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, worker));
    }

    // Any hard failure must surface — returning [] used to silently drop burns
    // while scannedTo still advanced past the hole.
    if (hardFailures > 0) {
      throw new Error(
        hardFailures + " of " + ranges.length + " block ranges failed" +
          (errors.length ? ": " + errors.join("; ") : "")
      );
    }
    return results.flat();
  }

  const deadLogs = await scanFor(DEAD_TOPIC);
  const zeroLogs = await scanFor(ZERO_TOPIC);
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
