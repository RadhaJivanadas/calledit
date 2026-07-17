import React, { useEffect, useState, useRef } from 'react';
import { Flag } from './flags.jsx';
import { getSpeedHint } from './ws.js';

/* ---------------- Scoreboard ---------------- */

export function Scoreboard({ match }) {
  const { teams, score, status, clock, varPending, reds } = match;
  return (
    <section className="scoreboard glass">
      <div className="sb-team">
        <div className="sb-flag"><Flag name={teams[1]} size={46} round /></div>
        <div className="sb-name">{teams[1]}</div>
        {reds[1] > 0 && <div className="sb-red">🟥×{reds[1]}</div>}
      </div>
      <div className="sb-mid">
        <div className="sb-score">{score[1]}<span className="sb-dash">–</span>{score[2]}</div>
        <div className={`sb-clock ${status === '1H' || status === '2H' ? 'running' : ''}`}>
          {status === 'HT' ? 'HALF-TIME' : status === 'FT' ? 'FULL-TIME' : status === 'pre' ? 'KICK-OFF SOON' : clock}
        </div>
        {varPending && <div className="var-banner">📺 VAR CHECK</div>}
      </div>
      <div className="sb-team">
        <div className="sb-flag"><Flag name={teams[2]} size={46} round /></div>
        <div className="sb-name">{teams[2]}</div>
        {reds[2] > 0 && <div className="sb-red">🟥×{reds[2]}</div>}
      </div>
    </section>
  );
}

/* ---------------- Win probability ---------------- */

export function WinProb({ match }) {
  const p = match.probs;
  if (!p) return null;
  const h = Math.round(p.home * 100), d = Math.round(p.draw * 100), a = 100 - h - d;
  const hist = match.probsHist || [];
  return (
    <section className="winprob glass">
      <div className="wp-head">
        <span className="wp-title">THE MARKET SAYS</span>
        <span className="wp-src">TxLINE StablePrice · consensus of the world's books</span>
      </div>
      <div className="wp-bar">
        <div className="wp-seg h" style={{ width: `${h}%` }} />
        <div className="wp-seg d" style={{ width: `${d}%` }} />
        <div className="wp-seg a" style={{ width: `${a}%` }} />
      </div>
      <div className="wp-labels">
        <span><Flag name={match.teams[1]} size={16} /> {h}%</span>
        <span className="wp-draw">draw {d}%</span>
        <span>{a}% <Flag name={match.teams[2]} size={16} /></span>
      </div>
      {hist.length > 8 && <ProbSpark hist={hist} />}
    </section>
  );
}

