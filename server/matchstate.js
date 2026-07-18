'use strict';
/**
 * MatchState consumes raw TxLINE events (score stream + StablePrice odds) and
 * maintains everything the UI and the prophecy engine need:
 *   - score / clock / status (VAR-safe: goals can be amended and discarded)
 *   - possession phase + a decaying "danger" meter per team
 *   - implied probabilities from 1X2, O/U goals and AH(0) StablePrice markets
 *   - a human feed of match moments
 *
 * Emits semantic events:
 *   'phase'        {team, level, action}
 *   'threat'       {team, level, prob}        — danger spike worth a moment card
 *   'goal'         {team, playerId, clockSec, ts, provisional:true}
 *   'goal_confirmed' / 'goal_discarded'
 *   'corner' 'yellow' 'red' {team, clockSec, ts}
 *   'penalty_awarded' {team} / 'penalty_outcome' {team, scored}
 *   'var_start' / 'var_end' {overturned}
 *   'status' {statusId, phase}
 *   'finalised' {score}
 *   'odds' {probs, ouNext, ah}
 *   'feed' {icon, text, team, clockSec, ts}
 */
const { EventEmitter } = require('events');

const PHASE_LEVEL = {
  safe_possession: 1, possession: 1, throw_in: 1, goal_kick: 1, free_kick: 1,
  attack_possession: 2, corner: 2,
  danger_possession: 3,
  high_danger_possession: 4,
};

const STATUS_PHASE = { 1: 'pre', 2: '1H', 3: 'HT', 4: '2H', 5: 'FT', 100: 'FT' };

class MatchState extends EventEmitter {
  constructor({ fixtureId, teams, players }) {
    super();
    this.fixtureId = fixtureId;
    this.teams = teams || { 1: 'Home', 2: 'Away' };
    this.players = players || {};
    this.now = 0;                    // event-time ms of last processed event
    this.statusId = 1;
    this.phaseName = 'pre';
    this.clockSec = 0;
    this.clockRunning = false;
    this.clockAnchorTs = 0;          // event ts when clockSec was set
    this.score = { 1: 0, 2: 0 };
    this.corners = { 1: 0, 2: 0 };
    this.yellows = { 1: 0, 2: 0 };
    this.reds = { 1: 0, 2: 0 };
    this.possession = { team: null, level: 0, action: null, sinceTs: 0 };
    this.danger = { 1: 0, 2: 0 };    // 0..100, decayed on tick
    this.lastDangerUpdate = 0;
    this.pulse = [];                 // [{t, d1, d2}] sampled ring buffer
    this.probs = null;               // {home, draw, away}
    this.probsHist = [];             // [{t, home, draw, away}]
    this.ouNext = null;              // {line, over, under} first line above current total
    this.ou = new Map();             // line -> {over, under, ts}
    this.ah0 = null;                 // {p1, p2}
    this.feed = [];
    this.varPending = false;
    this.pendingGoals = [];          // provisional goals awaiting confirmation
    this.finalised = false;
    this.seq = 0;
  }

  teamName(p) { return this.teams[p] || `Team ${p}`; }
  playerName(id) { return this.players[id] || null; }

  displayClock() {
    let sec = this.clockSec;
    if (this.clockRunning && this.now > this.clockAnchorTs) {
      sec += Math.floor((this.now - this.clockAnchorTs) / 1000);
    }
    const halfCap = this.statusId === 2 ? 45 * 60 : 90 * 60;
    const base = Math.min(sec, halfCap + 15 * 60);
    const m = Math.floor(base / 60), s = base % 60;
    return { sec: base, label: `${m}'${String(s).padStart(2, '0')}` };
  }

  pushFeed(icon, text, team = null) {
    const item = { id: ++this.seq, t: this.now, clock: this.displayClock().label, icon, text, team };
    this.feed.push(item);
    if (this.feed.length > 40) this.feed.shift();
    this.emit('feed', item);
  }

