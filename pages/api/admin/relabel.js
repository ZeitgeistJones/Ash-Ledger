// pages/api/admin/relabel.js
//
// Lets Zeitgeist adjust the community/clawdbotatg taxonomy without a redeploy.
// Gated by a plain password (ADMIN_SECRET env var) — deliberately NOT a wallet
// or private key, since this only edits a database label, not anything
// on-chain. No funds, no signing, nothing to compromise beyond "someone could
// mislabel an address" — low stakes by design.
//
// POST body: { password, address, name, category, note? }
// category must be one of: "clawdbotatg" | "community" | "unlabeled"
//
// To remove an override and fall back to the baked-in registry (or unlabeled
// if not in it), pass { password, address, remove: true }.

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const OVERRIDES_KEY = "ash-ledger:registry-overrides:v1";
const VALID_CATEGORIES = ["clawdbotatg", "community", "unlabeled"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { password, address, name, category, note, remove } = req.body || {};

  if (!process.env.ADMIN_SECRET) {
    res.status(500).json({ error: "ADMIN_SECRET not configured on the server" });
    return;
  }
  if (password !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: "wrong password" });
    return;
  }
  if (!address || typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "address must be a valid 0x... address" });
    return;
  }

  const addr = address.toLowerCase();
  const overrides = (await redis.get(OVERRIDES_KEY)) || {};

  if (remove) {
    delete overrides[addr];
    await redis.set(OVERRIDES_KEY, overrides);
    res.status(200).json({ ok: true, removed: addr });
    return;
  }

  if (!category || !VALID_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "category must be one of: " + VALID_CATEGORIES.join(", ") });
    return;
  }

  overrides[addr] = { name: name || null, category, note: note || null };
  await redis.set(OVERRIDES_KEY, overrides);
  res.status(200).json({ ok: true, updated: addr, entry: overrides[addr] });
}