function ProbSpark({ hist }) {
  const W = 320, H = 44;
  const xs = hist.map((_, i) => (i / (hist.length - 1)) * W);
  const line = key => xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${(H - hist[i][key] * H).toFixed(1)}`).join(' ');
  return (
    <svg className="wp-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={line('h')} className="spark h" />
      <path d={line('a')} className="spark a" />
    </svg>
  );
}

/* ---------------- Momentum / danger pulse ---------------- */

export function Momentum({ match }) {
  const d1 = match.danger[1], d2 = match.danger[2];
  const poss = match.possession;
  const active = poss?.team;
  const phaseText = {
    safe_possession: 'keeping it safe', possession: 'in possession',
    attack_possession: 'pushing forward ⚡', danger_possession: 'in the final third 🔥',
    high_danger_possession: 'ALL OVER THEM 🔥🔥',
  }[poss?.action] || null;
  return (
    <section className="momentum glass">
      <div className="mo-head">
        <span className="wp-title">MOMENTUM</span>
        {active && phaseText && (
          <span className={`mo-phase ${poss.level >= 3 ? 'hot' : ''}`}>
            <Flag name={match.teams[active]} size={14} /> {match.teams[active]} {phaseText}
          </span>
        )}
      </div>
      <div className="mo-bars">
        <div className="mo-side">
          <div className="mo-fill t1" style={{ width: `${d1}%` }} />
        </div>
        <div className="mo-side right">
          <div className="mo-fill t2" style={{ width: `${d2}%` }} />
        </div>
      </div>
      <PulseWave pulse={match.pulse} />
    </section>
  );
}

function PulseWave({ pulse }) {
  if (!pulse || pulse.length < 4) return null;
  const W = 320, H = 36, n = pulse.length;
  const pts1 = pulse.map((p, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H / 2 - (p.d1 / 100) * (H / 2 - 2)).toFixed(1)}`);
  const pts2 = pulse.map((p, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H / 2 + (p.d2 / 100) * (H / 2 - 2)).toFixed(1)}`);
  return (
    <svg className="mo-wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="mo-axis" />
      <polyline points={pts1.join(' ')} className="mo-line t1" />
      <polyline points={pts2.join(' ')} className="mo-line t2" />
    </svg>
  );
}

/* ---------------- Prophecy cards ---------------- */

export function CardDeck({ cards, myCalls, onCall, now }) {
  const myByCard = {};
  (myCalls || []).forEach(c => { myByCard[c.cardId] = c; });
  const sorted = [...(cards || [])].sort((x, y) => {
    const rank = c => (c.state === 'open' ? (c.hot ? 0 : 1) : c.state === 'locked' ? 2 : 3);
    return rank(x) - rank(y) || y.createdT - x.createdT;
  });
  return (
    <section className="deck">
      <div className="deck-head">
        <span className="wp-title">MAKE YOUR CALL</span>
        <span className="deck-sub">points scale with boldness — priced by live odds</span>
      </div>
      {sorted.length === 0 && <div className="deck-empty">Cards drop when the match heats up…</div>}
      {sorted.map(c => <ProphecyCard key={c.id} card={c} mine={myByCard[c.id]} onCall={onCall} now={now} />)}
    </section>
  );
}

function ProphecyCard({ card, mine, onCall, now }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (card.state !== 'open' || !card.locksAtT) return;
    const t = setInterval(() => force(x => x + 1), 250);
    return () => clearInterval(t);
  }, [card.state, card.locksAtT]);

  const evNow = now();
  let lockPct = null, lockSecs = null;
  if (card.state === 'open' && card.locksAtT && card.createdT) {
    const total = card.locksAtT - card.createdT;
    const left = Math.max(0, card.locksAtT - evNow);
    lockPct = Math.max(0, Math.min(1, left / total));
    lockSecs = Math.ceil(left / 1000 / getSpeedHint());
  }
  const settled = card.state === 'settled';
  const won = settled && mine && mine.state === 'won';

  return (
    <div className={[
      'card glass',
      card.hot ? 'hot' : '',
      card.state,
      settled ? (mine ? (won ? 'won' : 'lost') : 'done') : '',
    ].join(' ')}>
      <div className="card-top">
        <span className="card-emoji">{card.emoji}</span>
        <div className="card-titles">
          <div className="card-title">{card.title}</div>
          <div className="card-q">{card.question}</div>
        </div>
        {lockPct != null && (
          <div className="lock-ring" title="time to lock in">
            <svg viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15.5" className="ring-bg" />
              <circle
                cx="18" cy="18" r="15.5" className="ring-fg"
                strokeDasharray={`${(lockPct * 97.4).toFixed(1)} 97.4`}
              />
            </svg>
            <span>{lockSecs}</span>
          </div>
        )}
        {card.state === 'locked' && <span className="lock-chip">LOCKED</span>}
        {settled && <span className={`result-chip ${mine ? (won ? 'ok' : 'bad') : ''}`}>{card.options.find(o => o.key === card.result)?.label || card.state}</span>}
      </div>
      <div className="card-opts">
        {card.options.map(o => {
          const picked = mine && mine.pick === o.label;
          const isResult = settled && card.result === o.key;
          return (
            <button
              key={o.key}
              disabled={card.state !== 'open' || !!mine}
              className={['opt', picked ? 'picked' : '', isResult ? 'is-result' : ''].join(' ')}
              onClick={() => onCall(card.id, o.key)}
            >
              <span className="opt-label">{o.label}</span>
              <span className="opt-pts">+{o.points}</span>
            </button>
          );
        })}
      </div>
      {mine && !settled && <div className="card-mine">Your call: <b>{mine.pick}</b> · riding for +{mine.basePoints}</div>}
    </div>
  );
}

/* ---------------- Feed ---------------- */

export function Feed({ feed, teams }) {
  return (
    <section className="feed glass">
      <div className="wp-title">MATCH PULSE</div>
      <ul>
        {(feed || []).map(f => (
          <li key={f.id} className={f.team ? `t${f.team}` : ''}>
            <span className="feed-clock">{f.clock}</span>
            <span className="feed-icon">{f.icon}</span>
            <span className="feed-text">{f.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------- Leaderboards ---------------- */

export function LeaderboardView({ leaderboard, squad, me, onCreate, onJoin }) {
  const [mode, setMode] = useState(squad ? 'squad' : 'global');
  const [joinCode, setJoinCode] = useState('');
  const [squadName, setSquadName] = useState('');
  const rows = mode === 'squad' ? (squad?.members || []) : leaderboard;
  return (
    <section className="board">
      <div className="board-tabs">
        <button className={mode === 'global' ? 'on' : ''} onClick={() => setMode('global')}>🌍 Global</button>
        <button className={mode === 'squad' ? 'on' : ''} onClick={() => setMode('squad')}>👥 Squad</button>
      </div>
      {mode === 'squad' && !squad && (
        <div className="squad-setup glass">
          <p>Rally your group chat. One squad, one leaderboard, one champion.</p>
          <div className="squad-row">
            <input placeholder="Squad name" value={squadName} onChange={e => setSquadName(e.target.value)} maxLength={24} />
            <button className="btn" onClick={() => squadName && onCreate(squadName)}>Create</button>
          </div>
          <div className="squad-or">— or —</div>
          <div className="squad-row">
            <input placeholder="Join code e.g. 9F3A2C" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={6} />
            <button className="btn" onClick={() => joinCode && onJoin(joinCode)}>Join</button>
          </div>
        </div>
      )}
      {mode === 'squad' && squad && (
        <div className="squad-code glass">
          <span>Squad <b>{squad.name}</b></span>
          <button className="code-btn" onClick={() => navigator.clipboard?.writeText(`${squad.code}`)}>
            code: <b>{squad.code}</b> 📋
          </button>
        </div>
      )}
      <ol className="lb">
        {rows.map((u, i) => (
          <li key={u.id} className={me && u.id === me.id ? 'me' : ''}>
            <span className="lb-rank">{i + 1}</span>
            <span className="lb-emoji">{u.emoji}</span>
            <span className="lb-name">{u.name}{u.isBot ? <em className="bot-tag">demo</em> : null}</span>
            {u.streak > 1 && <span className="streak">🔥{u.streak}</span>}
            <span className="lb-pts">{u.pts.toLocaleString()}</span>
          </li>
        ))}
        {rows.length === 0 && <div className="deck-empty">No players yet — be the first.</div>}
      </ol>
    </section>
  );
}

/* ---------------- My calls ---------------- */

export function MyCalls({ calls }) {
  if (!calls || calls.length === 0) {
    return <div className="deck-empty" style={{ marginTop: 40 }}>No calls yet. Go make one — the match won't wait.</div>;
  }
  return (
    <section className="mycalls">
      {calls.map(c => (
        <div key={c.id} className={`mycall glass ${c.state}`}>
          <span className="mc-emoji">{c.emoji}</span>
          <div className="mc-mid">
            <div className="mc-title">{c.title}</div>
            <div className="mc-pick">you called: <b>{c.pick}</b></div>
          </div>
          <div className="mc-right">
            {c.state === 'open' && <span className="mc-open">riding · +{c.basePoints}</span>}
            {c.state === 'won' && <span className="mc-won">+{c.pointsAwarded}{c.mult > 1 ? ` ×${c.mult}` : ''}</span>}
            {c.state === 'lost' && <span className="mc-lost">missed</span>}
            {c.state === 'void' && <span className="mc-void">void</span>}
            {c.receiptId && <a className="mc-receipt" href={`#/receipt/${c.receiptId}`}>receipt →</a>}
          </div>
        </div>
      ))}
    </section>
  );
}

