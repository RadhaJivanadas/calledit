import React, { useEffect, useState, useCallback, useRef } from 'react';
import { subscribe, sendMsg, watch, setProfile, clientId, displayNow } from './ws.js';
import {
  Scoreboard, Momentum, WinProb, CardDeck, Feed, Onboarding,
  LeaderboardView, MyCalls, Toasts, GoalSplash, ProvenanceChip,
} from './components.jsx';
import { ReceiptPage, VerifyPage } from './pages.jsx';

function useHashRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

let toastSeq = 0;

export default function App() {
  const route = useHashRoute();
  const [snap, setSnap] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tab, setTab] = useState('match');
  const [toasts, setToasts] = useState([]);
  const [goalSplash, setGoalSplash] = useState(null);
  const [connected, setConnected] = useState(true);
  const [needsProfile, setNeedsProfile] = useState(!localStorage.getItem('ci_profile'));
  const [muted, setMuted] = useState(localStorage.getItem('ci_muted') === '1');
  const audioRef = useRef(null);

  const beep = useCallback((freq = 660, dur = 0.09, type = 'sine', gain = 0.04) => {
    if (muted) return;
    try {
      if (!audioRef.current) audioRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioRef.current;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + dur);
    } catch { /* no audio */ }
  }, [muted]);

  const pushToast = useCallback(t => {
    const id = ++toastSeq;
    setToasts(ts => [...ts, { id, ...t }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), t.ttl || 5000);
  }, []);

  useEffect(() => subscribe(msg => {
    switch (msg.type) {
      case 'snapshot': setSnap(msg); break;
      case 'welcome': case 'hello_ack': setSessions(msg.sessions || []); break;
      case 'sessions': setSessions(msg.sessions || []); break;
      case '_open': setConnected(true); break;
      case '_closed': setConnected(false); break;
      case 'card_new':
        if (msg.card.hot) beep(880, 0.12, 'square', 0.05);
        break;
      case 'goal':
        setGoalSplash({ name: msg.name, at: Date.now() });
        beep(520, 0.4, 'sawtooth', 0.06);
        setTimeout(() => setGoalSplash(null), 4200);
        break;
      case 'call_settled': {
        if (msg.won) {
          beep(990, 0.18, 'triangle', 0.07);
          pushToast({ kind: 'won', title: 'CALLED IT! ✅', body: `${msg.title} — +${msg.points} pts${msg.mult > 1 ? ` (×${msg.mult} streak)` : ''}`, receiptId: msg.receiptId, confetti: true, ttl: 6500 });
        } else if (msg.won === false) {
          pushToast({ kind: 'lost', title: 'Not this time ❌', body: msg.title, ttl: 3800 });
        }
        break;
      }
      case 'receipt_anchored':
        pushToast({ kind: 'anchor', title: 'Anchored on Solana ⛓️', body: 'Your call is now provable forever.', receiptId: msg.receiptId, ttl: 5200 });
        break;
      default: break;
    }
  }), [beep, pushToast]);

  const onProfile = (name, emoji) => {
    setProfile(name, emoji);
    setNeedsProfile(false);
  };

  const call = (cardId, pick) => {
    sendMsg({ type: 'call', cardId, pick });
    beep(700, 0.06, 'sine', 0.05);
  };

  if (route.startsWith('/receipt/')) return <ReceiptPage id={route.split('/')[2]} />;
  if (route.startsWith('/verify/')) return <VerifyPage id={route.split('/')[2]} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo" onClick={() => setTab('match')}>
          CALLED<span className="logo-bolt">⚡</span>IT
        </div>
        <div className="top-right">
          {snap && <ModeBadge mode={snap.mode} />}
          <button className="icon-btn" onClick={() => { const m = !muted; setMuted(m); localStorage.setItem('ci_muted', m ? '1' : '0'); }}>
            {muted ? '🔇' : '🔊'}
          </button>
          {snap?.me && (
            <div className="me-chip" onClick={() => setTab('board')}>
              <span>{snap.me.emoji}</span>
              <b>{snap.me.pts.toLocaleString()}</b>
              {snap.me.streak > 1 && <span className="streak">🔥{snap.me.streak}</span>}
            </div>
          )}
        </div>
      </header>

      {!connected && <div className="conn-banner">Reconnecting…</div>}

      {sessions.length > 1 && (
        <div className="session-picker">
          {sessions.map(s => (
            <button
              key={s.id}
              className={`session-pill ${snap?.sessionId === s.id ? 'active' : ''}`}
              onClick={() => watch(s.id)}
            >
              {s.mode === 'live' ? <span className="live-dot" /> : '▶️'} {s.label}
            </button>
          ))}
        </div>
      )}

      {goalSplash && <GoalSplash name={goalSplash.name} />}

      <main className="main">
        {!snap && <div className="loading"><div className="ball">⚽</div>Warming up the pitch…</div>}
        {snap && tab === 'match' && (
          <>
            <Scoreboard match={snap.match} />
            <WinProb match={snap.match} />
            <Momentum match={snap.match} />
            <CardDeck cards={snap.cards} myCalls={snap.myCalls} onCall={call} now={displayNow} />
            <Feed feed={snap.match.feed} teams={snap.match.teams} />
            <ProvenanceChip provenance={snap.provenance} mode={snap.mode} anchorWallet={snap.anchorWallet} />
          </>
        )}
        {snap && tab === 'board' && (
          <LeaderboardView
            leaderboard={snap.leaderboard}
            squad={snap.squad}
            me={snap.me}
            onCreate={name => sendMsg({ type: 'squad_create', name })}
            onJoin={code => sendMsg({ type: 'squad_join', code })}
          />
        )}
        {snap && tab === 'calls' && <MyCalls calls={snap.myCalls} />}
      </main>

      <nav className="tabbar">
        <button className={tab === 'match' ? 'on' : ''} onClick={() => setTab('match')}><span>⚽</span>Match</button>
        <button className={tab === 'calls' ? 'on' : ''} onClick={() => setTab('calls')}><span>🎯</span>My Calls</button>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}><span>🏆</span>Leaders</button>
      </nav>

      <Toasts toasts={toasts} />
      {needsProfile && <Onboarding onDone={onProfile} />}
    </div>
  );
}

function ModeBadge({ mode }) {
  return mode === 'live'
    ? <span className="badge live"><span className="live-dot" />LIVE</span>
    : <span className="badge replay">REPLAY · real TxLINE data</span>;
}
