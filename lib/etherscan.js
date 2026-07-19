// Explorer client for Base: prefer Etherscan V2 when the key's plan includes
// chainid 8453; otherwise fall back to Base Blockscout (same module/action shape).
// Free Etherscan tier does not cover Base — paginate politely either way.

const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
const BLOCKSCOUT_URL = "https://base.blockscout.com/api";
const BASE_CHAIN_ID = 8453;
const DEFAULT_PAGE_DELAY_MS = 300;

let backend = null; // "etherscan-v2" | "blockscout"

function apiKey() {
  return process.env.ETHERSCAN_API_KEY || "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isFreeChainBlocked(data) {
  const msg = `${data?.message || ""} ${typeof data?.result === "string" ? data.result : ""}`;
  return /free api access is not supported for this chain/i.test(msg);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

async function pickBackend() {
  if (backend) return backend;
  const key = apiKey();
  if (key) {
    const qs = new URLSearchParams({
      chainid: String(BASE_CHAIN_ID),
      module: "proxy",
      action: "eth_blockNumber",
      apikey: key,
    });
    try {
      const data = await fetchJson(`${ETHERSCAN_V2_URL}?${qs}`);
      if (!isFreeChainBlocked(data)) {
        // proxy returns hex block in result even when status omitted
        if (typeof data.result === "string" && data.result.startsWith("0x")) {
          backend = "etherscan-v2";
          return backend;
        }
        if (String(data.status) === "1") {
          backend = "etherscan-v2";
          return backend;
        }
      }
    } catch {
      // fall through to blockscout
    }
  }
  backend = "blockscout";
  if (key) {
    console.log(
      "Etherscan V2 free plan does not include Base (8453); using Base Blockscout fallback."
    );
  } else {
    console.log("ETHERSCAN_API_KEY unset; using Base Blockscout.");
  }
  return backend;
}

/**
 * GET one explorer page. Retries on rate-limit style responses.
 */
async function explorerGet(params, { delayMs = DEFAULT_PAGE_DELAY_MS, tries = 6 } = {}) {
  const which = await pickBackend();
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (delayMs) await sleep(i === 0 ? delayMs : Math.min(2000, delayMs * (i + 1)));
    try {
      let data;
      if (which === "etherscan-v2") {
        const qs = new URLSearchParams({
          chainid: String(BASE_CHAIN_ID),
          apikey: apiKey(),
          ...params,
        });
        data = await fetchJson(`${ETHERSCAN_V2_URL}?${qs}`);
        if (isFreeChainBlocked(data)) {
          backend = "blockscout";
          console.log("Switching to Base Blockscout (Etherscan V2 rejected Base).");
          continue;
        }
      } else {
        const qs = new URLSearchParams(params);
        data = await fetchJson(`${BLOCKSCOUT_URL}?${qs}`);
      }

      const status = String(data.status ?? "");
      const message = String(data.message || "");
      const result = data.result;

      if (
        status === "0" &&
        (message.toLowerCase().includes("rate limit") ||
          (typeof result === "string" && /rate limit|max rate/i.test(result)))
      ) {
        lastErr = new Error(typeof result === "string" ? result : message);
        continue;
      }

      if (status === "0" && /no (transactions|records|data)/i.test(message)) {
        return [];
      }

      if (status === "0" && typeof result === "string") {
        throw new Error(result || message || "explorer error");
      }

      if (!Array.isArray(result)) {
        throw new Error(message || "unexpected explorer response");
      }
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("explorer failed");
}

/** @deprecated use explorerGet — kept for callers expecting etherscanGet */
const etherscanGet = explorerGet;

/**
 * Paginate account.tokentx for a token + address (from or to).
 */
async function fetchTokenTxs({
  contractAddress,
  address,
  startBlock = 0,
  endBlock = 99999999,
  pageSize = 100,
  delayMs = DEFAULT_PAGE_DELAY_MS,
  onPage,
} = {}) {
  const out = [];
  let page = 1;
  for (;;) {
    const rows = await explorerGet(
      {
        module: "account",
        action: "tokentx",
        contractaddress: contractAddress,
        address,
        startblock: String(startBlock),
        endblock: String(endBlock),
        page: String(page),
        offset: String(pageSize),
        sort: "asc",
      },
      { delayMs }
    );
    if (onPage) onPage(page, rows.length, out.length + rows.length);
    out.push(...rows);
    if (rows.length < pageSize) break;
    page++;
  }
  return out;
}

/**
 * Paginate logs.getLogs (topic filter).
 */
async function fetchLogs({
  address,
  fromBlock = 0,
  toBlock = "latest",
  topic0,
  topic1,
  topic2,
  topic0_1_opr = "and",
  topic1_2_opr = "and",
  pageSize = 1000,
  delayMs = DEFAULT_PAGE_DELAY_MS,
  onPage,
} = {}) {
  const out = [];
  let page = 1;
  for (;;) {
    const params = {
      module: "logs",
      action: "getLogs",
      address,
      fromBlock: String(fromBlock),
      toBlock: String(toBlock),
      page: String(page),
      offset: String(pageSize),
    };
    if (topic0) params.topic0 = topic0;
    if (topic1) {
      params.topic1 = topic1;
      params.topic0_1_opr = topic0_1_opr;
    }
    if (topic2) {
      params.topic2 = topic2;
      params.topic1_2_opr = topic1_2_opr;
    }
    const rows = await explorerGet(params, { delayMs });
    if (onPage) onPage(page, rows.length, out.length + rows.length);
    out.push(...rows);
    if (rows.length < pageSize) break;
    page++;
  }
  return out;
}

module.exports = {
  BASE_CHAIN_ID,
  etherscanGet,
  explorerGet,
  fetchTokenTxs,
  fetchLogs,
};
