// pages/api/stats.js
//
// Same incremental-cache pattern as Furnace Log: scan once, cache in Upstash,
// only scan NEW blocks on subsequent requests. Registry overrides (from the
// admin endpoint) are stored separately and merged in at read time, so
// relabeling never requires a rescan.

import { Redis } from "@upstash/redis";
import { DEPLOY_BLOCK, rpc, scanRange, analyze } from "../../lib/ash-ledger";
import baseRegistry from "../../lib/registry";

const redis = Redis.fromEnv();
const CACHE_KEY = "ash-ledger:burns:v1";
const OVERRIDES_KEY = "ash-ledger:registry-overrides:v1";
const LOCK_KEY = "ash-ledger:scanlock:v1";

export default async function handler(req, res) {
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);

    let cached = await redis.get(CACHE_KEY);
    let burns = cached?.burns || [];
    let scannedTo = cached?.scannedTo || DEPLOY_BLOCK - 1;

    if (scannedTo < latest) {
      const gotLock = await redis.set(LOCK_KEY, "1", { nx: true, ex: 30 });
      if (gotLock) {
        try {
          const newBurns = await scanRange(scannedTo + 1, latest);
          burns = burns.concat(newBurns);
          scannedTo = latest;
          await redis.set(CACHE_KEY, { burns, scannedTo, cachedAt: Date.now() }, { ex: 60 * 60 * 24 * 30 });
        } finally {
          await redis.del(LOCK_KEY);
        }
      }
    }

    // Merge admin overrides on top of the baked-in registry — overrides win.
    const overrides = (await redis.get(OVERRIDES_KEY)) || {};
    const registry = { ...baseRegistry, ...overrides };

    const result = analyze(burns, registry);
    result.scannedTo = scannedTo;
    result.latestBlock = latest;

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
