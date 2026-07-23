// Keep Incinerator-labeled burns in Redis matched to the contract's own
// totalCalls()/totalBurned(). The general Transfer→dead scan can miss rows
// (silent getLogs truncation); this targeted from=Incinerator pass fills holes.

const INC = "0x536453350f2eee2eb8bfee1866baf4fca494a092";
const CLAWD = "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOTAL_CALLS_SEL = "0x3af3f24f";
const TOTAL_BURNED_SEL = "0xd89135cd";
const INTERVAL = 28800;
const FROM_TOPIC = "0x" + INC.slice(2).padStart(64, "0");

const LOG_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];

let logI = 0;
async function logRpc(method, params, tries = LOG_RPCS.length * 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = LOG_RPCS[logI % LOG_RPCS.length];
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
      logI++;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  throw new Error(lastErr || "log rpc failed");
}

function isInc(b) {
  const f = String(b.from || "").toLowerCase();
  const r = String(b.rawFrom || "").toLowerCase();
  return f === INC || r === INC;
}

function summarize(burns) {
  const byTx = new Map();
  for (const b of burns) {
    if (!isInc(b)) continue;
    byTx.set(String(b.tx).toLowerCase(), b);
  }
  let sum = 0n;
  let lastBlock = 0;
  for (const b of byTx.values()) {
    sum += BigInt(b.amount);
    if (b.block > lastBlock) lastBlock = b.block;
  }
  return { count: byTx.size, sum, lastBlock, byTx };
}

function decode(log) {
  const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
  if (to !== DEAD && to !== ZERO) return null;
  return {
    from: INC,
    rawFrom: INC,
    to,
    amount: log.data === "0x" ? "0x0" : log.data,
    block: parseInt(log.blockNumber, 16),
    tx: String(log.transactionHash).toLowerCase(),
  };
}

async function scanSerial(fromBlock, toBlock) {
  const found = [];
  let lo = fromBlock;
  let size = 2000;
  while (lo <= toBlock) {
    let hi = Math.min(lo + size - 1, toBlock);
    let ok = false;
    while (!ok) {
      try {
        const logs = await logRpc("eth_getLogs", [{
          address: CLAWD,
          topics: [TRANSFER, FROM_TOPIC, null],
          fromBlock: "0x" + lo.toString(16),
          toBlock: "0x" + hi.toString(16),
        }]);
        if ((logs || []).length >= 800 && hi > lo) {
          hi = lo + Math.floor((hi - lo) / 2);
          size = Math.max(50, Math.floor(size / 2));
          continue;
        }
        for (const l of logs || []) {
          const b = decode(l);
          if (b) found.push(b);
        }
        ok = true;
        if ((logs || []).length < 10 && size < 2000) size = Math.min(2000, size * 2);
      } catch {
        if (hi <= lo) throw new Error("incinerator getLogs hard fail at " + lo);
        hi = lo + Math.max(0, Math.floor((hi - lo) / 2));
        size = Math.max(50, Math.floor(size / 2));
      }
    }
    lo = hi + 1;
  }
  return [...new Map(found.map((b) => [b.tx, b])).values()];
}

/**
 * If Redis incinerator count/sum lags live totalCalls/totalBurned, scan tip +
 * medium gaps and merge. Mutates/returns updated burns array.
 */
async function syncIncineratorBurns(rpc, burns, { maxRanges = 4 } = {}) {
  const calls = BigInt(await rpc("eth_call", [{ to: INC, data: TOTAL_CALLS_SEL }, "latest"]));
  const burned = BigInt(await rpc("eth_call", [{ to: INC, data: TOTAL_BURNED_SEL }, "latest"]));
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  let summary = summarize(burns);

  if (BigInt(summary.count) === calls && summary.sum === burned) {
    return {
      burns,
      matched: true,
      liveCalls: calls.toString(),
      liveBurned: burned.toString(),
      redisCount: summary.count,
      added: 0,
    };
  }

  const blocks = [...summary.byTx.values()].map((b) => b.block).sort((a, b) => a - b);
  const ranges = [];
  for (let i = 1; i < blocks.length; i++) {
    const d = blocks[i] - blocks[i - 1];
    if (d > INTERVAL * 1.2 && d < INTERVAL * 50) ranges.push([blocks[i - 1] + 1, blocks[i] - 1]);
  }
  if (blocks.length) ranges.push([blocks[blocks.length - 1] + 1, latest]);
  // Second-era window often holds silent-truncation holes.
  if (blocks.length && blocks[blocks.length - 1] > 48000000) {
    ranges.push([48150000, latest]);
  }

  const byTx = new Map(burns.map((b) => [String(b.tx).toLowerCase(), b]));
  let added = 0;
  const scanned = ranges.slice(0, maxRanges);
  for (const [a, b] of scanned) {
    if (b < a) continue;
    const found = await scanSerial(a, b);
    for (const row of found) {
      const prev = byTx.get(row.tx);
      if (!prev) {
        byTx.set(row.tx, row);
        added++;
        continue;
      }
      if (!isInc(prev)) {
        byTx.set(row.tx, { ...prev, rawFrom: INC, amount: row.amount, block: row.block, to: row.to });
        added++;
      }
    }
    summary = summarize([...byTx.values()]);
    if (BigInt(summary.count) >= calls && summary.sum >= burned) break;
  }

  // Re-read live (burn may land mid-sync).
  const calls2 = BigInt(await rpc("eth_call", [{ to: INC, data: TOTAL_CALLS_SEL }, "latest"]));
  const burned2 = BigInt(await rpc("eth_call", [{ to: INC, data: TOTAL_BURNED_SEL }, "latest"]));
  summary = summarize([...byTx.values()]);

  return {
    burns: [...byTx.values()],
    matched: BigInt(summary.count) === calls2 && summary.sum === burned2,
    liveCalls: calls2.toString(),
    liveBurned: burned2.toString(),
    redisCount: summary.count,
    added,
  };
}

module.exports = {
  INC,
  syncIncineratorBurns,
  summarizeIncinerator: summarize,
};
