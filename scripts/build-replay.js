#!/usr/bin/env node
/**
 * Builds a unified replay timeline from raw TxLINE historical data:
 *  - score events from /api/scores/historical/{fixtureId} (SSE-formatted file)
 *  - odds updates from /api/odds/updates/{epochDay}/{hour}/{interval}
 * Output: data/replays/<name>.json  { meta, timeline: [ {t, kind: 'score'|'odds', ev} ] }
 *
 * Usage: node scripts/build-replay.js <fixtureId> <name>
 */
const fs = require('fs');
const path = require('path');

const fixtureId = Number(process.argv[2] || 18237038);
const name = process.argv[3] || 'france-spain';
const rawDir = path.join(__dirname, '..', 'raw');
const outDir = path.join(__dirname, '..', 'data', 'replays');

function parseSseFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split(/\r?\n\r?\n/).map(block => {
    const lines = block.split(/\r?\n/).filter(l => l.startsWith('data:'));
    if (!lines.length) return null;
    try { return JSON.parse(lines.map(l => l.slice(5).trim()).join('')); } catch { return null; }
  }).filter(Boolean);
}

// score events
const scoreEvents = parseSseFile(path.join(rawDir, `hist-${fixtureId}.json`))
  .filter(e => e.FixtureId === fixtureId);

// odds updates from every ou-*.json window file present
const oddsEvents = [];
const seenMsg = new Set();
for (const f of fs.readdirSync(rawDir).filter(f => /^ou-\d+-\d+\.json$/.test(f))) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  for (const o of arr) {
    if (o.FixtureId !== fixtureId) continue;
    if (o.MessageId && seenMsg.has(o.MessageId)) continue;
    if (o.MessageId) seenMsg.add(o.MessageId);
    oddsEvents.push(o);
  }
}

// team names from lineups event
let teams = { 1: 'Home', 2: 'Away' };
const players = {};
for (const e of scoreEvents) {
  if (e.Lineups) {
    e.Lineups.forEach((t, i) => {
      teams[i + 1] = t.preferredName;
      for (const l of t.lineups || []) {
        if (l.player) {
          const nm = (l.player.preferredName || '').split(',').map(s => s.trim());
          const display = nm.length === 2 ? `${nm[1]} ${nm[0]}` : l.player.preferredName;
          players[l.player.normativeId] = display;
          // short id variant sometimes used in Data.PlayerId / PlayerStats
          players[l.fixturePlayerId] = display;
        }
      }
    });
  }
  if (e.PlayerStats) {
    // nothing to map here; ids should be covered above
  }
}
// PlayerStats ids are separate normative ids (short). Try match via lineups roster too.

// Thin the odds set so the replay file stays lean while preserving the
// markets the game engine actually prices from:
//  - 1X2 full history
//  - Over/Under goals lines 1.5, 2.5, 3.5
//  - Asian handicap line=0 only
// Pre-match noise: keep only the last 20 minutes before kickoff, plus one
// last-known update per market key before that cutoff.
const kickoffGuess = scoreEvents.find(e => e.Action === 'kickoff')?.Ts
  || scoreEvents[0]?.StartTime || oddsEvents[0]?.Ts;
const cutoff = kickoffGuess - 20 * 60 * 1000;

function marketKey(o) {
  return `${o.SuperOddsType}|${o.MarketParameters || ''}|${o.MarketPeriod || ''}`;
}
function keepMarket(o) {
  if (o.SuperOddsType === '1X2_PARTICIPANT_RESULT') return true;
  const line = /line=(-?[\d.]+)/.exec(o.MarketParameters || '')?.[1];
  if (o.SuperOddsType === 'OVERUNDER_PARTICIPANT_GOALS') return ['1.5', '2.5', '3.5'].includes(line);
  if (o.SuperOddsType === 'ASIANHANDICAP_PARTICIPANT_GOALS') return line === '0';
  return false;
}

const lastBeforeCutoff = new Map();
const keptOdds = [];
for (const o of oddsEvents.sort((a, b) => a.Ts - b.Ts)) {
  if (!keepMarket(o)) continue;
  if (o.Ts < cutoff) { lastBeforeCutoff.set(marketKey(o), o); continue; }
  keptOdds.push(o);
}
const seed = [...lastBeforeCutoff.values()].map(o => ({ ...o, Ts: cutoff }));
const finalOdds = [...seed, ...keptOdds];

const timeline = [
  ...scoreEvents.map(ev => ({ t: ev.Ts, kind: 'score', ev })),
  ...finalOdds.map(ev => ({ t: ev.Ts, kind: 'odds', ev })),
].sort((a, b) => a.t - b.t || (a.kind === 'score' ? -1 : 1));

const first = timeline[0]?.t, last = timeline[timeline.length - 1]?.t;
const kickoff = scoreEvents.find(e => e.Action === 'kickoff')?.Ts || first;
const finalEv = scoreEvents.find(e => e.Action === 'game_finalised');

const out = {
  meta: {
    fixtureId,
    name,
    source: 'TxLINE devnet historical API (real captured data)',
    endpoints: [
      `/api/scores/historical/${fixtureId}`,
      '/api/odds/updates/{epochDay}/{hour}/{interval}',
    ],
    teams,
    players,
    startTs: first,
    kickoffTs: kickoff,
    endTs: last,
    finalScore: finalEv?.Score || null,
    counts: { score: scoreEvents.length, odds: finalOdds.length },
  },
  timeline,
};

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${name}.json`);
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`wrote ${outFile}`);
console.log('teams:', JSON.stringify(teams), 'players mapped:', Object.keys(players).length);
console.log('events:', out.meta.counts, 'span min:', Math.round((last - first) / 60000));
