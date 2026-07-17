import React, { useEffect, useState, useRef } from 'react';

function useReceipt(id, verify = false) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let timer = null;
    const load = () => fetch(`/api/${verify ? 'verify' : 'receipt'}/${id}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('not found')))
      .then(d => {
        setData(d);
        const anchored = verify ? d.receipt?.anchor : d.anchor;
        if (!anchored) timer = setTimeout(load, 5000); // poll until on-chain
      })
      .catch(e => setErr(e.message));
    load();
    return () => clearTimeout(timer);
  }, [id, verify]);
  return [data, err];
}

const fmtLead = ms => {
  if (ms == null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 120 ? `${Math.round(s / 60)} minutes` : `${s} seconds`;
};

export function ReceiptPage({ id }) {
  const [receipt, err] = useReceipt(id);
  const canvasRef = useRef(null);

  const download = () => {
    const c = drawShareCard(receipt);
    const a = document.createElement('a');
    a.download = `calledit-${id}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  };

  if (err) return <PageShell><div className="deck-empty">Receipt not found.</div></PageShell>;
  if (!receipt) return <PageShell><div className="loading"><div className="ball">⚽</div></div></PageShell>;
  const b = receipt.body;
  return (
    <PageShell>
      <div className="receipt glass">
        <div className="rc-stamp">I CALLED IT</div>
        <div className="rc-user">{b.user.emoji} {b.user.name}</div>
        <div className="rc-pick">“{b.pick}”</div>
        <div className="rc-q">{b.question}</div>
        <div className="rc-match">{b.match}</div>
        {b.leadTimeMs > 0 && (
          <div className="rc-lead">locked in <b>{fmtLead(b.leadTimeMs)}</b> before it happened</div>
        )}
        <div className="rc-points">+{b.points} pts{b.prob ? ` · the market said ${(b.prob * 100).toFixed(0)}%` : ''}</div>
        <div className="rc-chain">
          <div className={`rc-anchor ${receipt.anchor ? 'ok' : 'pending'}`}>
            {receipt.anchor
              ? <>⛓️ Anchored on Solana · <a href={receipt.anchor.explorer} target="_blank" rel="noreferrer">view transaction</a></>
              : '⏳ Anchoring to Solana…'}
          </div>
          <div className="rc-hash">sha256 <code>{receipt.hash.slice(0, 16)}…</code></div>
        </div>
        <div className="rc-actions">
          <button className="btn" onClick={download}>Save share card 📸</button>
          <a className="btn ghost" href={`#/verify/${id}`}>Verify the proof →</a>
        </div>
        <div className="rc-fine">Settled by TxLINE (TxODDS) — cryptographically verifiable sports data on Solana.</div>
      </div>
      <a className="back-link" href="#/">← back to the match</a>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </PageShell>
  );
}

export function VerifyPage({ id }) {
  const [data, err] = useReceipt(id, true);
  if (err) return <PageShell><div className="deck-empty">Receipt not found.</div></PageShell>;
  if (!data) return <PageShell><div className="loading"><div className="ball">⚽</div></div></PageShell>;
  const { receipt, verification } = data;
  const b = receipt.body;
  const Row = ({ ok, children }) => (
    <div className={`vf-row ${ok === null ? 'wait' : ok ? 'ok' : 'bad'}`}>
      <span className="vf-mark">{ok === null ? '⏳' : ok ? '✓' : '✗'}</span>
      <span>{children}</span>
    </div>
  );
  return (
    <PageShell>
      <div className="verify glass">
        <h2>Proof chain</h2>
        <p className="vf-intro">
          Anyone can re-run these checks — no trust in our server required.
        </p>
        <Row ok={verification.hashOk}>
          Receipt hash recomputed from the call payload: <code>{verification.recomputedHash.slice(0, 20)}…</code>
        </Row>
        <Row ok={verification.rootOk}>
          {receipt.anchor
            ? <>Hash is included in batch root <code>{receipt.anchor.root.slice(0, 20)}…</code></>
            : 'Waiting for the next Solana anchoring batch…'}
        </Row>
        <Row ok={receipt.anchor ? true : null}>
          {receipt.anchor
            ? <>Batch root committed on Solana ({receipt.anchor.slot ? `slot ${receipt.anchor.slot}` : 'confirmed'}) — <a href={receipt.anchor.explorer} target="_blank" rel="noreferrer">open in Explorer</a></>
            : 'On-chain commitment pending'}
        </Row>
        <div className="vf-payload">
          <div className="wp-title">SIGNED STATEMENT</div>
          <pre>{JSON.stringify(b, null, 2)}</pre>
        </div>
        <p className="vf-fine">
          The match data itself is TxLINE's: every score and odds update is Merkle-anchored
          on Solana by TxODDS, so the event this call was settled against is independently
          verifiable too (fixture {b.fixtureId}{b.evidence?.seq != null ? `, seq ${b.evidence.seq}` : ''}).
        </p>
      </div>
      <a className="back-link" href={`#/receipt/${id}`}>← back to receipt</a>
    </PageShell>
  );
}

