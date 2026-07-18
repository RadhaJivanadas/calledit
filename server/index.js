'use strict';
/**
 * CalledIt server — sessions, WebSocket fan-out, REST API, static hosting.
 *
 * A "session" is one match: a data driver (live TxLINE SSE, or a replay of
 * captured TxLINE historical data) feeding a MatchState + ProphecyEngine.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { TxLineClient } = require('./txline');
const { MatchState } = require('./matchstate');
const { ProphecyEngine } = require('./prophecy');
const { Game } = require('./game');
const { ReceiptAnchor } = require('./receipts');
const { ReplayDriver } = require('./replay');

const log = console;
const game = new Game({ persistFile: config.persistFile, demoBots: config.demoBots });
const anchor = new ReceiptAnchor(config.solana, log);
game.on('receipt', r => anchor.push(r));
anchor.onAnchored = batch => {
  for (const r of batch) {
    broadcastAll({ type: 'receipt_anchored', receiptId: r.id, txSig: r.anchor.txSig, explorer: r.anchor.explorer });
  }
  game.save();
};

const sessions = new Map();   // id -> session
const sockets = new Map();    // ws -> {userId, sessionId}

/* ------------------------------------------------------------------ */
/* Session factory                                                     */
/* ------------------------------------------------------------------ */

function wireSession(session) {
  const { engine, match } = session;
  engine.on('card_new', card => {
    session.cardsIndex.set(card.id, card);
    // demo bots pile in shortly after a card opens
    for (const bc of game.botCallsForCard(card)) {
      setTimeout(() => {
        if (card.state === 'open') game.placeCall(bc.botId, card, bc.pick, match.now);
      }, 500 + Math.random() * 5000);
    }
    broadcast(session, { type: 'card_new', card: publicCard(card) });
  });

  engine.on('card_update', card => broadcast(session, { type: 'card_update', card: publicCard(card) }));

  engine.on('card_settled', card => {
    const results = game.settleCard(card, match);
    for (const res of results) {
      if (res.user.isBot) continue;
      send(res.user.id, {
        type: 'call_settled',
        cardId: card.id,
        title: card.title,
        result: card.result,
        won: res.won,
        points: res.pointsAwarded,
        mult: res.call.mult || 1,
        streak: res.user.streak,
        receiptId: res.receipt?.id || null,
      });
    }
    broadcast(session, { type: 'card_settled', card: publicCard(card) });
    scheduleSnapshot(session, true);
  });

  match.on('feed', item => { if (!session.backfilling) broadcast(session, { type: 'feed', item }); });
  match.on('goal', g => { if (!session.backfilling) broadcast(session, { type: 'goal', team: g.team, name: match.teamName(g.team) }); });
  match.on('goal_confirmed', () => scheduleSnapshot(session, true));
  match.on('status', () => scheduleSnapshot(session, true));
}

function createSession({ id, label, mode, fixtureId, teams, players }) {
  const match = new MatchState({ fixtureId, teams, players });
  const engine = new ProphecyEngine(match, { sessionId: id });
  const session = {
    id, label, mode, match, engine, driver: null,
    cardsIndex: new Map(),
    lastBroadcast: 0,
  };
  wireSession(session);
  sessions.set(id, session);
  return session;
}

function publicCard(c) {
  return {
    id: c.id, type: c.type, emoji: c.emoji, title: c.title, question: c.question,
    options: c.options, state: c.state, result: c.result || null, clock: c.clock,
    hot: !!c.hot, team: c.team || null, createdT: c.createdT,
    locksAtT: c.locksAtT === Infinity ? null : c.locksAtT,
    windowEndT: c.windowEndT || null, priced: c.priced || null,
  };
}

/* ------------------------------------------------------------------ */
/* Replay session (always available — real captured TxLINE data)       */
/* ------------------------------------------------------------------ */

function bootReplay() {
  const driver = new ReplayDriver(config.replay);
  const meta = driver.meta;
  const session = createSession({
    id: 'replay',
    label: `${meta.teams[1]} vs ${meta.teams[2]}`,
    mode: 'replay',
    fixtureId: meta.fixtureId,
    teams: meta.teams,
    players: meta.players,
  });
  session.driver = driver;
  session.provenance = {
    source: meta.source,
    endpoints: meta.endpoints,
    counts: meta.counts,
    note: 'Every event below was captured from the TxLINE devnet API and is replayed verbatim.',
  };
  driver.on('event', (kind, ev, opts = {}) => {
    session.match.ingest(kind, ev);
    if (!opts.catchup) session.engine.tick();
  });
  driver.on('reset', () => {
    // fresh match state + engine, rewired identically
    session.match = new MatchState({ fixtureId: meta.fixtureId, teams: meta.teams, players: meta.players });
    session.engine = new ProphecyEngine(session.match, { sessionId: session.id });
    wireSession(session);
  });
  driver.start();
  return session;
}

/* ------------------------------------------------------------------ */
/* Live session (attaches to a real TxLINE devnet fixture)             */
/* ------------------------------------------------------------------ */

let txClient = null;

