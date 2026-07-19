// pages/index.js
import { useEffect, useState } from "react";

function fmtClawd(weiStr) {
  const n = Number(BigInt(weiStr) / 10n ** 18n);
  return n.toLocaleString("en-US");
}
function fmtClawdShort(weiStr) {
  const n = Number(BigInt(weiStr) / 10n ** 18n);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}
function pct(part, whole) {
  const p = Number(BigInt(part)), w = Number(BigInt(whole));
  return w === 0 ? 0 : Math.round((p / w) * 100);
}
function sharePct(part, whole) {
  const p = Number(BigInt(part)), w = Number(BigInt(whole));
  if (w === 0 || p === 0) return "0";
  const n = (p / w) * 100;
  if (n > 0 && n < 0.01) return "<0.01";
  return n.toFixed(2);
}
function burnOfSupply(weiStr) {
  const CLAWD_SUPPLY = 100_000_000_000n; // original 100B mint
  const burned = BigInt(weiStr) / 10n ** 18n;
  return Number((burned * 10000n) / CLAWD_SUPPLY) / 100; // two decimals
}
function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
function sourceLabel(s) {
  return (s.name || s.project || s.addr || "").toLowerCase();
}

// Matches lib/ash-ledger DEPLOY_BLOCK; empty Redis cache defaults scannedTo to this − 1.
const DEPLOY_BLOCK = 41337394;
const EMPTY_SCAN_SENTINEL = DEPLOY_BLOCK - 1;

function SourceRows({ source, max, totalBurned, expanded, onToggle }) {
  const hasVersions = Array.isArray(source.versions) && source.versions.length > 1;
  const open = expanded && hasVersions;

  return (
    <>
      <tr className={hasVersions ? "source-row umbrella" : "source-row"}>
        <td>
          <div className="source-cell">
            <span className="source-name">
              {hasVersions && (
                <button
                  type="button"
                  className="toggle"
                  aria-expanded={open}
                  onClick={onToggle}
                >
                  {open ? "▾" : "▸"}
                </button>
              )}
              {(source.name || source.project) && (
                <>
                  {source.name || source.project}
                  {source.unconfirmed ? <span className="star">*</span> : null}
                </>
              )}
              {hasVersions && (
                <span className="version-count"> · {source.versionCount} versions</span>
              )}
            </span>
            {source.addr ? (
              <a className="source-addr" href={`https://basescan.org/address/${source.addr}`} target="_blank" rel="noopener noreferrer">{shortAddr(source.addr)}</a>
            ) : (
              <span className="source-addr">click to see version split</span>
            )}
          </div>
        </td>
        <td><span className={`tag ${source.category}`}>{source.category}{source.unconfirmed ? "*" : ""}</span></td>
        <td className="num"><span className="bar" style={{ width: Math.max(2, Number(BigInt(source.burned) * 90n / BigInt(max))) }}></span>{source.count}</td>
        <td className="num">{fmtClawd(source.burned)}</td>
        <td className="num">{sharePct(source.burned, totalBurned)}%</td>
      </tr>
      {open && source.versions.map(version => (
        <tr key={version.addr} className="source-row version">
          <td>
            <div className="source-cell nested">
              <span className="source-name">
                {version.name || shortAddr(version.addr)}
                {version.unconfirmed ? <span className="star">*</span> : null}
              </span>
              <a className="source-addr" href={`https://basescan.org/address/${version.addr}`} target="_blank" rel="noopener noreferrer">{shortAddr(version.addr)}</a>
            </div>
          </td>
          <td><span className={`tag ${version.category}`}>{version.category}{version.unconfirmed ? "*" : ""}</span></td>
          <td className="num">{version.count}</td>
          <td className="num">{fmtClawd(version.burned)}</td>
          <td className="num">{sharePct(version.burned, totalBurned)}%</td>
        </tr>
      ))}
    </>
  );
}

