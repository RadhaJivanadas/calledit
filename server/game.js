'use strict';
/**
 * Game — users, squads, calls, scoring, leaderboards, receipts.
 * Persisted as one JSON blob; everything else is derived.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const uid = () => crypto.randomBytes(8).toString('hex');
const squadCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();

const BOT_POOL = [
  ['Marta', '🇪🇸'], ['Lukas', '🇩🇪'], ['Sofia', '🇮🇹'], ['Tunde', '🇳🇬'],
  ['Diego', '🇦🇷'], ['Amélie', '🇫🇷'], ['Kenji', '🇯🇵'], ['Priya', '🇮🇳'],
  ['Jack', '🇬🇧'], ['Carlos', '🇧🇷'],
];

class Game extends EventEmitter {
  constructor({ persistFile, demoBots = 0 }) {
    super();
    this.persistFile = persistFile;
    this.users = new Map();     // id -> user
    this.squads = new Map();    // code -> {code, name, members:[]}
    this.calls = new Map();     // callId -> call
    this.callsByCard = new Map();
    this.receipts = new Map();  // receiptId -> receipt
    this.load();
    this.bots = [];
    for (let i = 0; i < demoBots; i++) this.bots.push(this.ensureBot(i));
    this.saveTimer = setInterval(() => this.save(), 15_000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  /* ---------------- persistence ---------------- */
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
      (d.users || []).forEach(u => this.users.set(u.id, u));
      (d.squads || []).forEach(s => this.squads.set(s.code, s));
      (d.receipts || []).forEach(r => this.receipts.set(r.id, r));
    } catch { /* fresh start */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
      fs.writeFileSync(this.persistFile, JSON.stringify({
        users: [...this.users.values()],
        squads: [...this.squads.values()],
        receipts: [...this.receipts.values()].slice(-500),
      }));
    } catch (e) { /* non-fatal */ }
  }

  /* ---------------- users & squads ---------------- */
  ensureUser(id, { name, emoji } = {}) {
    let u = this.users.get(id);
    if (!u) {
      u = { id, name: name || 'Fan', emoji: emoji || '⚽', pts: 0, streak: 0, bestStreak: 0, correct: 0, total: 0, squad: null, isBot: false };
      this.users.set(id, u);
    }
    if (name) u.name = String(name).slice(0, 18);
    if (emoji) u.emoji = String(emoji).slice(0, 8);
    return u;
  }

  ensureBot(i) {
    const [name, emoji] = BOT_POOL[i % BOT_POOL.length];
    const id = `bot-${i}`;
    const u = this.ensureUser(id, { name, emoji });
    u.isBot = true;
    return u;
  }

  createSquad(userId, name) {
    const u = this.users.get(userId);
    if (!u) return null;
    const code = squadCode();
    const squad = { code, name: String(name || 'My Squad').slice(0, 24), members: [userId], createdAt: Date.now() };
    this.squads.set(code, squad);
    u.squad = code;
    // seed demo bots into the squad so it feels alive immediately
    for (const b of this.bots.slice(0, 4)) {
      if (!squad.members.includes(b.id)) { squad.members.push(b.id); b.squad = code; }
    }
    return squad;
  }

  joinSquad(userId, code) {
    const squad = this.squads.get(String(code).toUpperCase());
    const u = this.users.get(userId);
    if (!squad || !u) return null;
    if (!squad.members.includes(userId)) squad.members.push(userId);
    u.squad = squad.code;
    return squad;
  }

  /* ---------------- calls ---------------- */
  placeCall(userId, card, pickKey, eventNow) {
    if (!card || (card.state !== 'open')) return { error: 'Card is locked' };
    const opt = card.options.find(o => o.key === pickKey);
    if (!opt) return { error: 'Unknown pick' };
    const existing = (this.callsByCard.get(card.id) || []).find(c => c.userId === userId);
    if (existing) return { error: 'Already called' };
    const u = this.ensureUser(userId);
    const call = {
      id: uid(), userId, cardId: card.id, pick: pickKey, pickLabel: opt.label,
      prob: opt.prob, basePoints: opt.points,
      lockedAtT: eventNow, lockedClock: card.clock ? undefined : undefined,
      state: 'open',
    };
    this.calls.set(call.id, call);
    if (!this.callsByCard.has(card.id)) this.callsByCard.set(card.id, []);
    this.callsByCard.get(card.id).push(call);
    u.total += 1;
    return { call, user: u };
  }

  /** Settle all calls on a card; returns [{call, user, won, pointsAwarded, receipt?}] */
  settleCard(card, match) {
    const calls = this.callsByCard.get(card.id) || [];
    const results = [];
    for (const call of calls) {
      if (call.state !== 'open') continue;
      const u = this.users.get(call.userId);
      if (!u) continue;
      if (card.state === 'void') {
        call.state = 'void';
        results.push({ call, user: u, won: null, pointsAwarded: 0 });
        continue;
      }
      const won = call.pick === card.result;
      call.state = won ? 'won' : 'lost';
      let awarded = 0;
      if (won) {
        u.streak += 1;
        u.bestStreak = Math.max(u.bestStreak, u.streak);
        u.correct += 1;
        const mult = 1 + 0.25 * Math.min(u.streak - 1, 4);
        awarded = Math.round(call.basePoints * mult);
        u.pts += awarded;
        call.mult = mult;
      } else {
        u.streak = 0;
      }
      call.pointsAwarded = awarded;
      let receipt = null;
      if (won && !u.isBot) {
        receipt = this.mintReceipt(call, card, u, match);
      }
      results.push({ call, user: u, won, pointsAwarded: awarded, receipt });
    }
    return results;
  }

  /* ---------------- receipts ---------------- */
  mintReceipt(call, card, user, match) {
    const body = {
      v: 1,
      app: 'CalledIt',
      callId: call.id,
      user: { id: user.id, name: user.name, emoji: user.emoji },
      fixtureId: match.fixtureId,
      match: `${match.teamName(1)} vs ${match.teamName(2)}`,
      market: card.title,
      question: card.question,
      pick: call.pickLabel,
      prob: +(call.prob?.toFixed(4) || 0),
      points: call.pointsAwarded,
      lockedAtEventTs: call.lockedAtT,
      settledAtEventTs: card.settledT,
      leadTimeMs: (card.evidence?.eventTs || card.settledT) - call.lockedAtT,
      evidence: card.evidence || {},
      dataSource: 'TxLINE (TxODDS) — Solana-anchored sports data',
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const receipt = { id: uid(), body, hash, anchor: null, createdAt: Date.now() };
    this.receipts.set(receipt.id, receipt);
    this.emit('receipt', receipt);
    return receipt;
  }

  /* ---------------- bots ---------------- */
  botCallsForCard(card, rng = Math.random) {
    const out = [];
    for (const b of this.bots) {
      if (rng() > 0.65) continue;
      // bots lean toward likely outcomes but sometimes go bold
      const weights = card.options.map(o => Math.pow(Math.max(o.prob, 0.02), 0.7));
      const total = weights.reduce((a, x) => a + x, 0);
      let r = rng() * total, pick = card.options[0];
      for (let i = 0; i < card.options.length; i++) {
        r -= weights[i];
        if (r <= 0) { pick = card.options[i]; break; }
      }
      out.push({ botId: b.id, pick: pick.key, delayMs: 2000 + rng() * 15_000 });
    }
    return out;
  }

  /* ---------------- leaderboards ---------------- */
  leaderboard(limit = 10) {
    return [...this.users.values()]
      .filter(u => u.total > 0)
      .sort((a, b) => b.pts - a.pts)
      .slice(0, limit)
      .map(u => this.publicUser(u));
  }

  squadBoard(code) {
    const squad = this.squads.get(code);
    if (!squad) return null;
    const members = squad.members
      .map(id => this.users.get(id)).filter(Boolean)
      .sort((a, b) => b.pts - a.pts)
      .map(u => this.publicUser(u));
    return { code: squad.code, name: squad.name, members };
  }

  publicUser(u) {
    return { id: u.id, name: u.name, emoji: u.emoji, pts: u.pts, streak: u.streak, bestStreak: u.bestStreak, correct: u.correct, total: u.total, isBot: u.isBot };
  }

  userCalls(userId, cards) {
    const mine = [...this.calls.values()].filter(c => c.userId === userId);
    return mine.slice(-25).reverse().map(c => {
      const card = cards.get(c.cardId);
      return {
        id: c.id, cardId: c.cardId, pick: c.pickLabel, state: c.state,
        basePoints: c.basePoints, pointsAwarded: c.pointsAwarded || 0, mult: c.mult || 1,
        title: card?.title, question: card?.question, emoji: card?.emoji,
        clock: card?.clock, result: card?.result,
        receiptId: [...this.receipts.values()].find(r => r.body.callId === c.id)?.id || null,
      };
    });
  }
}

module.exports = { Game };
