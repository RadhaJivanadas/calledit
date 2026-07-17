'use strict';
/**
 * ProphecyEngine — turns live MatchState into playable "calls".
 *
 * Card lifecycle: open -> locked (no more entries) -> settled | void
 * All timing runs on EVENT time (stream Ts), so replay speed never breaks logic.
 *
 * Pricing: every option carries an implied probability. StablePrice markets
 * (1X2, O/U goals ladder, AH0) price the standing cards; moment cards use
 * danger-calibrated base rates. Points grow with boldness:
 *    pts(p) = clamp(round5(60 * (1-p)/p), 20, 600)
 */
const { EventEmitter } = require('events');

const pts = p => {
  const clamped = Math.min(0.97, Math.max(0.03, Number.isFinite(p) ? p : 0.5));
  const raw = 60 * (1 - clamped) / clamped;
  return Math.max(20, Math.min(600, Math.round(raw / 5) * 5));
};

let cardSeq = 0;

class ProphecyEngine extends EventEmitter {
  constructor(match, { sessionId }) {
    super();
    this.m = match;
    this.sessionId = sessionId;
    this.cards = new Map();          // id -> card
    this.cooldown = { 1: 0, 2: 0 };  // moment-card cooldown per team (event ts)
    this.standingRotation = ['corner', 'yellow'];
    this.rotationIx = 0;
    this.lastRotationAt = 0;
    this.wire(match);
  }

  wire(m) {
    m.on('threat', t => this.onThreat(t));
    m.on('goal_confirmed', g => this.onGoalConfirmed(g));
    m.on('goal_discarded', g => this.onGoalDiscarded(g));
    m.on('corner', c => this.settleEventCards('corner', c));
    m.on('yellow', y => this.settleEventCards('yellow', y));
    m.on('penalty_awarded', p => this.onPenalty(p));
    m.on('penalty_outcome', o => this.settlePenalty(o));
    m.on('var_start', v => this.onVar(v));
    m.on('var_end', v => this.settleVar(v));
    m.on('status', s => this.onStatus(s));
    m.on('kickoff', () => this.ensureStandingCards());
    m.on('finalised', f => this.onFinal(f));
  }

  /* -------- housekeeping: call on every processed event -------- */
  tick() {
    const now = this.m.now;
    for (const c of this.cards.values()) {
      if (c.state === 'open' && now >= c.locksAtT) {
        c.state = 'locked';
        this.emit('card_update', c);
      }
      if (c.state === 'locked' && c.windowEndT && now >= c.windowEndT + (c.graceMs || 0)) {
        // window expired: settle to the "no" style option
        if (c.expiryResult) this.settle(c, c.expiryResult, { reason: 'window elapsed' });
      }
    }
    if (this.m.statusId >= 2 && !this.m.finalised) this.ensureStandingCards();
  }

  open(card) {
    card.id = `${this.sessionId}:${++cardSeq}`;
    card.state = 'open';
    card.createdT = this.m.now;
    card.clock = this.m.displayClock().label;
    this.cards.set(card.id, card);
    this.emit('card_new', card);
    return card;
  }

  settle(card, resultKey, evidence = {}) {
    if (card.state === 'settled' || card.state === 'void') return;
    card.state = 'settled';
    card.result = resultKey;
    card.settledT = this.m.now;
    card.evidence = { ...evidence, fixtureId: this.m.fixtureId };
    this.emit('card_settled', card);
  }

  voidCard(card, reason) {
    if (card.state === 'settled' || card.state === 'void') return;
    card.state = 'void';
    card.voidReason = reason;
    this.emit('card_settled', card);
  }

  openCards() {
    return [...this.cards.values()].filter(c => c.state === 'open' || c.state === 'locked');
  }

  /* ---------------- moment cards ---------------- */

