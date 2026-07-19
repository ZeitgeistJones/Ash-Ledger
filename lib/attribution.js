// Causal burn attribution: credit the project that caused a burn, not only
// Transfer.from. Totals stay the same — we only rewrite the source address.
//
// Direct burners (contract itself is Transfer.from) need no lookup.
// Causal projects (user/pool is Transfer.from, project is in the same tx)
// are resolved from a Redis tx→project map produced by attribute.mjs.
//
// Build Report: Burned(uint256) on SwapAndBurn identifies buyback txs. We
// attribute CLAWD→dead Transfers in those txs to the receiver — we do NOT
// add Burned amounts on top of Transfers (that would double-count).

const BUILD_REPORT = "0x0c1a3db07304d2e4e551ab4a7b083382a33f25ad";
const DCA_V3 = "0xdb5da5b9c55d5fc72eb19692ab41aabbc46278ac";
const CREATURE_FEATURE = "0x1c67563f968256778847407583d9e6abe1e263e7";
const CLAWD_AND_EFFECT = "0x24d4e699d5a7758ba6a943243ab9bed9e8911cff";

/** Burned(uint256) — The Build Report SwapAndBurn */
const BUILD_BURNED_TOPIC =
  "0xd83c63197e8e676d80ab0122beba9a9d20f3828839e9a1d6fe81d242e9cd7e6e";

const CAUSAL_PROJECTS = [BUILD_REPORT, CREATURE_FEATURE, DCA_V3, CLAWD_AND_EFFECT];

const CAUSAL_SET = new Set(CAUSAL_PROJECTS);

/** topic0 → project for custom burn-marker events (replace, don't add). */
const EVENT_PROJECTS = {
  [BUILD_BURNED_TOPIC]: BUILD_REPORT,
};

function normalizeAddr(addr) {
  if (!addr || typeof addr !== "string") return null;
  const a = addr.toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(a) ? a : null;
}

/** Pull every address that appears on a receipt/tx (to + log emitters + topics). */
function addressesInReceipt(receipt, tx = null) {
  const found = new Set();
  const add = (value) => {
    const a = normalizeAddr(value);
    if (a) found.add(a);
  };

  add(receipt?.to);
  add(tx?.to);
  add(tx?.from);

  for (const log of receipt?.logs || []) {
    add(log.address);
    for (const topic of log.topics || []) {
      if (typeof topic === "string" && topic.length === 66 && topic.startsWith("0x000000000000000000000000")) {
        add("0x" + topic.slice(26));
      }
    }
  }
  return found;
}

/**
 * Project from custom burn events on the receipt (e.g. Build Report Burned).
 * Checked before generic address presence so markers win when present.
 */
function projectFromEvents(receipt) {
  for (const log of receipt?.logs || []) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    const project = topic0 && EVENT_PROJECTS[topic0];
    if (!project) continue;
    const emitter = normalizeAddr(log.address);
    if (emitter === project) return project;
  }
  return null;
}

/**
 * Given a tx receipt (and optional tx body), return the causal project address
 * if this tx interacted with one.
 */
function projectFromReceipt(receipt, tx = null) {
  if (!receipt && !tx) return null;
  const fromEvent = projectFromEvents(receipt);
  if (fromEvent) return fromEvent;

  const addrs = addressesInReceipt(receipt, tx);
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

function needsResolution(attrMap, tx) {
  // Missing key → resolve. Explicit null was historically written on RPC
  // failures / before projects were added and must be retried.
  return !Object.prototype.hasOwnProperty.call(attrMap, tx) || attrMap[tx] === null;
}

/**
 * Resolve attribution for burns missing a map entry. Mutates attrMap.
 * rpc(method, params) must match ash-ledger's rpc helper.
 */
async function resolveMissingAttributions(burns, attrMap, rpc, { limit = 40, forceRetryNull = true } = {}) {
  const pending = [];
  const seen = new Set();
  for (const burn of burns) {
    const tx = burn.tx ? String(burn.tx).toLowerCase() : null;
    if (!tx || seen.has(tx)) continue;
    const rawFrom = normalizeAddr(burn.rawFrom || burn.from);
    if (CAUSAL_SET.has(rawFrom)) {
      attrMap[tx] = rawFrom;
      continue;
    }
    const missing = forceRetryNull ? needsResolution(attrMap, tx) : !Object.prototype.hasOwnProperty.call(attrMap, tx);
    if (!missing) continue;
    seen.add(tx);
    pending.push(tx);
    if (pending.length >= limit) break;
  }

  let changed = false;
  for (const tx of pending) {
    try {
      const [receipt, trx] = await Promise.all([
        rpc("eth_getTransactionReceipt", [tx]),
        rpc("eth_getTransactionByHash", [tx]),
      ]);
      if (!receipt && !trx) continue;
      const project = projectFromReceipt(receipt, trx);
      if (attrMap[tx] !== project) changed = true;
      attrMap[tx] = project;
    } catch {
      if (attrMap[tx] === null) {
        delete attrMap[tx];
        changed = true;
      }
    }
  }
  return { attrMap, changed, resolved: pending.length };
}

module.exports = {
  BUILD_REPORT,
  DCA_V3,
  CREATURE_FEATURE,
  CLAWD_AND_EFFECT,
  BUILD_BURNED_TOPIC,
  CAUSAL_PROJECTS,
  CAUSAL_SET,
  EVENT_PROJECTS,
  projectFromReceipt,
  projectFromEvents,
  addressesInReceipt,
  attributeBurns,
  resolveMissingAttributions,
  needsResolution,
};
