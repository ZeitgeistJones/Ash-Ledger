// Causal burn attribution: credit the project that caused a burn, not only
// Transfer.from. Totals stay the same — we only rewrite the source address.
//
// Direct burners (contract itself is Transfer.from) need no lookup.
// Causal projects (user/pool is Transfer.from, project is in the same tx)
// are resolved from a Redis tx→project map produced by attribute.mjs.

const CAUSAL_PROJECTS = [
  "0x0c1a3db07304d2e4e551ab4a7b083382a33f25ad", // The Build Report
  "0x1c67563f968256778847407583d9e6abe1e263e7", // Creature Feature
  "0xdb5da5b9c55d5fc72eb19692ab41aabbc46278ac", // CLAWD DCA v3
];

const CAUSAL_SET = new Set(CAUSAL_PROJECTS);

function normalizeAddr(addr) {
  if (!addr || typeof addr !== "string") return null;
  return addr.toLowerCase();
}

/** Pull every address that appears on a receipt (to + log emitters). */
function addressesInReceipt(receipt) {
  const found = new Set();
  const to = normalizeAddr(receipt?.to);
  if (to) found.add(to);
  for (const log of receipt?.logs || []) {
    const a = normalizeAddr(log.address);
    if (a) found.add(a);
  }
  return found;
}

/**
 * Given a tx receipt, return the causal project address if this tx interacted
 * with one. Prefer Build Report when multiple match (unlikely).
 */
function projectFromReceipt(receipt) {
  const addrs = addressesInReceipt(receipt);
  for (const project of CAUSAL_PROJECTS) {
    if (addrs.has(project)) return project;
  }
  return null;
}

/**
 * Apply a tx→project map to burn events.
 * Preserves rawFrom (original Transfer.from) and sets from to the project
 * when the map says so.
 */
function attributeBurns(burns, attrMap = {}) {
  return burns.map(burn => {
    const rawFrom = normalizeAddr(burn.rawFrom || burn.from);
    const tx = burn.tx ? String(burn.tx).toLowerCase() : null;
    const mapped = tx && attrMap[tx] ? normalizeAddr(attrMap[tx]) : null;
    const from = mapped || rawFrom;
    return {
      ...burn,
      from,
      rawFrom,
    };
  });
}

/**
 * Resolve attribution for burns missing a map entry. Mutates attrMap.
 * rpc(method, params) must match ash-ledger's rpc helper.
 */
async function resolveMissingAttributions(burns, attrMap, rpc, { limit = 40 } = {}) {
  const pending = [];
  const seen = new Set();
  for (const burn of burns) {
    const tx = burn.tx ? String(burn.tx).toLowerCase() : null;
    if (!tx || Object.prototype.hasOwnProperty.call(attrMap, tx) || seen.has(tx)) continue;
    const rawFrom = normalizeAddr(burn.rawFrom || burn.from);
    // Skip lookups when the sender is already a known causal project (direct).
    if (CAUSAL_SET.has(rawFrom)) {
      attrMap[tx] = rawFrom;
      continue;
    }
    seen.add(tx);
    pending.push(tx);
    if (pending.length >= limit) break;
  }

  for (const tx of pending) {
    try {
      const receipt = await rpc("eth_getTransactionReceipt", [tx]);
      attrMap[tx] = projectFromReceipt(receipt);
    } catch {
      // Leave unset so a later pass / backfill can retry.
    }
  }
  return attrMap;
}

module.exports = {
  CAUSAL_PROJECTS,
  CAUSAL_SET,
  projectFromReceipt,
  attributeBurns,
  resolveMissingAttributions,
};