/* ---------------- Onboarding ---------------- */

const EMOJIS = ['⚽', '🦁', '🐐', '🦅', '🔥', '⚡', '🌟', '🧠', '🦊', '🐙', '👑', '🎯'];

export function Onboarding({ onDone }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('⚽');
  return (
    <div className="modal-back">
      <div className="modal glass">
        <div className="ob-logo">CALLED<span className="logo-bolt">⚡</span>IT</div>
        <p className="ob-tag">Call the match before it happens.<br />Prove it forever.</p>
        <div className="ob-emojis">
          {EMOJIS.map(e => (
            <button key={e} className={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)}>{e}</button>
          ))}
        </div>
        <input
          className="ob-name" placeholder="Your name" value={name} maxLength={18}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && name.trim() && onDone(name.trim(), emoji)}
        />
        <button className="btn big" disabled={!name.trim()} onClick={() => onDone(name.trim(), emoji)}>
          Into the stadium →
        </button>
        <p className="ob-fine">No signup. No email. Just calls.</p>
      </div>
    </div>
  );
}

/* ---------------- Toasts & splash ---------------- */

export function Toasts({ toasts }) {
  return (
    <div className="toasts">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.confetti && <Confetti />}
          <div className="toast-title">{t.title}</div>
          <div className="toast-body">{t.body}</div>
          {t.receiptId && <a href={`#/receipt/${t.receiptId}`} className="toast-link">View your receipt →</a>}
        </div>
      ))}
    </div>
  );
}