/**
 * The TxLINE live SSE streams deliver only events emitted after connect —
 * there is no replay on the stream itself. Without this, a server restart
 * mid-match (e.g. a free-tier host waking up) shows 0-0 until the next
 * scoring event. So on session start and on every stream (re)connect we
 * replay the score + odds snapshots through the same ingest path; the Seq
 * guard in MatchState makes the overlap with the live stream idempotent.
 */
async function fetchEventList(pathname) {
  const res = await fetch(`${config.txline.host}${pathname}`, { headers: await txClient.headers() });
  if (!res.ok) throw new Error(`${pathname} ${res.status}`);
  const raw = await res.text();
  try { const j = JSON.parse(raw); return Array.isArray(j) ? j : []; } catch { /* SSE-framed */ }
  return raw.split(/\r?\n\r?\n/).map(b => {
    const l = b.split(/\r?\n/).filter(x => x.startsWith('data:'));
    if (!l.length) return null;
    try { return JSON.parse(l.map(x => x.slice(5).trim()).join('')); } catch { return null; }
  }).filter(Boolean);
}

async function backfillLiveSession(session) {
  session.backfilling = true; // no goal splashes / feed pushes for old events
  try {
    // full in-play history first; tail snapshot as fallback
    let events = [];
    try { events = await fetchEventList(`/api/scores/updates/${session.match.fixtureId}`); } catch { /* pre-match */ }
    if (!events.length) {
      try { events = await fetchEventList(`/api/scores/snapshot/${session.match.fixtureId}`); } catch { /* no coverage yet */ }
    }
    events.sort((a, b) => (a.Seq ?? 0) - (b.Seq ?? 0));
    for (const ev of events) session.match.ingest('score', ev);
    const odds = await txClient.getJson(`/api/odds/snapshot/${session.match.fixtureId}`);
    if (Array.isArray(odds)) {
      for (const o of odds.sort((a, b) => a.Ts - b.Ts)) session.match.ingest('odds', o);
    }
    session.engine.tick();
    scheduleSnapshot(session, true);
    log.log(`[live] backfilled ${session.id}: score ${session.match.score[1]}-${session.match.score[2]}, status ${session.match.phaseName}`);
  } catch (e) {
    log.warn(`[live] backfill ${session.id} failed:`, e.message);
  } finally {
    session.backfilling = false;
  }
}

async function pollLiveFixture() {
  if (!config.txline.apiToken) return;
  try {
    if (!txClient) txClient = new TxLineClient(config.txline);
    const fixtures = await txClient.fixturesSnapshot();
    const now = Date.now();
    let candidates;
    if (config.txline.fixtureId) {
      candidates = fixtures.filter(f => f.FixtureId === config.txline.fixtureId);
    } else {
      candidates = fixtures
        .filter(f => f.StartTime > now - 3 * 3600_000 && f.StartTime < now + 36 * 3600_000)
        .sort((a, b) => a.StartTime - b.StartTime)
        .slice(0, 4);
    }
    let added = false;
    for (const fx of candidates) {
      const id = `live-${fx.FixtureId}`;
      if (sessions.has(id)) continue;
      const session = createSession({
        id,
        label: `${fx.Participant1} vs ${fx.Participant2}`,
        mode: 'live',
        fixtureId: fx.FixtureId,
        teams: { 1: fx.Participant1, 2: fx.Participant2 },
        players: {},
      });
      session.startTime = fx.StartTime;
      session.provenance = {
        source: 'TxLINE devnet LIVE — /api/scores/stream + /api/odds/stream',
        endpoints: ['/api/scores/stream', '/api/odds/stream', '/api/fixtures/snapshot'],
        note: 'Connected to the live TxLINE SSE feeds over an on-chain Solana subscription.',
      };
      txClient.on('data', (label, ev) => {
        if (ev.FixtureId !== fx.FixtureId) return;
        session.match.ingest(label === 'odds' ? 'odds' : 'score', ev);
        session.engine.tick();
      });
      log.log(`[live] session ${id}: ${session.label} @ ${new Date(fx.StartTime).toISOString()}`);
      backfillLiveSession(session);
      added = true;
    }
    if (added) {
      if (!txClient._streamsOpen) {
        txClient._streamsOpen = true;
        txClient.on('stream_open', label => {
          if (label !== 'score') return;
          // stream (re)connected — replay whatever we missed while offline
          for (const s of sessions.values()) if (s.mode === 'live') backfillLiveSession(s);
        });
        txClient.openStream('/api/scores/stream', 'score');
        txClient.openStream('/api/odds/stream', 'odds');
      }
      broadcastAll({ type: 'sessions', sessions: sessionList() });
    }
  } catch (e) {
    log.warn('[live] fixture poll failed:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function sessionList() {
  return [...sessions.values()].map(s => ({
    id: s.id,
    label: s.label,
    mode: s.mode,
    status: s.match.phaseName,
    score: s.match.score,
    clock: s.match.displayClock().label,
    startTime: s.startTime || null,
    teams: s.match.teams,
  }));
}

function snapshotFor(session, userId) {
  return {
    type: 'snapshot',
    sessionId: session.id,
    mode: session.mode,
    label: session.label,
    provenance: session.provenance || null,
    speedHint: session.mode === 'replay' ? (session.driver?.speed || 1) : 1,
    match: session.match.publicState(),
    cards: session.engine.publicCards(),
    leaderboard: game.leaderboard(10),
    me: userId && game.users.has(userId) ? game.publicUser(game.users.get(userId)) : null,
    squad: userId && game.users.get(userId)?.squad ? game.squadBoard(game.users.get(userId).squad) : null,
    myCalls: userId ? game.userCalls(userId, session.cardsIndex) : [],
    anchorWallet: anchor.pubkey,
  };
}

function send(userId, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of sockets) {
    if (info.userId === userId && ws.readyState === 1) ws.send(data);
  }
}

function broadcast(session, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of sockets) {
    if (info.sessionId === session.id && ws.readyState === 1) ws.send(data);
  }
}

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets.keys()) if (ws.readyState === 1) ws.send(data);
}