  /* ---------------- danger meter ---------------- */

  decayDanger() {
    const dtSec = Math.max(0, (this.now - this.lastDangerUpdate) / 1000);
    if (dtSec > 0) {
      const k = Math.exp(-dtSec / 25);
      this.danger[1] *= k; this.danger[2] *= k;
      this.lastDangerUpdate = this.now;
    }
  }

  bumpDanger(team, amount) {
    this.decayDanger();
    this.danger[team] = Math.min(100, this.danger[team] + amount);
    this.samplePulse();
  }

  samplePulse() {
    const last = this.pulse[this.pulse.length - 1];
    if (last && this.now - last.t < 2000) {
      last.d1 = Math.round(this.danger[1]); last.d2 = Math.round(this.danger[2]);
      return;
    }
    this.pulse.push({ t: this.now, d1: Math.round(this.danger[1]), d2: Math.round(this.danger[2]) });
    if (this.pulse.length > 240) this.pulse.shift();
  }

  /* ---------------- goal confirmation ----------------
   * TxLINE sends goals as bursts of amendments (same clock second) and can
   * later discard one via VAR (`var_end` Outcome=Overturned + `action_discarded`).
   * We treat a goal as provisional for 20s of event time; a discard within
   * that window cancels it, otherwise it confirms.
   */
  registerGoal(ev) {
    const team = ev.Participant;
    const clockSec = ev.Clock?.Seconds ?? this.clockSec;
    const existing = this.pendingGoals.find(g => g.team === team && Math.abs(g.clockSec - clockSec) <= 90 && !g.done);
    if (existing) {
      if (ev.Data?.PlayerId && !existing.playerId) {
        existing.playerId = ev.Data.PlayerId;
        this.emit('goal_amended', existing);
      }
      return;
    }
    const g = {
      team, clockSec, ts: ev.Ts, playerId: ev.Data?.PlayerId || null,
      seq: ev.Seq, confirmAt: ev.Ts + 20_000, done: false,
    };
    this.pendingGoals.push(g);
    this.emit('goal', { ...g, provisional: true });
    this.pushFeed('⚽', `GOAL! ${this.teamName(team)} score!`, team);
  }

  settlePendingGoals() {
    for (const g of this.pendingGoals) {
      if (!g.done && this.now >= g.confirmAt) {
        g.done = true; g.confirmed = true;
        if (g.playerId && this.playerName(g.playerId)) {
          this.pushFeed('🎯', `Scorer confirmed: ${this.playerName(g.playerId)}`, g.team);
        }
        this.emit('goal_confirmed', g);
      }
    }
  }

  discardLastGoal() {
    const g = [...this.pendingGoals].reverse().find(x => !x.done || (x.confirmed && this.now - x.ts < 120_000));
    if (g) {
      g.done = true; g.confirmed = false; g.discarded = true;
      this.pushFeed('🚫', `Goal OVERTURNED by VAR — ${this.teamName(g.team)}`, g.team);
      this.emit('goal_discarded', g);
    }
  }

  /* ---------------- ingest ---------------- */

  ingest(kind, ev) {
    if (!ev || (this.fixtureId && ev.FixtureId && ev.FixtureId !== this.fixtureId)) return;
    this.now = Math.max(this.now, ev.Ts || 0);
    if (kind === 'odds') return this.ingestOdds(ev);
    return this.ingestScore(ev);
  }

