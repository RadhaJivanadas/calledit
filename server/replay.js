'use strict';
/**
 * ReplayDriver — replays a captured TxLINE timeline (real historical data)
 * through the same ingest path the live driver uses.
 *
 * - `speed`×  wall-clock acceleration of event time
 * - dead-air gaps are compressed to `maxIdleGapMs` of wall time
 * - seek/play/pause/speed controls for demos
 * - loops by default so the deployed judge build is always mid-match
 */
const { EventEmitter } = require('events');
const fs = require('fs');

class ReplayDriver extends EventEmitter {
  constructor({ file, speed, maxIdleGapMs, leadInMs, loop }) {
    super();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.meta = data.meta;
    this.timeline = data.timeline;
    this.speed = speed;
    this.maxIdleGapMs = maxIdleGapMs;
    this.leadInMs = leadInMs;
    this.loop = loop;
    this.playing = false;
    this.ix = 0;
    this.timer = null;
    // start shortly before kickoff — skip days of pre-match odds
    this.startT = (this.meta.kickoffTs || this.timeline[0].t) - leadInMs;
  }

  start() {
    this.reset();
    this.play();
  }

  reset() {
    this.pause();
    this.emit('reset');
    this.ix = this.timeline.findIndex(x => x.t >= this.startT);
    if (this.ix < 0) this.ix = 0;
    // fast-forward the last state of each market into the engine so odds exist at kickoff
    const seed = new Map();
    for (let i = 0; i < this.ix; i++) {
      const x = this.timeline[i];
      if (x.kind === 'odds') seed.set(`${x.ev.SuperOddsType}|${x.ev.MarketParameters || ''}`, x);
      if (x.kind === 'score' && ['lineups', 'venue', 'weather', 'coverage_update'].includes(x.ev.Action)) this.emit('event', x.kind, x.ev);
    }
    for (const x of seed.values()) this.emit('event', x.kind, x.ev);
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.emit('playstate', true);
    this.scheduleNext(0);
  }

  pause() {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emit('playstate', false);
  }

  setSpeed(s) {
    this.speed = Math.max(0.5, Math.min(60, s));
  }

  /** Seek to a clock minute (match time). */
  seekToMinute(minute) {
    const wasPlaying = this.playing;
    this.pause();
    // find the first score event at/after that clock
    const targetSec = minute * 60;
    let targetIx = this.timeline.length - 1;
    for (let i = 0; i < this.timeline.length; i++) {
      const x = this.timeline[i];
      if (x.kind === 'score' && x.ev.Clock && x.ev.Clock.Seconds >= targetSec && x.ev.StatusId >= 2) { targetIx = i; break; }
    }
    this.emit('reset');
    // replay everything up to target instantly (state catch-up)
    for (let i = 0; i < targetIx; i++) {
      const x = this.timeline[i];
      this.emit('event', x.kind, x.ev, { catchup: true });
    }
    this.ix = targetIx;
    if (wasPlaying) this.play(); else this.emit('playstate', false);
  }

  scheduleNext(delayMs) {
    if (!this.playing) return;
    this.timer = setTimeout(() => this.step(), delayMs);
  }

  step() {
    if (!this.playing) return;
    if (this.ix >= this.timeline.length) {
      this.emit('finished');
      if (this.loop) setTimeout(() => this.start(), 12_000);
      return;
    }
    const x = this.timeline[this.ix++];
    this.emit('event', x.kind, x.ev);
    const next = this.timeline[this.ix];
    if (!next) return this.scheduleNext(10);
    const gap = Math.max(0, next.t - x.t) / this.speed;
    this.scheduleNext(Math.min(gap, this.maxIdleGapMs));
  }
}

module.exports = { ReplayDriver };