function scheduleSnapshot(session, immediate = false) {
  const now = Date.now();
  if (!immediate && now - session.lastBroadcast < 1500) return;
  session.lastBroadcast = now;
  for (const [ws, info] of sockets) {
    if (info.sessionId === session.id && ws.readyState === 1) {
      ws.send(JSON.stringify(snapshotFor(session, info.userId)));
    }
  }
}

setInterval(() => { for (const s of sessions.values()) scheduleSnapshot(s); }, 2000);

wss.on('connection', ws => {
  sockets.set(ws, { userId: null, sessionId: null });
  ws.send(JSON.stringify({ type: 'welcome', sessions: sessionList() }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const info = sockets.get(ws);
    if (!info) return;
    switch (msg.type) {
      case 'hello': {
        info.userId = String(msg.clientId || '').slice(0, 40) || null;
        if (info.userId) game.ensureUser(info.userId, { name: msg.name, emoji: msg.emoji });
        ws.send(JSON.stringify({ type: 'hello_ack', sessions: sessionList() }));
        break;
      }
      case 'watch': {
        const session = sessions.get(msg.sessionId) || sessions.get('replay');
        info.sessionId = session.id;
        ws.send(JSON.stringify(snapshotFor(session, info.userId)));
        break;
      }
      case 'profile': {
        if (info.userId) {
          game.ensureUser(info.userId, { name: msg.name, emoji: msg.emoji });
          scheduleSnapshot(sessions.get(info.sessionId) || sessions.get('replay'), true);
        }
        break;
      }
      case 'call': {
        const session = sessions.get(info.sessionId);
        if (!session || !info.userId) return;
        const card = session.cardsIndex.get(msg.cardId);
        const res = game.placeCall(info.userId, card, msg.pick, session.match.now);
        ws.send(JSON.stringify({ type: 'call_ack', cardId: msg.cardId, ...(res.error ? { error: res.error } : { ok: true, call: { pick: res.call.pickLabel, points: res.call.basePoints } }) }));
        if (!res.error) scheduleSnapshot(session, true);
        break;
      }
      case 'squad_create': {
        if (!info.userId) return;
        const squad = game.createSquad(info.userId, msg.name);
        ws.send(JSON.stringify({ type: 'squad', squad: game.squadBoard(squad.code) }));
        break;
      }
      case 'squad_join': {
        if (!info.userId) return;
        const squad = game.joinSquad(info.userId, msg.code);
        ws.send(JSON.stringify(squad ? { type: 'squad', squad: game.squadBoard(squad.code) } : { type: 'squad_error', error: 'Squad not found' }));
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => sockets.delete(ws));
});

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => res.json({ ok: true, sessions: sessionList(), anchor: anchor.pubkey, mode: config.txline.dataMode }));

app.get('/api/sessions', (req, res) => res.json(sessionList()));

app.get('/api/receipt/:id', (req, res) => {
  const r = game.receipts.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.get('/api/verify/:id', (req, res) => {
  const r = game.receipts.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const check = ReceiptAnchor.verify(r);
  res.json({ receipt: r, verification: check });
});

app.post('/api/admin/replay', (req, res) => {
  if (req.body.key !== config.adminKey) return res.status(403).json({ error: 'nope' });
  const session = sessions.get('replay');
  const d = session?.driver;
  if (!d) return res.status(400).json({ error: 'no replay session' });
  const { action, value } = req.body;
  if (action === 'pause') d.pause();
  else if (action === 'play') d.play();
  else if (action === 'speed') d.setSpeed(Number(value));
  else if (action === 'seek') d.seekToMinute(Number(value));
  else if (action === 'restart') d.start();
  res.json({ ok: true, playing: d.playing, speed: d.speed });
});

// static web app
const dist = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(dist));
app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));

/* ------------------------------------------------------------------ */

server.listen(config.port, () => {
  log.log(`CalledIt listening on :${config.port}`);
  bootReplay();
  if (config.txline.dataMode !== 'replay') {
    pollLiveFixture();
    const t = setInterval(pollLiveFixture, config.txline.fixturePollMs);
    if (t.unref) t.unref();
  }
});
