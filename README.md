# Ash Ledger

Total CLAWD burned across the whole ecosystem, split by source and by
clawdbotatg vs. community. Watches `Transfer` events on the CLAWD token
itself where `to` is a burn destination — catches every burn mechanism
automatically, no need to track down and integrate with each contract.

## File tree
```
clawd-ash-ledger/
├── pages/
│   ├── index.js              ← the page
│   └── api/
│       ├── stats.js          ← cached aggregate endpoint
│       └── admin/
│           └── relabel.js    ← password-gated taxonomy editor
├── lib/
│   ├── ash-ledger.js         ← scan + analyze logic
│   └── registry.js           ← known burn sources, name + category
├── seed.mjs                  ← run this once locally (see below)
├── package.json
├── next.config.js
└── .gitignore
```

## Deploy steps

1. Push this whole folder to a new GitHub repo (`clawd-ash-ledger`)
2. Import into Vercel — **make sure Framework Preset is "Next.js"**, not
   "Other" (this bit us on Furnace Log — same fix if you see a
   "No Output Directory" error)
3. Add environment variables in Vercel → Settings → Environment Variables:
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (reuse the same
     Upstash database as Furnace Log, or a new one — either works)
   - `ADMIN_SECRET` — pick any password. This gates the relabel endpoint.
     Not a wallet, not a private key — just a password, since this only
     edits a label in a database, nothing on-chain.
   - `RPC_URL` — your Alchemy key, same one from Furnace Log, strongly
     recommended (public RPCs choke on the historical scan)
   - `CRON_SECRET` — any random string. Vercel Cron sends it as
     `Authorization: Bearer …` to `/api/cron/daily` (runs once daily at
     14:00 UTC via `vercel.json`)

## Before the live site will work: run the seed script

Same lesson as Furnace Log — the first-ever scan covers ~7.5M blocks
(CLAWD's whole history), which will time out inside Vercel's serverless
function. Run the seed once from your own computer first:

1. Put `seed.mjs` and `package.json` from this repo in a folder on your
   computer (can be the same `clawd-seed` folder from before, or a new one)
2. `npm install`
3. Create `.env` with the same three vars as above (Upstash + RPC_URL)
4. `node --env-file=.env seed.mjs`
5. Wait for `DONE — cache seeded.` (scans twice — once for dead-address
   burns, once for address(0) burns — so it takes a bit longer than
   Furnace Log's seed did)
6. Reload the live site

## Adjusting the taxonomy later

To relabel an address (mark it community vs. clawdbotatg, or give it a
name), call the admin endpoint — no redeploy needed:

```bash
curl -X POST https://your-site.vercel.app/api/admin/relabel \
  -H "Content-Type: application/json" \
  -d '{
    "password": "your-admin-secret",
    "address": "0x1234...",
    "name": "Some Game",
    "category": "community"
  }'
```

To remove an override and fall back to the baked-in `lib/registry.js`
entry (or "unlabeled" if it's not in there):
```bash
curl -X POST https://your-site.vercel.app/api/admin/relabel \
  -H "Content-Type: application/json" \
  -d '{ "password": "your-admin-secret", "address": "0x1234...", "remove": true }'
```

Valid `category` values: `clawdbotatg`, `community`, `unlabeled`.

## Growing the registry

`lib/registry.js` currently only has the Incinerator confirmed. As you find
more burn sources (raffle, slot402, crash, pfp-nft, others), either add them
directly to that file and redeploy, or use the admin endpoint above to add
them live without a deploy. Anything burning CLAWD that isn't in the
registry still counts in the totals — it just shows up as "unlabeled" until
tagged.