function Confetti() {
  const pieces = Array.from({ length: 24 });
  return (
    <div className="confetti">
      {pieces.map((_, i) => (
        <span key={i} style={{
          '--dx': `${(Math.random() * 2 - 1) * 140}px`,
          '--dy': `${-40 - Math.random() * 120}px`,
          '--r': `${Math.random() * 720 - 360}deg`,
          '--c': ['#4ade80', '#fbbf24', '#60a5fa', '#f472b6'][i % 4],
          '--d': `${0.6 + Math.random() * 0.8}s`,
        }} />
      ))}
    </div>
  );
}

export function GoalSplash({ name }) {
  return (
    <div className="goal-splash">
      <div className="goal-word">GOOOAL!</div>
      <div className="goal-team"><Flag name={name} size={26} /> {name}</div>
    </div>
  );
}

/* ---------------- Provenance ---------------- */

export function ProvenanceChip({ provenance, mode, anchorWallet }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="prov">
      <button className="prov-chip" onClick={() => setOpen(o => !o)}>
        <span className="prov-dot" /> Powered by TxLINE on Solana {open ? '▴' : '▾'}
      </button>
      {open && provenance && (
        <div className="prov-panel glass">
          <p>{provenance.note}</p>
          <p className="prov-line"><b>Source:</b> {provenance.source}</p>
          {provenance.endpoints && (
            <p className="prov-line"><b>Endpoints:</b> {provenance.endpoints.join(' · ')}</p>
          )}
          {provenance.counts && (
            <p className="prov-line"><b>This match:</b> {provenance.counts.score} score events · {provenance.counts.odds} odds updates</p>
          )}
          {anchorWallet && (
            <p className="prov-line"><b>Receipt anchor wallet:</b> <code>{anchorWallet.slice(0, 8)}…{anchorWallet.slice(-6)}</code> (devnet)</p>
          )}
        </div>
      )}
    </section>
  );
}
