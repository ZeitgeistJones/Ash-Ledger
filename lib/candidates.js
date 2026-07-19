// Evidence-backed label suggestions for the private admin review queue.
//
// These entries NEVER affect public stats by themselves. A suggestion only
// becomes a live label after an admin approves it, which writes an override to
// Redis. Keep addresses lowercase and include concise, verifiable evidence.

module.exports = {
  "0x859e5cb97e1cf357643a6633d5bec6d45e44cfd4": {
    suggestedName: "Claw Fomo",
    suggestedCategory: "clawdbotatg",
    evidence: "Official dashboard ClawFomo current; Blockscout verified ClawdFomo3D; leftclaw deployer; 3696 burns / ~144.5M CLAWD.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0x861e96c70a94cdebfb3fb89f3a96fe16b5e31891": {
    suggestedName: "Claw Fomo v2",
    suggestedCategory: "clawdbotatg",
    evidence: "Dashboard ClawFomo v2; Blockscout verified ClawdFomo3D; leftclaw deployer.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0x572bc6149a5a9b013b5e9c370aef6fec8388f53f": {
    suggestedName: "Claw Fomo v4",
    suggestedCategory: "clawdbotatg",
    evidence: "Dashboard ClawFomo v4; also listed as live contract in clawd-fomo3d-v2 README (clawfomo.com).",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-fomo3d-v2",
  },
  "0xd4f419065ee4b89ef8f9b2c224a9ebdee62abf54": {
    suggestedName: "Claw Fomo v5",
    suggestedCategory: "clawdbotatg",
    evidence: "Dashboard ClawFomo v5; leftclaw deployer.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0xa5cd6e15f91ae84f5513a60c398f3c5e4c43e399": {
    suggestedName: "Claw Fomo v6",
    suggestedCategory: "clawdbotatg",
    evidence: "Dashboard ClawFomo v6; leftclaw deployer.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0xef2f6d7020f4b088fee65d5369bc792d7b2f40fc": {
    suggestedName: "1024x.fun v2",
    suggestedCategory: "clawdbotatg",
    evidence: "Dashboard TenTwentyFourX v2; leftclaw deployer; 356 burns of fixed bet sizes (100–5000).",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0x6b003f883c608bdad938cd6dc3730b17ac46e196": {
    suggestedName: "1024x.fun v3",
    suggestedCategory: "clawdbotatg",
    evidence: "Dashboard TenTwentyFourX v3; leftclaw deployer; 174 burns.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0x90552946edd5a6bad7647655da6c805a188dfd25": {
    suggestedName: "Clawd Stake",
    suggestedCategory: "clawdbotatg",
    evidence: "Blockscout verified ClawdStake; dashboard current stake contract; 43×10k burns match unstake burn pattern.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0x8606551d2be495503fbf23f50bbfd307385e9bdf": {
    suggestedName: "CLAWD PFP",
    suggestedCategory: "clawdbotatg",
    evidence: "Blockscout named Clawd PFP; dashboard CLAWD PFP v2; leftclaw deployer.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0x656def27004f0c563adba9f4d02ab22583601e1c": {
    suggestedName: "Lobster Stack",
    suggestedCategory: "clawdbotatg",
    evidence: "Verified LobsterStack; official lobster-stack README contract; 20% entry burn; leftclaw deployer.",
    evidenceUrl: "https://github.com/clawdbotatg/lobster-stack",
  },
  "0x8d3547c0336149a1592472ac8d5c07c52865f801": {
    suggestedName: "Lobster Tower",
    suggestedCategory: "clawdbotatg",
    evidence: "Dashboard LobsterTower current (lobster-stack); leftclaw deployer; 60×10 burns.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0xe94b4b5a7a0a98cf9ed303a9c6d2d4ad7e5ef423": {
    suggestedName: "Clawd Meme Contest",
    suggestedCategory: "clawdbotatg",
    evidence: "Blockscout verified ClawdMemeContest; dashboard latest meme-contest; leftclaw deployer.",
    evidenceUrl: "https://github.com/clawdbotatg/clawd-dashboard",
  },
  "0x708c357d6c81b9ddc4505ee5f7f730ba83316b47": {
    suggestedName: "Clawd Meme Contest",
    suggestedCategory: "clawdbotatg",
    evidence: "Blockscout verified ClawdMemeContest; leftclaw deployer; earlier contest deploy.",
    evidenceUrl: "https://basescan.org/address/0x708c357d6c81b9ddc4505ee5f7f730ba83316b47",
  },
  "0x3ae6af15c2699ab4f39394c58cbdd829a1d31f59": {
    suggestedName: "Clawd Meme Contest",
    suggestedCategory: "clawdbotatg",
    evidence: "Blockscout verified ClawdMemeContest; leftclaw deployer.",
    evidenceUrl: "https://basescan.org/address/0x3ae6af15c2699ab4f39394c58cbdd829a1d31f59",
  },
  "0x70bcbd61a797013edc795408743325323fc2406c": {
    suggestedName: "Leftclaw Services",
    suggestedCategory: "clawdbotatg",
    evidence: "Blockscout verified LeftClawServices (earlier than confirmed V2 0xb2fb…); one 66666 burn.",
    evidenceUrl: "https://basescan.org/address/0x70bcbd61a797013edc795408743325323fc2406c#code",
  },
  "0x11ce532845ce0eacda41f72fdc1c88c335981442": {
    suggestedName: "clawdbotatg.eth",
    suggestedCategory: "clawdbotatg",
    evidence: "Official agent wallet (dashboard deployer table + BaseScan ENS); manual burns incl. 2.5M to address(0), not a dApp contract.",
    evidenceUrl: "https://basescan.org/address/0x11ce532845ce0eacda41f72fdc1c88c335981442",
  },
};
