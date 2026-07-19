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
function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

export default function Home() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = () => {
    setErr(null);
    fetch("/api/stats")
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setErr(e.message || String(e)));
  };
  useEffect(load, []);

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
        td{padding:11px 14px 11px 0;border-bottom:1px solid var(--soot-edge);vertical-align:baseline;white-space:nowrap}
        td.num,th.num{text-align:right;padding-right:0}
        .table-scroll{overflow-x:auto}
        .bar{display:inline-block;height:8px;background:var(--ember);vertical-align:middle;margin-right:10px;min-width:2px}
        .tag{ font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border:1px solid var(--soot-edge); }
        .tag.clawdbotatg{color:var(--ember);border-color:var(--ember)}
        .tag.community{color:var(--flame);border-color:var(--flame)}
        .tag.unlabeled{color:var(--cold)}
        footer{ margin-top:72px;padding-top:24px;border-top:1px solid var(--soot-edge); display:flex;flex-wrap:wrap;gap:8px 32px;font-size:12px;color:var(--cold); }
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

      {data && (
        <div>
          <div className="tiles">
            <div className="tile">
              <div className="label">Total burned</div>
              <div className="value hot">{fmtClawdShort(data.totalBurned)}</div>
              <div className="sub">{fmtClawd(data.totalBurned)} CLAWD, gone forever</div>
            </div>
            <div className="tile">
              <div className="label">Burn events</div>
              <div className="value">{data.totalBurns}</div>
              <div className="sub">across {data.uniqueSources} sources</div>
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
            <div className="section-note">Every contract that has ever sent CLAWD to a burn address, by amount.</div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Source</th><th>Category</th><th className="num">Burns</th><th className="num">CLAWD burned</th><th className="num">Share</th></tr></thead>
                <tbody>
                  {data.sources.map((s, i) => {
                    const max = data.sources[0].burned;
                    return (
                      <tr key={i}>
                        <td>
                          {s.name || <a href={`https://basescan.org/address/${s.addr}`} target="_blank" rel="noopener noreferrer">{shortAddr(s.addr)}</a>}
                        </td>
                        <td><span className={`tag ${s.category}`}>{s.category}</span></td>
                        <td className="num"><span className="bar" style={{ width: Math.max(2, Number(BigInt(s.burned) * 90n / BigInt(max))) }}></span>{s.count}</td>
                        <td className="num">{fmtClawd(s.burned)}</td>
                        <td className="num">{pct(s.burned, data.totalBurned)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <footer>
            <span>token <a href={`https://basescan.org/token/${"0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07"}`} target="_blank" rel="noopener noreferrer">$CLAWD</a></span>
            <span>watches transfers to both burn destinations: dead address &amp; address(0)</span>
            <span>scanned through block {data.scannedTo?.toLocaleString()}</span>
          </footer>
        </div>
      )}
    </>
  );
}