export default function Home() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [cats, setCats] = useState({ clawdbotatg: true, community: true, unlabeled: true });
  const [sort, setSort] = useState({ key: "burned", dir: "desc" });

  const load = () => {
    setErr(null);
    fetch("/api/stats")
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setErr(e.message || String(e)));
  };
  useEffect(load, []);

  const toggle = (key) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleCat = (cat) => {
    setCats(prev => {
      const next = { ...prev, [cat]: !prev[cat] };
      // Keep at least one category on so the table never goes blank by accident.
      if (!next.clawdbotatg && !next.community && !next.unlabeled) return prev;
      return next;
    });
  };

  const clickSort = (key) => {
    setSort(prev => {
      if (prev.key === key) return { key, dir: prev.dir === "desc" ? "asc" : "desc" };
      return { key, dir: key === "name" ? "asc" : "desc" };
    });
  };

  const sortMark = (key) => {
    if (sort.key !== key) return "";
    return sort.dir === "asc" ? " ↑" : " ↓";
  };

  return (
    <>
      <style>{`
        :root{ --char:#0F0C09; --soot:#1B1611; --soot-edge:#2A231B; --ash:#E9E1D3; --ember:#FF5A1F; --flame:#FFB347; --cold:#6E655A; }
        *{box-sizing:border-box;margin:0;padding:0}
        html,body{background:var(--char)}
        body{ font-family:'IBM Plex Mono',monospace; color:var(--ash); min-height:100vh; padding:0 clamp(16px,4vw,56px) 80px; }
        a{color:var(--flame);text-decoration:none} a:hover{text-decoration:underline}
        header{ padding:40px 0 28px;border-bottom:1px solid var(--soot-edge); }
        .eyebrow{ font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--cold); margin-bottom:10px; }
        h1{ font-family:'Anton',sans-serif;font-weight:400; font-size:clamp(40px,7vw,84px);line-height:.95;letter-spacing:.01em; text-transform:uppercase;color:var(--ash); }
        h1 .lit{color:var(--ember)}
        .tiles{ display:grid;grid-template-columns:repeat(3,1fr);gap:1px; background:var(--soot-edge);border:1px solid var(--soot-edge);margin-top:28px; }
        @media (max-width:760px){ .tiles{grid-template-columns:1fr} }
        .tile{background:var(--soot);padding:22px 20px 18px}
        .tile .label{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--cold);margin-bottom:12px}
        .tile .value{ font-family:'Anton',sans-serif;font-size:clamp(30px,4.5vw,52px); line-height:1;color:var(--ash); }
        .tile .value.hot{color:var(--ember)}
        .tile .sub{font-size:11px;color:var(--cold);margin-top:8px}
        section{margin-top:56px}
        h2{ font-family:'Anton',sans-serif;font-weight:400;font-size:clamp(20px,2.6vw,28px); text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px; }
        .section-note{font-size:12px;color:var(--cold);margin-bottom:20px}
        .split-bar{ display:flex;height:36px;border:1px solid var(--soot-edge);overflow:hidden;margin-bottom:14px; }
        .split-seg{display:flex;align-items:center;justify-content:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--char);font-weight:600}
        .split-legend{display:flex;flex-wrap:wrap;gap:20px;font-size:12px;color:var(--cold)}
        .split-legend .dot{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:middle}
        table{width:100%;border-collapse:collapse;font-size:12.5px}
        th{ text-align:left;font-weight:500;font-size:11px;letter-spacing:.2em; text-transform:uppercase;color:var(--cold);padding:10px 14px 10px 0; border-bottom:1px solid var(--soot-edge); }
        th.sortable{cursor:pointer;user-select:none}
        th.sortable:hover{color:var(--ash)}
        th.sortable.active{color:var(--flame)}
        td{padding:11px 14px 11px 0;border-bottom:1px solid var(--soot-edge);vertical-align:baseline;white-space:nowrap}
        td.num,th.num{text-align:right;padding-right:0}
        .source-cell{display:flex;flex-direction:column;gap:4px}
        .source-cell.nested{padding-left:22px}
        .source-name{color:var(--ash);display:inline-flex;align-items:center;gap:6px}
        .source-name .star{color:var(--flame)}
        .source-addr{font-size:11px;color:var(--cold)}
        .version-count{font-size:11px;color:var(--cold);font-weight:400}
        .toggle{ background:none;border:none;color:var(--flame);cursor:pointer;font:inherit;padding:0 2px;line-height:1; }
        .filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
        .filter{ font:inherit;font-size:11px;letter-spacing:.08em;text-transform:uppercase; padding:6px 12px;cursor:pointer;background:transparent;border:1px solid var(--soot-edge);color:var(--cold); }
        .filter.on.clawdbotatg{color:var(--ember);border-color:var(--ember)}
        .filter.on.community{color:var(--flame);border-color:var(--flame)}
        .filter.on.unlabeled{color:var(--ash);border-color:var(--cold)}
        tr.version td{background:rgba(255,255,255,.02);color:var(--cold)}
        tr.version .source-name{color:var(--ash)}
        .footnote{font-size:11px;color:var(--cold);margin-top:14px}
        .empty-filter{padding:28px 0;color:var(--cold);font-size:12px}
        .table-scroll{overflow-x:auto}
        .bar{display:inline-block;height:8px;background:var(--ember);vertical-align:middle;margin-right:10px;min-width:2px}
        .tag{ font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border:1px solid var(--soot-edge); }
        .tag.clawdbotatg{color:var(--ember);border-color:var(--ember)}
        .tag.community{color:var(--flame);border-color:var(--flame)}
        .tag.unlabeled{color:var(--cold)}
        footer{ margin-top:72px;padding-top:24px;border-top:1px solid var(--soot-edge); display:flex;flex-wrap:wrap;gap:8px 32px;font-size:12px;color:var(--cold); }
        .banner{ margin-top:28px;padding:16px 18px;border:1px solid var(--ember);background:var(--soot);font-size:13px;line-height:1.55;color:var(--ash); }
        .banner strong{color:var(--ember);font-weight:500;letter-spacing:.06em;text-transform:uppercase;font-size:11px;display:block;margin-bottom:6px; }
        .loading,.error{padding:60px 0;text-align:center;color:var(--cold);font-size:13px}
        .error button{ margin-top:16px;font-family:inherit;font-size:13px;letter-spacing:.1em;text-transform:uppercase; background:none;border:1px solid var(--ember);color:var(--ember);padding:12px 28px;cursor:pointer; }
      `}</style>

      <header>
        <div className="eyebrow">$clawd &middot; every burn, every source &middot; base mainnet</div>
        <h1>Ash <span className="lit">Ledger</span></h1>
      </header>

      {!data && !err && <div className="loading">counting the ashes…</div>}
      {err && (
        <div className="error">
          couldn't load stats ({err})
          <br />
          <button onClick={load}>retry</button>
        </div>
      )}

      {data && (() => {
        const behindBy = data.latestBlock != null ? data.latestBlock - data.scannedTo : 0;
        const cacheUnseeded = data.scannedTo === EMPTY_SCAN_SENTINEL;
        const farBehind = behindBy > 100_000;
        const filtered = data.sources.filter(s => cats[s.category]);
        const sorted = [...filtered].sort((a, b) => {
          let cmp = 0;
          if (sort.key === "name") {
            cmp = sourceLabel(a).localeCompare(sourceLabel(b));
          } else if (sort.key === "count") {
            cmp = a.count - b.count;
          } else {
            const ab = BigInt(a.burned), bb = BigInt(b.burned);
            cmp = ab > bb ? 1 : ab < bb ? -1 : 0;
          }
          return sort.dir === "asc" ? cmp : -cmp;
        });
        let maxBurned = 0n;
        for (const s of filtered) {
          const b = BigInt(s.burned);
          if (b > maxBurned) maxBurned = b;
        }
        const max = maxBurned === 0n ? "1" : maxBurned.toString();
        return (
        <div>
          {(cacheUnseeded || farBehind) && (
            <div className="banner">
              <strong>{cacheUnseeded ? "Cache not seeded" : "Scan behind tip"}</strong>
              {cacheUnseeded
                ? "Burn history has not been written to Redis yet. The block below is the empty-cache default, not a completed scan. Run seed.mjs locally (see README), then reload."
                : `Indexer is ${(behindBy).toLocaleString()} blocks behind the chain tip. Totals may be incomplete until it catches up.`}
            </div>
          )}
          <div className="tiles">
            <div className="tile">
              <div className="label">Total burned</div>
              <div className="value hot">{fmtClawdShort(data.totalBurned)}</div>
              <div className="sub">{fmtClawd(data.totalBurned)} CLAWD · {burnOfSupply(data.totalBurned).toFixed(2)}% of 100B supply, gone forever</div>
            </div>
            <div className="tile">
              <div className="label">Burn events</div>
              <div className="value">{data.totalBurns}</div>
              <div className="sub">unique on-chain transactions across {data.uniqueSources} sources</div>
            </div>
            <div className="tile">
              <div className="label">Unlabeled</div>
              <div className="value">{pct(data.byCategory.unlabeled, data.totalBurned)}%</div>
              <div className="sub">{fmtClawdShort(data.byCategory.unlabeled)} not yet categorized</div>
            </div>
          </div>

          <section>
            <h2>Community vs. clawdbotatg</h2>
            <div className="section-note">Which burns came from official clawdbotatg-built contracts vs. independent community tools.</div>
            <div className="split-bar">
              {["clawdbotatg", "community", "unlabeled"].map(cat => {
                const p = pct(data.byCategory[cat], data.totalBurned);
                if (p === 0) return null;
                const bg = cat === "clawdbotatg" ? "var(--ember)" : cat === "community" ? "var(--flame)" : "var(--soot-edge)";
                return <div key={cat} className="split-seg" style={{ width: p + "%", background: bg }}>{p >= 8 ? p + "%" : ""}</div>;
              })}
            </div>
            <div className="split-legend">
              <span><span className="dot" style={{ background: "var(--ember)" }}></span>clawdbotatg — {fmtClawdShort(data.byCategory.clawdbotatg)}</span>
              <span><span className="dot" style={{ background: "var(--flame)" }}></span>community — {fmtClawdShort(data.byCategory.community)}</span>
              <span><span className="dot" style={{ background: "var(--soot-edge)" }}></span>unlabeled — {fmtClawdShort(data.byCategory.unlabeled)}</span>
            </div>
          </section>

          <section>
            <h2>Sources</h2>
            <div className="section-note">Projects that caused CLAWD burns. Burns = unique transactions. Multi-version products are grouped — expand to see each contract.</div>
            <div className="filters" role="group" aria-label="Filter by category">
              {["clawdbotatg", "community", "unlabeled"].map(cat => (
                <button
                  key={cat}
                  type="button"
                  className={`filter ${cat}${cats[cat] ? " on" : ""}`}
                  aria-pressed={cats[cat]}
                  onClick={() => toggleCat(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className={`sortable${sort.key === "name" ? " active" : ""}`} onClick={() => clickSort("name")}>Source{sortMark("name")}</th>
                    <th>Category</th>
                    <th className={`num sortable${sort.key === "count" ? " active" : ""}`} onClick={() => clickSort("count")}>Burns{sortMark("count")}</th>
                    <th className={`num sortable${sort.key === "burned" ? " active" : ""}`} onClick={() => clickSort("burned")}>CLAWD burned{sortMark("burned")}</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s) => {
                    const key = s.project || s.name || s.addr;
                    return (
                      <SourceRows
                        key={key}
                        source={s}
                        max={max}
                        totalBurned={data.totalBurned}
                        expanded={!!expanded[key]}
                        onToggle={() => toggle(key)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
            {sorted.length === 0 && (
              <div className="empty-filter">No sources in the selected categories.</div>
            )}
            {data.sources.some(s => s.unconfirmed || s.versions?.some(v => v.unconfirmed)) && (
              <div className="footnote">* researched suggestion — not yet confirmed in /admin</div>
            )}
          </section>

          <footer>
            <span>token <a href={`https://basescan.org/token/${"0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07"}`} target="_blank" rel="noopener noreferrer">$CLAWD</a></span>
            <span>watches transfers to both burn destinations: dead address &amp; address(0)</span>
            <span>
              scanned through block {data.scannedTo?.toLocaleString()}
              {data.latestBlock != null && (
                <> · tip {data.latestBlock.toLocaleString()}</>
              )}
            </span>
          </footer>
        </div>
        );
      })()}
    </>
  );
}
