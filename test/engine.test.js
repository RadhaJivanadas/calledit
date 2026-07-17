'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { MatchState } = require('../server/matchstate');
const { ProphecyEngine, pts } = require('../server/prophecy');
const { ReceiptAnchor } = require('../server/receipts');
const crypto = require('crypto');

const mk = () => new MatchState({ fixtureId: 1, teams: { 1: 'France', 2: 'Spain' } });

const score = (m, action, extra = {}) => m.ingest('score', {
  FixtureId: 1, Ts: extra.Ts, Action: action, ...extra,
});

test('points scale with boldness and clamp', () => {
  assert.ok(pts(0.5) === 60);
  assert.ok(pts(0.1) > pts(0.3));
  assert.ok(pts(0.001) <= 600);
  assert.ok(pts(0.999) >= 20);
  assert.ok(Number.isFinite(pts(NaN)));
});

test('goal confirms after 20s of event time', () => {
  const m = mk();
  let confirmed = 0;
  m.on('goal_confirmed', () => confirmed++);
  score(m, 'kickoff', { Ts: 1000, StatusId: 2 });
  score(m, 'goal', { Ts: 5000, Participant: 2, Clock: { Running: true, Seconds: 100 } });
  assert.equal(confirmed, 0);
  score(m, 'safe_possession', { Ts: 26_000, Participant: 1 });
  assert.equal(confirmed, 1);
});

test('VAR overturn cancels a provisional goal', () => {
  const m = mk();
  let confirmed = 0, discarded = 0;
  m.on('goal_confirmed', () => confirmed++);
  m.on('goal_discarded', () => discarded++);
  score(m, 'kickoff', { Ts: 1000, StatusId: 2 });
  score(m, 'goal', { Ts: 5000, Participant: 2, Clock: { Running: true, Seconds: 100 } });
  score(m, 'var', { Ts: 9000 });
  score(m, 'var_end', { Ts: 15_000, Data: { Outcome: 'Overturned' } });
  score(m, 'safe_possession', { Ts: 40_000, Participant: 1 });
  assert.equal(discarded, 1);
  assert.equal(confirmed, 0);
});

test('goal amendments dedupe into one goal', () => {
  const m = mk();
  let goals = 0;
  m.on('goal', () => goals++);
  score(m, 'kickoff', { Ts: 1000, StatusId: 2 });
  score(m, 'goal', { Ts: 5000, Participant: 2, Clock: { Running: true, Seconds: 100 } });
  score(m, 'goal', { Ts: 5100, Participant: 2, Clock: { Running: true, Seconds: 100 }, Data: { PlayerId: 7 } });
  assert.equal(goals, 1);
});

test('moment card opens on threat and settles NO on window expiry', () => {
  const m = mk();
  const e = new ProphecyEngine(m, { sessionId: 't' });
  const settled = [];
  e.on('card_settled', c => settled.push(c));
  score(m, 'kickoff', { Ts: 1000, StatusId: 2, Clock: { Running: true, Seconds: 0 } });
  score(m, 'danger_possession', { Ts: 10_000, Participant: 2, StatusId: 2 });
  e.tick();
  const moment = [...e.cards.values()].find(c => c.type === 'moment_goal');
  assert.ok(moment, 'moment card created');
  // expire the window (120s + 25s grace)
  score(m, 'safe_possession', { Ts: 160_000, Participant: 1 });
  e.tick();
  assert.equal(moment.state, 'settled');
  assert.equal(moment.result, 'no');
});

test('moment card settles YES on confirmed goal inside window', () => {
  const m = mk();
  const e = new ProphecyEngine(m, { sessionId: 't2' });
  score(m, 'kickoff', { Ts: 1000, StatusId: 2, Clock: { Running: true, Seconds: 0 } });
  score(m, 'danger_possession', { Ts: 10_000, Participant: 2, StatusId: 2 });
  e.tick();
  score(m, 'goal', { Ts: 60_000, Participant: 2, Clock: { Running: true, Seconds: 59 } });
  score(m, 'attack_possession', { Ts: 85_000, Participant: 1 }); // confirms goal (>20s)
  e.tick();
  const moment = [...e.cards.values()].find(c => c.type === 'moment_goal');
  assert.equal(moment.state, 'settled');
  assert.equal(moment.result, 'yes');
});

test('receipt verification chain recomputes', () => {
  const body = { v: 1, callId: 'x', pick: 'Scored' };
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const root = crypto.createHash('sha256').update([hash].join('')).digest('hex');
  const receipt = { body, hash, anchor: { batch: [hash], root } };
  const v = ReceiptAnchor.verify(receipt);
  assert.equal(v.hashOk, true);
  assert.equal(v.rootOk, true);
  receipt.body.pick = 'Missed';
  assert.equal(ReceiptAnchor.verify(receipt).hashOk, false);
});
