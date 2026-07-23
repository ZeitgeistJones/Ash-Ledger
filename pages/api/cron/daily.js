// Daily updater — Vercel Cron hits this once per day to catch the burn cache
// up to chain tip, retry scan gaps, and resolve a larger batch of attributions.
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel sets this automatically when
// CRON_SECRET is configured), or ?secret= for manual runs.

import { Redis } from "@upstash/redis";
import { rpc } from "../../../lib/ash-ledger";
import { resolveMissingAttributions } from "../../../lib/attribution";
import { catchUpBurns, ATTR_KEY, CRON_MAX_BLOCKS } from "../../../lib/catch-up";

export const config = {
  maxDuration: 60,
};

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Allow in non-production so local `curl` works without extra setup.
    return process.env.NODE_ENV !== "production";
  }
  const header = req.headers.authorization || "";
  if (header === `Bearer ${secret}`) return true;
  if (req.query?.secret === secret) return true;
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const started = Date.now();
  try {
    const redis = Redis.fromEnv();
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);

    // Bigger bite than per-visit stats (still capped — Furnace-style).
    const catchUp = await catchUpBurns(redis, latest, {
      lockTtlSec: 55,
      maxBlocks: CRON_MAX_BLOCKS,
    });

    const attrMap = { ...((await redis.get(ATTR_KEY)) || {}) };
    const { changed, resolved } = await resolveMissingAttributions(
      catchUp.burns,
      attrMap,
      rpc,
      { limit: 200 }
    );
    if (changed) {
      await redis.set(ATTR_KEY, attrMap, { ex: 60 * 60 * 24 * 30 });
    }

    return res.status(200).json({
      ok: true,
      latestBlock: latest,
      scannedTo: catchUp.scannedTo,
      behindBy: catchUp.behindBy,
      capped: catchUp.capped,
      burnsAdded: catchUp.added,
      advanced: catchUp.advanced,
      skippedLock: catchUp.skippedLock,
      openGaps: catchUp.gaps.length,
      attributionsResolved: resolved || 0,
      attributionsChanged: !!changed,
      scanErrors: catchUp.errors.slice(0, 5),
      durationMs: Date.now() - started,
    });
  } catch (e) {
    console.error("daily cron failed:", e);
    return res.status(500).json({
      ok: false,
      error: e.message || String(e),
      durationMs: Date.now() - started,
    });
  }
}
