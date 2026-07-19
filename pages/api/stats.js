// pages/api/stats.js
//
// Same incremental-cache pattern as Furnace Log: scan once, cache in Upstash,
// only scan NEW blocks on subsequent requests. Registry overrides (from the
// admin endpoint) are stored separately and merged in at read time, so
// relabeling never requires a rescan. Causal attribution rebuckets Transfer.from
// to the project that caused the burn without changing totals.

import { Redis } from "@upstash/redis";
import { DEPLOY_BLOCK, rpc, scanRange, analyze } from "../../lib/ash-ledger";
import { attributeBurns, resolveMissingAttributions } from "../../lib/attribution";
import { groupSources } from "../../lib/projects";
import baseRegistry from "../../lib/registry";
import baseCandidates from "../../lib/candidates";

const redis = Redis.fromEnv();
const CACHE_KEY = "ash-ledger:burns:v1";
const GAPS_KEY = "ash-ledger:scan-gaps:v1";
const OVERRIDES_KEY = "ash-ledger:registry-overrides:v1";
const CANDIDATES_KEY = "ash-ledger:label-candidates:v1";
const ATTR_KEY = "ash-ledger:attribution:v1";
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

export default async function handler(req, res) {
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);

    let cached = await redis.get(CACHE_KEY);
    let burns = cached?.burns || [];
    let scannedTo = cached?.scannedTo || DEPLOY_BLOCK - 1;
    let gaps = (await redis.get(GAPS_KEY)) || [];
    if (!Array.isArray(gaps)) gaps = [];

    // Incremental catch-up. Never advance scannedTo past a failed range.
    // Soft-fail the HTTP response (serve cache) but persist gaps for retry.
    if (scannedTo < latest || gaps.length) {
      const gotLock = await redis.set(LOCK_KEY, "1", { nx: true, ex: 30 });
      if (gotLock) {
        try {
          // Retry previously failed ranges before claiming new tip progress.
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
              console.warn("scan gap retry failed:", from, to, gapErr.message || gapErr);
            }
          }
          gaps = remaining;

          if (scannedTo < latest) {
            try {
              const newBurns = await scanRange(scannedTo + 1, latest);
              burns = mergeBurns(burns, newBurns);
              scannedTo = latest;
            } catch (scanErr) {
              // Do NOT advance scannedTo — record the failed window for retry.
              gaps.push({ from: scannedTo + 1, to: latest });
              console.warn("incremental scan failed, serving cache:", scanErr.message || scanErr);
            }
          }

          // Dedupe gap list
          const gapSeen = new Set();
          gaps = gaps.filter((g) => {
            const k = `${g.from}-${g.to}`;
            if (gapSeen.has(k)) return false;
            gapSeen.add(k);
            return true;
          });

          await Promise.all([
            redis.set(CACHE_KEY, { burns, scannedTo, cachedAt: Date.now() }, { ex: 60 * 60 * 24 * 30 }),
            redis.set(GAPS_KEY, gaps, { ex: 60 * 60 * 24 * 30 }),
          ]);
        } finally {
          await redis.del(LOCK_KEY);
        }
      }
    }

    // Registry + overrides are confirmed. Soft-apply researched candidates so the
    // public table can show names/categories with an asterisk until /admin confirms.
    const [overrides, reviews, attrCached] = await Promise.all([
      redis.get(OVERRIDES_KEY),
      redis.get(CANDIDATES_KEY),
      redis.get(ATTR_KEY),
    ]);
    const registry = { ...baseRegistry, ...(overrides || {}) };
    const reviewMap = reviews || {};
    const unconfirmed = {};

    for (const [addr, candidate] of Object.entries(baseCandidates)) {
      if (registry[addr]) continue;
      if (reviewMap[addr]?.status === "rejected") continue;
      if (!candidate?.suggestedName || !candidate?.suggestedCategory) continue;
      unconfirmed[addr] = true;
      registry[addr] = {
        name: candidate.suggestedName,
        project: candidate.project || candidate.suggestedName,
        category: candidate.suggestedCategory,
        note: candidate.evidence || null,
      };
    }

    // Causal attribution: rebucket Transfer.from → project that caused the burn.
    const attrMap = { ...(attrCached || {}) };
    const { changed } = await resolveMissingAttributions(burns, attrMap, rpc, { limit: 25 });
    if (changed) {
      redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 }).catch(() => {});
    }
    const attributed = attributeBurns(burns, attrMap);

    const result = analyze(attributed, registry);
    const flatSources = result.sources.map(source => ({
      ...source,
      unconfirmed: !!unconfirmed[source.addr],
    }));
    // Umbrella projects (e.g. Claw Fomo) with expandable version rows.
    result.sources = groupSources(flatSources, registry);
    result.scannedTo = scannedTo;
    result.latestBlock = latest;

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