  onThreat({ team, level, ts }) {
    if (this.m.statusId < 2 || this.m.finalised || this.m.varPending) return;
    if (ts < this.cooldown[team]) return;
    const hasOpenMoment = this.openCards().some(c => c.type === 'moment_goal' && c.team === team);
    if (hasOpenMoment) return;
    const p = level >= 5 ? 0.30 : level === 4 ? 0.22 : 0.14;
    this.cooldown[team] = ts + 150_000;
    const name = this.m.teamName(team);
    this.open({
      type: 'moment_goal',
      team,
      emoji: '🔥',
      title: `${name} are surging!`,
      question: `Goal for ${name} in the next 2 minutes?`,
      options: [
        { key: 'yes', label: 'CALL IT — they score', prob: p, points: pts(p) },
        { key: 'no', label: 'No goal', prob: 1 - p, points: pts(1 - p) },
      ],
      locksAtT: ts + 40_000,
      windowEndT: ts + 120_000,
      graceMs: 25_000,          // let a provisional goal confirm before expiring
      expiryResult: 'no',
      hot: true,
    });
  }

  onGoalConfirmed(g) {
    // moment cards for the scoring team whose window covers the goal
    for (const c of this.openCards()) {
      if (c.type === 'moment_goal') {
        if (c.team === g.team && g.ts >= c.createdT && g.ts <= c.windowEndT) {
          this.settle(c, 'yes', { action: 'goal_confirmed', eventTs: g.ts, seq: g.seq, player: this.m.playerName(g.playerId) });
        }
      }
      if (c.type === 'next_goal') {
        this.settle(c, `team${g.team}`, { action: 'goal_confirmed', eventTs: g.ts, seq: g.seq, player: this.m.playerName(g.playerId) });
      }
    }
    this.ensureStandingCards();
  }

  onGoalDiscarded() {
    // A provisional goal that settled a card and was then overturned is rare
    // (20s confirm delay absorbs VAR); nothing to unwind here by design.
  }

  /* ---------------- specials ---------------- */

  onPenalty({ team, ts }) {
    // penalty events arrive as amendment bursts — one card per award
    if (this.openCards().some(c => c.type === 'penalty' && c.team === team)) return;
    const name = this.m.teamName(team);
    const p = 0.76;
    this.open({
      type: 'penalty',
      team,
      emoji: '⚠️',
      title: `PENALTY — ${name}!`,
      question: 'From the spot… scored or not?',
      options: [
        { key: 'scored', label: 'Scored', prob: p, points: pts(p) },
        { key: 'missed', label: 'Missed / saved', prob: 1 - p, points: pts(1 - p) },
      ],
      locksAtT: ts + 20_000,
      hot: true,
    });
  }

  settlePenalty({ team, scored, ts }) {
    for (const c of this.openCards()) {
      if (c.type === 'penalty' && c.team === team) {
        this.settle(c, scored ? 'scored' : 'missed', { action: 'penalty_outcome', eventTs: ts });
      }
    }
  }

  onVar({ type, ts }) {
    const p = 0.45;
    this.open({
      type: 'var',
      emoji: '📺',
      title: `VAR is checking${type ? ` — ${type}` : ''}…`,
      question: 'Will the on-field decision stand?',
      options: [
        { key: 'stands', label: 'Decision stands', prob: p, points: pts(p) },
        { key: 'overturned', label: 'Overturned', prob: 1 - p, points: pts(1 - p) },
      ],
      locksAtT: ts + 15_000,
      hot: true,
    });
  }

  settleVar({ overturned, ts }) {
    for (const c of this.openCards()) {
      if (c.type === 'var') {
        this.settle(c, overturned ? 'overturned' : 'stands', { action: 'var_end', eventTs: ts });
      }
    }
  }

  /* ---------------- standing cards ---------------- */

  ensureStandingCards() {
    if (this.m.statusId < 2 || this.m.finalised) return;
    const open = this.openCards();
    if (!open.some(c => c.type === 'next_goal')) this.openNextGoal();
    if (!open.some(c => c.type === 'corner' || c.type === 'yellow')) this.openRotating();
  }