  ingestScore(ev) {
    // live streams have no backfill, so we replay /api/scores/snapshot on
    // (re)connect; the Seq guard keeps snapshot + stream overlap idempotent
    if (typeof ev.Seq === 'number') {
      if (ev.Seq <= (this.lastSeq ?? -1)) return;
      this.lastSeq = ev.Seq;
    }
    const a = ev.Action;
    // team + player names arrive on the stream (live mode) via lineups events
    if (ev.Lineups) {
      ev.Lineups.forEach((t, i) => {
        if (t.preferredName) this.teams[i + 1] = t.preferredName;
        for (const l of t.lineups || []) {
          if (l.player?.preferredName) {
            const nm = l.player.preferredName.split(',').map(s => s.trim());
            const display = nm.length === 2 ? `${nm[1]} ${nm[0]}` : l.player.preferredName;
            if (l.player.normativeId != null) this.players[l.player.normativeId] = display;
            if (l.fixturePlayerId != null) this.players[l.fixturePlayerId] = display;
          }
        }
      });
    }
    if (ev.Clock && typeof ev.Clock.Seconds === 'number') {
      this.clockSec = ev.Clock.Seconds;
      this.clockRunning = !!ev.Clock.Running;
      this.clockAnchorTs = ev.Ts;
    }
    if (ev.StatusId && ev.StatusId !== this.statusId && STATUS_PHASE[ev.StatusId]) {
      const prev = this.phaseName;
      this.statusId = ev.StatusId;
      this.phaseName = STATUS_PHASE[ev.StatusId] || this.phaseName;
      if (prev !== this.phaseName) {
        const msg = { '1H': '🟢 Kick-off! We are live.', HT: '⏸ Half-time.', '2H': '🟢 Second half under way!', FT: '🏁 Full-time.' }[this.phaseName];
        if (msg) this.pushFeed('📣', msg);
        this.emit('status', { statusId: this.statusId, phase: this.phaseName });
      }
    }
    // authoritative score from Score object (self-corrects on VAR discard)
    if (ev.Score) {
      const s1 = ev.Score.Participant1?.Total?.Goals || 0;
      const s2 = ev.Score.Participant2?.Total?.Goals || 0;
      this.score = { 1: s1, 2: s2 };
      const c1 = ev.Score.Participant1?.Total?.Corners || 0;
      const c2 = ev.Score.Participant2?.Total?.Corners || 0;
      this.corners = { 1: c1, 2: c2 };
      this.yellows = {
        1: ev.Score.Participant1?.Total?.YellowCards || 0,
        2: ev.Score.Participant2?.Total?.YellowCards || 0,
      };
    }

    const team = ev.Participant;
    switch (a) {
      case 'kickoff':
        this.emit('kickoff', { ts: ev.Ts });
        break;
      case 'safe_possession': case 'possession': case 'attack_possession':
      case 'danger_possession': case 'high_danger_possession': {
        const level = PHASE_LEVEL[a] || 1;
        this.possession = { team, level, action: a, sinceTs: ev.Ts };
        if (level >= 2 && team) this.bumpDanger(team, level === 2 ? 6 : level === 3 ? 18 : 32);
        else this.decayDanger(), this.samplePulse();
        this.emit('phase', { team, level, action: a });
        if (level >= 3 && team) {
          this.emit('threat', { team, level, ts: ev.Ts });
        }
        break;
      }
      case 'possible': {
        if (ev.Data?.Goal && team) {
          this.bumpDanger(team, 40);
          this.emit('threat', { team, level: 5, ts: ev.Ts });
        }
        if (ev.Data?.VAR || ev.PossibleEvent?.VAR) {
          // early VAR hint — treated as var_start below when 'var' arrives
        }
        break;
      }
      case 'shot':
        if (team) { this.bumpDanger(team, 22); this.pushFeed('🥅', `Shot from ${this.teamName(team)}!`, team); }
        this.emit('shot', { team, ts: ev.Ts });
        break;
      case 'corner':
        if (team) {
          this.pushFeed('🚩', `Corner to ${this.teamName(team)}`, team);
          this.emit('corner', { team, ts: ev.Ts, clockSec: this.clockSec });
        }
        break;
      case 'yellow_card':
        if (team) {
          this.pushFeed('🟨', `Yellow card — ${this.teamName(team)}${ev.Data?.PlayerId && this.playerName(ev.Data.PlayerId) ? ` (${this.playerName(ev.Data.PlayerId)})` : ''}`, team);
          this.emit('yellow', { team, ts: ev.Ts, clockSec: this.clockSec });
        }
        break;
      case 'red_card':
        if (team) {
          this.reds[team] += 1;
          this.pushFeed('🟥', `RED CARD — ${this.teamName(team)}!`, team);
          this.emit('red', { team, ts: ev.Ts });
        }
        break;
      case 'penalty':
        if (team) {
          this.pushFeed('⚠️', `PENALTY to ${this.teamName(team)}!`, team);
          this.emit('penalty_awarded', { team, ts: ev.Ts });
        }
        break;
      case 'penalty_outcome': {
        const scored = ev.Data?.Outcome === 'Scored';
        if (team) {
          this.pushFeed(scored ? '⚽' : '🧤', scored ? `Penalty SCORED — ${this.teamName(team)}!` : `Penalty missed — ${this.teamName(team)}!`, team);
          this.emit('penalty_outcome', { team, scored, ts: ev.Ts });
          if (scored) this.registerGoal({ ...ev, Action: 'goal' });
        }
        break;
      }
      case 'goal':
        if (team) this.registerGoal(ev);
        break;
      case 'var':
        if (!this.varPending) {
          this.varPending = true;
          this.pushFeed('📺', `VAR check in progress${ev.Data?.Type ? ` — ${ev.Data.Type}` : ''}…`);
          this.emit('var_start', { type: ev.Data?.Type || null, ts: ev.Ts });
        }
        break;
      case 'var_end': {
        this.varPending = false;
        const overturned = ev.Data?.Outcome === 'Overturned';
        this.pushFeed('📺', overturned ? 'VAR: decision OVERTURNED' : 'VAR: decision stands');
        this.emit('var_end', { overturned, ts: ev.Ts });
        if (overturned) this.discardLastGoal();
        break;
      }
      case 'action_discarded':
        // score object already corrected above; goal cancel handled in var_end path
        break;
      case 'substitution':
        if (team) this.pushFeed('🔁', `Substitution — ${this.teamName(team)}`, team);
        break;
      case 'injury':
        if (team) this.pushFeed('🚑', `Player down — ${this.teamName(team)}`, team);
        break;
      case 'additional_time':
        if (ev.Data?.Minutes) this.pushFeed('⏱', `+${ev.Data.Minutes} added minutes`);
        break;
      case 'game_finalised':
        this.finalised = true;
        this.pushFeed('🏆', `FULL TIME: ${this.teamName(1)} ${this.score[1]}–${this.score[2]} ${this.teamName(2)}`);
        this.emit('finalised', { score: { ...this.score }, ts: ev.Ts, seq: ev.Seq });
        break;
      default:
        break;
    }
    this.settlePendingGoals();
    this.decayDanger();
  }