function PageShell({ children }) {
  return (
    <div className="app page">
      <header className="topbar">
        <a className="logo" href="#/">CALLED<span className="logo-bolt">⚡</span>IT</a>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}

/* ---------------- share card canvas ---------------- */

function drawShareCard(receipt) {
  const b = receipt.body;
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');

  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0b1220'); g.addColorStop(0.55, '#0e1a2e'); g.addColorStop(1, '#071018');
  x.fillStyle = g; x.fillRect(0, 0, W, H);

  // glow
  const glow = x.createRadialGradient(W / 2, 430, 60, W / 2, 430, 520);
  glow.addColorStop(0, 'rgba(74,222,128,0.18)'); glow.addColorStop(1, 'rgba(74,222,128,0)');
  x.fillStyle = glow; x.fillRect(0, 0, W, H);

  x.textAlign = 'center';
  x.fillStyle = '#e7edf6';
  x.font = '700 64px "Space Grotesk", sans-serif';
  x.fillText('CALLED ⚡ IT', W / 2, 150);

  x.fillStyle = '#4ade80';
  x.font = '700 118px "Space Grotesk", sans-serif';
  x.fillText('I CALLED IT', W / 2, 400);

  x.fillStyle = '#ffffff';
  x.font = '600 58px "Space Grotesk", sans-serif';
  wrapText(x, `“${b.pick}”`, W / 2, 520, 900, 68);

  x.fillStyle = 'rgba(231,237,246,0.75)';
  x.font = '500 40px "Space Grotesk", sans-serif';
  wrapText(x, b.question, W / 2, 660, 880, 52);

  x.fillStyle = '#fbbf24';
  x.font = '700 52px "Space Grotesk", sans-serif';
  x.fillText(`+${b.points} pts`, W / 2, 800);

  if (b.leadTimeMs > 0) {
    x.fillStyle = '#e7edf6';
    x.font = '500 38px "Space Grotesk", sans-serif';
    x.fillText(`locked ${fmtLead(b.leadTimeMs)} before it happened`, W / 2, 870);
  }

  x.fillStyle = 'rgba(231,237,246,0.8)';
  x.font = '600 44px "Space Grotesk", sans-serif';
  x.fillText(`${b.user.emoji} ${b.user.name} · ${b.match}`, W / 2, 980);

  x.fillStyle = '#4ade80';
  x.font = '600 36px "JetBrains Mono", monospace';
  x.fillText(receipt.anchor ? '⛓ anchored on Solana' : 'anchoring on Solana…', W / 2, 1090);
  x.fillStyle = 'rgba(231,237,246,0.5)';
  x.font = '500 30px "JetBrains Mono", monospace';
  x.fillText(`sha256 ${receipt.hash.slice(0, 24)}…`, W / 2, 1145);

  x.fillStyle = 'rgba(231,237,246,0.45)';
  x.font = '500 30px "Space Grotesk", sans-serif';
  x.fillText('settled by TxLINE — verifiable sports data on Solana', W / 2, 1260);
  return c;
}

function wrapText(x, text, cx, y, maxW, lh) {
  const words = text.split(' ');
  let line = '', yy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (x.measureText(test).width > maxW && line) {
      x.fillText(line, cx, yy); line = w; yy += lh;
    } else line = test;
  }
  if (line) x.fillText(line, cx, yy);
}
