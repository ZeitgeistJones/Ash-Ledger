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
  "0x90c14763fb2a372f186cbb3bfe8a1ed81f90623e": {
    name: "ClawdWorks V2",
    category: "community",
    note: "CLAWD services marketplace; 80% seller / 10% burn / 10% treasury",
  },
  "0x0c1a3db07304d2e4e551ab4a7b083382a33f25ad": {
    name: "The Build Report",
    category: "community",
    note: "Buy-and-burn receiver (SwapAndBurn); CLAWD→dead in its txs attributed here",
  },
  "0xa16095e72936ad6dab012ec1b95222f6fcb5f5c2": {
    name: "CLAWD DCA v2",
    category: "community",
    note: "Legacy CLAWD DCA; executeBurn() sends CLAWD to dead",
  },
  "0x1c67563f968256778847407583d9e6abe1e263e7": {
    name: "Creature Feature",
    category: "community",
    note: "Clawd Search KOTH; user→dead burns inside its txs attributed here",
  },
  "0xdb5da5b9c55d5fc72eb19692ab41aabbc46278ac": {
    name: "CLAWD DCA v3",
    category: "community",
    note: "Current CLAWD DCA; pool→dead burns inside its txs attributed here",
  },
};