  ingestOdds(ev) {
    if (ev.Bookmaker && !/StablePrice/i.test(ev.Bookmaker)) return;
    // full-time markets only — half markets (e.g. MarketPeriod "half=1") would
    // oscillate against them and mislead the win-prob display
    if (ev.MarketPeriod) return;
    const prices = ev.Prices || [];
    const names = ev.PriceNames || [];
    const implied = prices.map(p => (p > 0 ? 1000 / p : 0));
    const total = implied.reduce((a, b) => a + b, 0) || 1;
    const norm = implied.map(x => x / total);
    const get = n => { const i = names.indexOf(n); return i >= 0 ? norm[i] : null; };

    if (ev.SuperOddsType === '1X2_PARTICIPANT_RESULT') {
      const probs = { home: get('part1'), draw: get('draw'), away: get('part2'), ts: ev.Ts };
      if (probs.home != null) {
        const prev = this.probs;
        this.probs = probs;
        const last = this.probsHist[this.probsHist.length - 1];
        if (!last || ev.Ts - last.t > 5000) {
          this.probsHist.push({ t: ev.Ts, h: +probs.home.toFixed(4), d: +probs.draw.toFixed(4), a: +probs.away.toFixed(4) });
          if (this.probsHist.length > 300) this.probsHist.shift();
        } else {
          Object.assign(last, { h: +probs.home.toFixed(4), d: +probs.draw.toFixed(4), a: +probs.away.toFixed(4) });
        }
        const ann = this.lastAnnouncedProbs;
        if (ann && Math.abs(ann.home - probs.home) > 0.08 && ev.Ts - (ann.ts || 0) > 90_000) {
          this.pushFeed('📈', `Big market move: ${this.teamName(1)} ${Math.round(probs.home * 100)}% · draw ${Math.round(probs.draw * 100)}% · ${this.teamName(2)} ${Math.round(probs.away * 100)}%`);
          this.lastAnnouncedProbs = probs;
        } else if (!ann) {
          this.lastAnnouncedProbs = probs;
        }
        this.emit('odds', this.snapshotOdds());
      }
    } else if (ev.SuperOddsType === 'OVERUNDER_PARTICIPANT_GOALS') {
      const line = Number(/line=(-?[\d.]+)/.exec(ev.MarketParameters || '')?.[1]);
      if (!Number.isNaN(line)) {
        const over = get('over') ?? norm[0], under = get('under') ?? norm[1];
        this.ou.set(line, { over, under, ts: ev.Ts });
        const totalGoals = this.score[1] + this.score[2];
        const lines = [...this.ou.keys()].sort((a, b) => a - b);
        const next = lines.find(l => l > totalGoals);
        if (next != null) this.ouNext = { line: next, ...this.ou.get(next) };
      }
    } else if (ev.SuperOddsType === 'ASIANHANDICAP_PARTICIPANT_GOALS') {
      const line = /line=(-?[\d.]+)/.exec(ev.MarketParameters || '')?.[1];
      if (line === '0') {
        this.ah0 = { p1: get('part1') ?? norm[0], p2: get('part2') ?? norm[1], ts: ev.Ts };
      }
    }
  }

