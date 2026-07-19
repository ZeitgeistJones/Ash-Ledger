// Private review queue for unlabeled burn sources.
//
// Pending suggestions are deliberately separate from live registry overrides.
// A label only affects public stats after an explicit admin approval.

import { Redis } from "@upstash/redis";
import { analyze } from "../../../lib/ash-ledger";
import baseRegistry from "../../../lib/registry";
import baseCandidates from "../../../lib/candidates";

const redis = Redis.fromEnv();
const CACHE_KEY = "ash-ledger:burns:v1";
const OVERRIDES_KEY = "ash-ledger:registry-overrides:v1";
const CANDIDATES_KEY = "ash-ledger:label-candidates:v1";
const VALID_CATEGORIES = ["clawdbotatg", "community"];
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function authenticate(req, res) {
  if (!process.env.ADMIN_SECRET) {
    res.status(500).json({ error: "ADMIN_SECRET not configured on the server" });
    return false;
  }
  if (req.body?.password !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: "wrong password" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!authenticate(req, res)) return;

  const { action = "list" } = req.body || {};

  try {
    if (action === "list") {
      const [cached, overrides, reviews] = await Promise.all([
        redis.get(CACHE_KEY),
        redis.get(OVERRIDES_KEY),
        redis.get(CANDIDATES_KEY),
      ]);
      const burns = cached?.burns || [];
      const registry = { ...baseRegistry, ...(overrides || {}) };
      const result = analyze(burns, registry);
      const reviewMap = reviews || {};

      const candidates = result.sources
        .filter(source => source.category === "unlabeled")
        .filter(source => reviewMap[source.addr]?.status !== "rejected")
        .map(source => {
          const suggestion = baseCandidates[source.addr] || {};
          const review = reviewMap[source.addr] || {};
          return {
            ...source,
            status: review.status || "pending",
            suggestedName: suggestion.suggestedName || null,
            suggestedCategory: suggestion.suggestedCategory || null,
            evidence: suggestion.evidence || null,
            evidenceUrl: suggestion.evidenceUrl || null,
          };
        });

      res.status(200).json({
        candidates,
        scannedTo: cached?.scannedTo || null,
        rejectedCount: Object.values(reviewMap).filter(item => item?.status === "rejected").length,
      });
      return;
    }

    const { address, name, category, note } = req.body || {};
    if (!address || typeof address !== "string" || !ADDRESS_RE.test(address)) {
      res.status(400).json({ error: "address must be a valid 0x... address" });
      return;
    }
    const addr = address.toLowerCase();
    const reviews = (await redis.get(CANDIDATES_KEY)) || {};

    if (action === "reject") {
      reviews[addr] = {
        status: "rejected",
        reviewedAt: Date.now(),
      };
      await redis.set(CANDIDATES_KEY, reviews);
      res.status(200).json({ ok: true, rejected: addr });
      return;
    }

    if (action === "approve") {
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!VALID_CATEGORIES.includes(category)) {
        res.status(400).json({ error: "category must be clawdbotatg or community" });
        return;
      }

      const overrides = (await redis.get(OVERRIDES_KEY)) || {};
      const entry = {
        name: name.trim(),
        category,
        note: typeof note === "string" && note.trim() ? note.trim() : null,
      };
      overrides[addr] = entry;
      reviews[addr] = {
        status: "approved",
        reviewedAt: Date.now(),
      };
      await Promise.all([
        redis.set(OVERRIDES_KEY, overrides),
        redis.set(CANDIDATES_KEY, reviews),
      ]);
      res.status(200).json({ ok: true, approved: addr, entry });
      return;
    }

    res.status(400).json({ error: "action must be list, approve, or reject" });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
}