  openNextGoal() {
    const m = this.m;
    const safe = (x, d) => (Number.isFinite(x) ? x : d);
    const pMore = safe(m.moreGoalsProb(), 0.6);
    const s1 = safe(m.nextGoalShare(1), 0.5), s2 = safe(m.nextGoalShare(2), 0.5);
    const p1 = pMore * s1, p2 = pMore * s2, p0 = 1 - pMore;
    this.open({
      type: 'next_goal',
      emoji: '⚽',
      title: 'Next goal',
      question: 'Who scores the next goal?',
      options: [
        { key: 'team1', label: m.teamName(1), prob: p1, points: pts(p1) },
        { key: 'team2', label: m.teamName(2), prob: p2, points: pts(p2) },
        { key: 'none', label: 'No more goals', prob: p0, points: pts(p0) },
      ],
      locksAtT: Infinity,      // open until it settles (entries priced at lock time)
      priced: 'StablePrice O/U ladder + AH0',
    });
  }

  openRotating() {
    const kind = this.standingRotation[this.rotationIx++ % this.standingRotation.length];
    const m = this.m;
    const ts = m.now;
    if (kind === 'corner') {
      const p = 0.62;
      this.open({
        type: 'corner',
        emoji: '🚩',
        title: 'Corner watch',
        question: 'A corner inside the next 8 minutes?',
        options: [
          { key: 'yes', label: 'Yes', prob: p, points: pts(p) },
          { key: 'no', label: 'No', prob: 1 - p, points: pts(1 - p) },
        ],
        locksAtT: ts + 120_000,
        windowEndT: ts + 8 * 60_000,
        expiryResult: 'no',
      });
    } else {
      const p = 0.42;
      this.open({
        type: 'yellow',
        emoji: '🟨',
        title: 'Card watch',
        question: 'A yellow card inside the next 10 minutes?',
        options: [
          { key: 'yes', label: 'Yes', prob: p, points: pts(p) },
          { key: 'no', label: 'No', prob: 1 - p, points: pts(1 - p) },
        ],
        locksAtT: ts + 120_000,
        windowEndT: ts + 10 * 60_000,
        expiryResult: 'no',
      });
    }
  }

  settleEventCards(type, evd) {
    for (const c of this.openCards()) {
      if (c.type === type && evd.ts >= c.createdT && (!c.windowEndT || evd.ts <= c.windowEndT)) {
        this.settle(c, 'yes', { action: type, eventTs: evd.ts });
      }
    }
  }

  onStatus({ phase }) {
    if (phase === 'HT') {
      // freeze moment cards over the break
      for (const c of this.openCards()) {
        if (c.type === 'moment_goal') this.voidCard(c, 'half-time');
      }
    }
  }

  onFinal({ ts, seq }) {
    for (const c of this.openCards()) {
      if (c.type === 'next_goal') this.settle(c, 'none', { action: 'game_finalised', eventTs: ts, seq });
      else if (c.expiryResult) this.settle(c, c.expiryResult, { action: 'game_finalised', eventTs: ts, seq });
      else this.voidCard(c, 'full-time');
    }
  }

  publicCards() {
    const now = this.m.now;
    const all = [...this.cards.values()];
    const active = all.filter(c => c.state === 'open' || c.state === 'locked');
    const recent = all.filter(c => (c.state === 'settled' || c.state === 'void') && now - (c.settledT || 0) < 45_000);
    return [...active, ...recent].map(c => ({
      id: c.id, type: c.type, emoji: c.emoji, title: c.title, question: c.question,
      options: c.options, state: c.state, result: c.result || null,
      clock: c.clock, hot: !!c.hot, team: c.team || null,
      createdT: c.createdT,
      locksAtT: c.locksAtT === Infinity ? null : c.locksAtT,
      windowEndT: c.windowEndT || null,
      priced: c.priced || null,
    }));
  }
}

module.exports = { ProphecyEngine, pts };