  snapshotOdds() {
    return { probs: this.probs, ouNext: this.ouNext, ah0: this.ah0 };
  }

  /** Probability the next goal (if any) belongs to team t — from AH(0) with 1X2 fallback. */
  nextGoalShare(t) {
    if (this.ah0) return t === 1 ? this.ah0.p1 : this.ah0.p2;
    if (this.probs) {
      const h = this.probs.home + this.probs.draw / 2, a = this.probs.away + this.probs.draw / 2;
      return (t === 1 ? h : a) / (h + a);
    }
    return 0.5;
  }

  /** Probability of at least one more goal, from the O/U ladder. */
  moreGoalsProb() {
    if (this.ouNext) return Math.min(0.95, Math.max(0.05, this.ouNext.over));
    const mins = Math.max(0, 90 - this.displayClock().sec / 60);
    return Math.min(0.95, 1 - Math.exp(-2.6 * (mins / 90)));
  }

  publicState() {
    const clock = this.displayClock();
    this.decayDanger();
    return {
      fixtureId: this.fixtureId,
      teams: this.teams,
      status: this.phaseName,
      statusId: this.statusId,
      clock: clock.label,
      clockSec: clock.sec,
      clockRunning: this.clockRunning,
      score: this.score,
      corners: this.corners,
      yellows: this.yellows,
      reds: this.reds,
      danger: { 1: Math.round(this.danger[1]), 2: Math.round(this.danger[2]) },
      possession: this.possession,
      probs: this.probs,
      probsHist: this.probsHist.slice(-120),
      pulse: this.pulse.slice(-120),
      ouNext: this.ouNext,
      feed: this.feed.slice(-30).reverse(),
      varPending: this.varPending,
      finalised: this.finalised,
      now: this.now,
    };
  }
}

module.exports = { MatchState };
