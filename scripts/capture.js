#!/usr/bin/env node
/**
 * Captures a real completed fixture from the TxLINE API into raw/ and builds
 * a replay file from it. Requires an activated TxLINE API token.
 *
 * Usage:
 *   TXLINE_API_TOKEN=... node scripts/capture.js                 # list fixtures
 *   TXLINE_API_TOKEN=... node scripts/capture.js <fixtureId> <name>
 *
 * TxLINE endpoints used:
 *   POST /auth/guest/start
 *   GET  /api/fixtures/snapshot
 *   GET  /api/scores/historical/{fixtureId}   (fixtures 6h..2weeks in the past)
 *   GET  /api/odds/updates/{epochDay}/{hourOfDay}/{interval}
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST = process.env.TXLINE_BASE_URL || 'https://txline-dev.txodds.com';
const TOKEN = process.env.TXLINE_API_TOKEN;
if (!TOKEN) { console.error('Set TXLINE_API_TOKEN'); process.exit(1); }

const rawDir = path.join(__dirname, '..', 'raw');
fs.mkdirSync(rawDir, { recursive: true });

async function main() {
  const { token: jwt } = await (await fetch(`${HOST}/auth/guest/start`, { method: 'POST' })).json();
  const H = { Authorization: `Bearer ${jwt}`, 'X-Api-Token': TOKEN };

  const fixtureId = Number(process.argv[2]);
  if (!fixtureId) {
    const fixtures = await (await fetch(`${HOST}/api/fixtures/snapshot`, { headers: H })).json();
    console.log('Known fixtures (pass an id of a match that finished 6h..2weeks ago):');
    for (const f of fixtures.sort((a, b) => a.StartTime - b.StartTime)) {
      console.log(` ${f.FixtureId}  ${new Date(f.StartTime).toISOString()}  ${f.Participant1} vs ${f.Participant2}`);
    }
    return;
  }
  const name = process.argv[3] || `fixture-${fixtureId}`;

  console.log(`Fetching historical scores for ${fixtureId}…`);
  const hist = await (await fetch(`${HOST}/api/scores/historical/${fixtureId}`, { headers: H })).text();
  fs.writeFileSync(path.join(rawDir, `hist-${fixtureId}.json`), hist);

  // find the match window from the score events to know which odds windows to pull
  const events = hist.split(/\r?\n\r?\n/).map(b => {
    const l = b.split(/\r?\n/).filter(x => x.startsWith('data:'));
    try { return l.length ? JSON.parse(l.map(x => x.slice(5).trim()).join('')) : null; } catch { return null; }
  }).filter(Boolean);
  if (!events.length) { console.error('No historical events — is the fixture inside the 6h..2w window?'); process.exit(1); }
  const kickoff = events.find(e => e.Action === 'kickoff')?.Ts || events[0].Ts;
  const end = events[events.length - 1].Ts;
  const startSec = Math.floor(kickoff / 1000) - 3600, endSec = Math.floor(end / 1000) + 1800;

  console.log('Fetching StablePrice odds windows…');
  for (let t = startSec; t <= endSec; t += 600) {
    const day = Math.floor(t / 86400), hour = Math.floor((t % 86400) / 3600), slot = Math.floor((t % 3600) / 600);
    const f = path.join(rawDir, `ou-${hour}-${slot}.json`);
    const res = await fetch(`${HOST}/api/odds/updates/${day}/${hour}/${slot}`, { headers: H });
    if (res.ok) fs.writeFileSync(f, await res.text());
    process.stdout.write('.');
  }
  console.log('\nBuilding replay…');
  execFileSync('node', [path.join(__dirname, 'build-replay.js'), String(fixtureId), name], { stdio: 'inherit' });
  console.log(`Done. Set REPLAY_FILE=data/replays/${name}.json to use it.`);
}

main().catch(e => { console.error(e); process.exit(1); });
