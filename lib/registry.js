// lib/registry.js
//
// Manual registry mapping burn-source addresses to a name and category.
// There is no on-chain way to know "who built this" or "is this official" —
// that's a judgment call, made here, adjustable later via the admin endpoint.
//
// Anything that burns CLAWD but ISN'T in this list still gets counted in the
// totals — it just shows up bucketed as "Unlabeled" until someone adds it here.
//
// category: "clawdbotatg" | "community" | "unlabeled"

module.exports = {
  "0x536453350f2eee2eb8bfee1866baf4fca494a092": {
    name: "Incinerator",
    category: "clawdbotatg",
    note: "Public burn machine — call incinerate() every 8h, burns 10M, rewards 10K",
  },
  // Add more as they're discovered. Known-but-not-yet-confirmed addresses go here
  // once their exact contract address is looked up:
  //   clawd-raffle    — 20% of each pot burned to dead address
  //   slot402         — hopper overflow above threshold burned to dead address
  //   clawd-crash     — burns lost bets
  //   clawd-pfp-nft   — burns 10,000 CLAWD per mint from a burn treasury
};
