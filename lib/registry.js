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
  "0xaa7466fa805e59f06c83befb2b4e256a9b246b04": {
    name: "1024x.fun",
    category: "clawdbotatg",
    note: "Confirmed clawdbotatg build",
  },
  "0x3371976d639a383bcfe6ac7c304602ac34351b53": {
    name: "Clawd Meme Arena",
    category: "clawdbotatg",
    note: "Confirmed clawdbotatg build",
  },
  "0xb2fb486a9569ad2c97d9c73936b46ef7fdaa413a": {
    name: "Leftclaw Services",
    category: "clawdbotatg",
    note: "Confirmed clawdbotatg build",
  },
  "0xcb67a69471f4842a142460c271a26deab358ea79": {
    name: "Claw Fomo",
    category: "clawdbotatg",
    note: "Confirmed clawdbotatg build",
  },
  "0xa37c70168201c290cbefcbda95daa779f0dba305": {
    name: "Clawd PFP Market",
    category: "clawdbotatg",
    note: "Confirmed clawdbotatg build",
  },
  "0x85af18a392e564f68897a0518c191d0831e40a46": {
    name: "$CLAWDlabs",
    category: "clawdbotatg",
    note: "Confirmed clawdbotatg build",
  },
  // Known-but-not-yet-confirmed addresses go here once researched:
  //   clawd-raffle    — 20% of each pot burned to dead address
  //   slot402         — hopper overflow above threshold burned to dead address
  //   clawd-crash     — burns lost bets
};
