// Shared incremental burn catch-up for /api/stats and the daily cron.
// Never advances scannedTo past a failed range; persists gaps for retry.

const { DEPLOY_BLOCK, scanRange } = require("./ash-ledger");

const CACHE_KEY = "ash-ledger:burns:v1";
const GAPS_KEY = "ash-ledger:scan-gaps:v1";
const LOCK_KEY = "ash-ledger:scanlock:v1";

function burnKey(b) {
  return `${String(b.tx).toLowerCase()}|${String(b.from).toLowerCase()}|${b.amount}|${b.block}`;
}

function mergeBurns(existing, incoming) {
  const seen = new Set(existing.map(burnKey));
  const out = existing.slice();
  for (const b of incoming) {
    const k = burnKey(b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

/**
 * Catch Redis burn cache up to `latest` block.
 * @param {object} redis Upstash Redis client
 * @param {number} latest chain tip
 * @param {{ lockTtlSec?: number }} [opts]
 * @returns {Promise<{ burns, scannedTo, gaps, added, advanced, skippedLock, errors }>}
 */
async function catchUpBurns(redis, latest, opts = {}) {
  const lockTtlSec = opts.lockTtlSec ?? 30;
  const cached = await redis.get(CACHE_KEY);
  let burns = cached?.burns || [];
  let scannedTo = cached?.scannedTo || DEPLOY_BLOCK - 1;
  let gaps = (await redis.get(GAPS_KEY)) || [];
  if (!Array.isArray(gaps)) gaps = [];

  const errors = [];
  let added = 0;
  let advanced = false;
  let skippedLock = false;

  if (scannedTo >= latest && !gaps.length) {
    return { burns, scannedTo, gaps, added, advanced, skippedLock, errors };
  }

  const gotLock = await redis.set(LOCK_KEY, "1", { nx: true, ex: lockTtlSec });
  if (!gotLock) {
    skippedLock = true;
    return { burns, scannedTo, gaps, added, advanced, skippedLock, errors };
  }

  try {
    const beforeCount = burns.length;
    const remaining = [];
    for (const gap of gaps) {
      const from = Number(gap.from);
      const to = Number(gap.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
      try {
        const recovered = await scanRange(from, to);
        burns = mergeBurns(burns, recovered);
      } catch (gapErr) {
        remaining.push({ from, to });
        errors.push(`gap ${from}-${to}: ${gapErr.message || gapErr}`);
      }
    }
    gaps = remaining;

    if (scannedTo < latest) {
      try {
        const newBurns = await scanRange(scannedTo + 1, latest);
        burns = mergeBurns(burns, newBurns);
        scannedTo = latest;
        advanced = true;
      } catch (scanErr) {
        gaps.push({ from: scannedTo + 1, to: latest });
        errors.push(`tip ${scannedTo + 1}-${latest}: ${scanErr.message || scanErr}`);
      }
    }

    const gapSeen = new Set();
    gaps = gaps.filter((g) => {
      const k = `${g.from}-${g.to}`;
      if (gapSeen.has(k)) return false;
      gapSeen.add(k);
      return true;
    });

    added = burns.length - beforeCount;
    await Promise.all([
      redis.set(CACHE_KEY, { burns, scannedTo, cachedAt: Date.now() }, { ex: 60 * 60 * 24 * 30 }),
      redis.set(GAPS_KEY, gaps, { ex: 60 * 60 * 24 * 30 }),
    ]);
  } finally {
    await redis.del(LOCK_KEY);
  }

  return { burns, scannedTo, gaps, added, advanced, skippedLock, errors };
}

module.exports = {
  CACHE_KEY,
  GAPS_KEY,
  LOCK_KEY,
  ATTR_KEY: "ash-ledger:attribution:v1",
  burnKey,
  mergeBurns,
  catchUpBurns,
};
