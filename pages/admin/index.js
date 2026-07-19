import Head from "next/head";
import { useState } from "react";

function fmtClawd(weiStr) {
  const value = Number(BigInt(weiStr) / 10n ** 18n);
  return value.toLocaleString("en-US");
}

function shortAddr(address) {
  return address.slice(0, 8) + "…" + address.slice(-6);
}

function Candidate({ candidate, password, onReviewed }) {
  const [name, setName] = useState(candidate.suggestedName || "");
  const [category, setCategory] = useState(candidate.suggestedCategory || "clawdbotatg");
  const [note, setNote] = useState(candidate.evidence || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(action) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          action,
          address: candidate.addr,
          name,
          category,
          note,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "request failed");
      onReviewed(candidate.addr);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="candidate">
      <div className="candidate-head">
        <div>
          <a href={`https://basescan.org/address/${candidate.addr}`} target="_blank" rel="noopener noreferrer">
            {shortAddr(candidate.addr)}
          </a>
          <div className="metrics">
            {candidate.count.toLocaleString()} burns · {fmtClawd(candidate.burned)} CLAWD
          </div>
        </div>
        <div className="blocks">blocks {candidate.first.toLocaleString()}–{candidate.last.toLocaleString()}</div>
      </div>

      {candidate.evidence && (
        <div className="evidence">
          <strong>Suggested evidence</strong>
          {candidate.evidence}
          {candidate.evidenceUrl && (
            <> · <a href={candidate.evidenceUrl} target="_blank" rel="noopener noreferrer">source</a></>
          )}
        </div>
      )}

      <div className="fields">
        <label>
          Name
          <input value={name} onChange={event => setName(event.target.value)} placeholder="Contract or product name" />
        </label>
        <label>
          Category
          <select value={category} onChange={event => setCategory(event.target.value)}>
            <option value="clawdbotatg">clawdbotatg</option>
            <option value="community">community</option>
          </select>
        </label>
        <label className="note">
          Review note
          <input value={note} onChange={event => setNote(event.target.value)} placeholder="Why this label is correct" />
        </label>
      </div>

      {error && <div className="row-error">{error}</div>}
      <div className="actions">
        <button className="approve" disabled={busy || !name.trim()} onClick={() => decide("approve")}>
          {busy ? "Working…" : "Approve"}
        </button>
        <button className="reject" disabled={busy} onClick={() => decide("reject")}>Reject</button>
      </div>
    </article>
  );
}

export default function AdminReview() {
  const [password, setPassword] = useState("");
  const [candidates, setCandidates] = useState(null);
  const [scannedTo, setScannedTo] = useState(null);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(event) {
    event?.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, action: "list" }),
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "request failed");
      setCandidates(result.candidates);
      setScannedTo(result.scannedTo);
      setRejectedCount(result.rejectedCount || 0);
    } catch (err) {
      setCandidates(null);
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  function removeReviewed(address) {
    setCandidates(current => current.filter(candidate => candidate.addr !== address));
  }

  return (
    <>
      <Head>
        <title>Source Review · Ash Ledger</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <style>{`
        :root{--char:#0F0C09;--soot:#1B1611;--soot-edge:#2A231B;--ash:#E9E1D3;--ember:#FF5A1F;--flame:#FFB347;--cold:#6E655A}
        *{box-sizing:border-box}
        html,body{margin:0;background:var(--char);color:var(--ash);font-family:'IBM Plex Mono',monospace}
        main{max-width:1100px;margin:0 auto;padding:42px clamp(16px,4vw,48px) 80px}
        .eyebrow{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--cold)}
        h1{font-family:'Anton',sans-serif;font-weight:400;font-size:clamp(36px,6vw,68px);line-height:1;margin:12px 0 8px;text-transform:uppercase}
        h1 span{color:var(--ember)}
        .intro{color:var(--cold);font-size:12px;line-height:1.6;max-width:760px}
        a{color:var(--flame);text-decoration:none}a:hover{text-decoration:underline}
        .login{display:flex;gap:10px;margin-top:32px;max-width:600px}
        input,select,button{font:inherit}
        input,select{width:100%;border:1px solid var(--soot-edge);background:var(--soot);color:var(--ash);padding:11px 12px;outline:none}
        input:focus,select:focus{border-color:var(--flame)}
        button{border:1px solid var(--soot-edge);background:none;color:var(--ash);padding:10px 18px;cursor:pointer;text-transform:uppercase;letter-spacing:.08em;font-size:11px}
        button:disabled{opacity:.45;cursor:not-allowed}
        .unlock,.approve{border-color:var(--ember);color:var(--ember)}
        .summary{display:flex;flex-wrap:wrap;gap:10px 28px;margin:36px 0 18px;padding:14px 0;border-bottom:1px solid var(--soot-edge);font-size:12px;color:var(--cold)}
        .candidate{border:1px solid var(--soot-edge);background:var(--soot);padding:18px;margin-top:12px}
        .candidate-head{display:flex;justify-content:space-between;gap:16px}
        .metrics,.blocks{font-size:11px;color:var(--cold);margin-top:6px}
        .evidence{font-size:12px;line-height:1.55;margin-top:16px;padding:12px;border-left:2px solid var(--flame);background:var(--char)}
        .evidence strong{display:block;color:var(--flame);font-size:10px;text-transform:uppercase;letter-spacing:.12em;margin-bottom:5px}
        .fields{display:grid;grid-template-columns:1.2fr .8fr;gap:12px;margin-top:16px}
        .fields label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--cold)}
        .fields input,.fields select{margin-top:6px;text-transform:none;letter-spacing:normal}
        .fields .note{grid-column:1/-1}
        .actions{display:flex;gap:10px;margin-top:14px}
        .reject{color:var(--cold)}
        .error,.row-error{color:var(--ember);font-size:12px;margin-top:12px}
        .empty{margin-top:36px;color:var(--cold);font-size:13px}
        @media(max-width:650px){.login{flex-direction:column}.candidate-head{flex-direction:column}.fields{grid-template-columns:1fr}.fields .note{grid-column:auto}}
      `}</style>
      <main>
        <div className="eyebrow">Ash Ledger · private</div>
        <h1>Source <span>Review</span></h1>
        <p className="intro">
          Unlabeled burners stay out of the public source table until you approve them here.
          Approval updates the taxonomy immediately; no chain rescan is needed.
        </p>

        <form className="login" onSubmit={load}>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            placeholder="ADMIN_SECRET"
            aria-label="Admin password"
          />
          <button className="unlock" type="submit" disabled={loading || !password}>
            {loading ? "Loading…" : candidates ? "Refresh" : "Unlock"}
          </button>
        </form>
        {error && <div className="error">{error}</div>}

        {candidates && (
          <>
            <div className="summary">
              <span>{candidates.length.toLocaleString()} pending sources</span>
              <span>{rejectedCount.toLocaleString()} rejected</span>
              {scannedTo && <span>cache through block {scannedTo.toLocaleString()}</span>}
            </div>
            {candidates.map(candidate => (
              <Candidate
                key={candidate.addr}
                candidate={candidate}
                password={password}
                onReviewed={removeReviewed}
              />
            ))}
            {candidates.length === 0 && <div className="empty">Nothing waiting for review.</div>}
          </>
        )}
      </main>
    </>
  );
}
