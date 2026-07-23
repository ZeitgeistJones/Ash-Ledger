// Shared incremental burn catch-up for /api/stats and the daily cron.
//
// Furnace Log freshness model:
// - Redis holds every past burn + watermark "scanned through block X"
// - Each request only scans a CAP of new blocks (not tip-in-one-go)
// - Sequential public-RPC getLogs (see lib/ash-ledger.js)
// - Never advance X past a failed range; persist gaps for retry
// - Save after each successful sub-bite so a mid-pass flake keeps progress

const { DEPLOY_BLOCK, scanRange } = require("./ash-ledger");

const CACHE_KEY = "ash-ledger:burns:v1";
const GAPS_KEY = "ash-ledger:scan-gaps:v1";
const LOCK_KEY = "ash-ledger:scanlock:v1";

/** Per /api/stats visit — small enough for serverless to finish + save. */
const DEFAULT_MAX_BLOCKS = 80_000;
/** Inner save cadence within a pass. */
const SUB_BITE = 10_000;
/** Daily cron can chew a bigger bite. */
const CRON_MAX_BLOCKS = 200_000;

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

function dedupeGaps(gaps) {
  const gapSeen = new Set();
  return gaps.filter((g) => {
    const k = `${g.from}-${g.to}`;
    if (gapSeen.has(k)) return false;
    gapSeen.add(k);
    return true;
  });
}

async function persist(redis, burns, scannedTo, gaps) {
  await Promise.all([
    redis.set(CACHE_KEY, { burns, scannedTo, cachedAt: Date.now() }, { ex: 60 * 60 * 24 * 30 }),
    redis.set(GAPS_KEY, gaps, { ex: 60 * 60 * 24 * 30 }),
  ]);
}

/**
 * Catch Redis burn cache toward `latest`, capped like Furnace Log.
 * @param {object} redis Upstash Redis client
 * @param {number} latest chain tip
 * @param {{ lockTtlSec?: number, maxBlocks?: number, subBite?: number }} [opts]
 */
async function catchUpBurns(redis, latest, opts = {}) {
  const lockTtlSec = opts.lockTtlSec ?? 30;
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const subBite = opts.subBite ?? SUB_BITE;

  const cached = await redis.get(CACHE_KEY);
  let burns = cached?.burns || [];
  let scannedTo = cached?.scannedTo || DEPLOY_BLOCK - 1;
  let gaps = (await redis.get(GAPS_KEY)) || [];
  if (!Array.isArray(gaps)) gaps = [];

  const errors = [];
  let added = 0;
  let advanced = false;
  let skippedLock = false;
  const beforeCount = burns.length;
  const behindBefore = Math.max(0, latest - scannedTo);

  if (scannedTo >= latest && !gaps.length) {
    return {
      burns, scannedTo, gaps, added, advanced, skippedLock, errors,
      behindBy: 0, capped: false,
    };
  }

  const gotLock = await redis.set(LOCK_KEY, "1", { nx: true, ex: lockTtlSec });
  if (!gotLock) {
    skippedLock = true;
    return {
      burns, scannedTo, gaps, added, advanced, skippedLock, errors,
      behindBy: behindBefore, capped: scannedTo < latest,
    };
  }

  try {
    let budget = maxBlocks;

    // 1) Retry failed ranges first (capped sub-bites).
    const remaining = [];
    for (let gi = 0; gi < gaps.length; gi++) {
      if (budget <= 0) {
        remaining.push(...gaps.slice(gi));
        break;
      }

      let from = Number(gaps[gi].from);
      const to = Number(gaps[gi].to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;

      let failed = false;
      while (from <= to && budget > 0) {
        const span = Math.min(subBite, budget, to - from + 1);
        const end = from + span - 1;
        try {
          const recovered = await scanRange(from, end);
          burns = mergeBurns(burns, recovered);
          budget -= span;
          from = end + 1;
          const still = from <= to ? [{ from, to }] : [];
          gaps = dedupeGaps([...remaining, ...still, ...gaps.slice(gi + 1)]);
          await persist(redis, burns, scannedTo, gaps);
        } catch (gapErr) {
          remaining.push({ from, to });
          remaining.push(...gaps.slice(gi + 1));
          errors.push(`gap ${from}-${end}: ${gapErr.message || gapErr}`);
          failed = true;
          break;
        }
      }
      if (failed) break;
      if (from <= to) remaining.push({ from, to });
    }
    gaps = dedupeGaps(remaining);

    // 2) Tip catch-up in sub-bites; watermark advances only after each success.
    while (budget > 0 && scannedTo < latest) {
      const span = Math.min(subBite, budget, latest - scannedTo);
      const end = scannedTo + span;
      try {
        const newBurns = await scanRange(scannedTo + 1, end);
        burns = mergeBurns(burns, newBurns);
        scannedTo = end;
        budget -= span;
        advanced = true;
        gaps = dedupeGaps(gaps);
        await persist(redis, burns, scannedTo, gaps);
      } catch (scanErr) {
        gaps = dedupeGaps([...gaps, { from: scannedTo + 1, to: end }]);
        errors.push(`tip ${scannedTo + 1}-${end}: ${scanErr.message || scanErr}`);
        await persist(redis, burns, scannedTo, gaps);
        break;
      }
    }

    added = burns.length - beforeCount;
  } finally {
    await redis.del(LOCK_KEY);
  }

  return {
    burns,
    scannedTo,
    gaps,
    added,
    advanced,
    skippedLock,
    errors,
    behindBy: Math.max(0, latest - scannedTo),
    capped: scannedTo < latest,
  };
}

module.exports = {
  CACHE_KEY,
  GAPS_KEY,
  LOCK_KEY,
  ATTR_KEY: "ash-ledger:attribution:v1",
  DEFAULT_MAX_BLOCKS,
  CRON_MAX_BLOCKS,
  SUB_BITE,
  burnKey,
  mergeBurns,
  catchUpBurns,
};
