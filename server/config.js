'use strict';
const path = require('path');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

module.exports = {
  port: Number(env('PORT', 3000)),

  // TxLINE
  txline: {
    host: env('TXLINE_BASE_URL', 'https://txline-dev.txodds.com'),
    apiToken: env('TXLINE_API_TOKEN', ''),
    // AUTO: attach to a live devnet fixture when one is on, otherwise replay.
    // Values: auto | live | replay
    dataMode: env('DATA_MODE', 'auto'),
    fixtureId: env('TXLINE_FIXTURE_ID', '') ? Number(env('TXLINE_FIXTURE_ID')) : null,
    fixturePollMs: Number(env('TXLINE_FIXTURE_POLL_MS', 5 * 60 * 1000)),
  },

  replay: {
    file: env('REPLAY_FILE', path.join(__dirname, '..', 'data', 'replays', 'france-spain.json')),
    // Wall-clock speed multiplier for match time. Idle gaps are compressed.
    speed: Number(env('REPLAY_SPEED', 2)),
    maxIdleGapMs: Number(env('REPLAY_MAX_GAP_MS', 4000)),
    // Start this many event-time ms before kickoff.
    leadInMs: Number(env('REPLAY_LEAD_IN_MS', 90 * 1000)),
    loop: env('REPLAY_LOOP', '1') !== '0',
  },

  demoBots: Number(env('DEMO_BOTS', 8)),

  solana: {
    rpc: env('RPC_URL', 'https://api.devnet.solana.com'),
    cluster: env('SOLANA_CLUSTER', 'devnet'),
    // JSON array secret key, or path to a keypair file
    secret: env('ANCHOR_SECRET', ''),
    keypairPath: env('ANCHOR_KEYPAIR', ''),
    batchMs: Number(env('ANCHOR_BATCH_MS', 30_000)),
  },

  persistFile: env('PERSIST_FILE', path.join(__dirname, '..', 'data', 'state.json')),
  adminKey: env('ADMIN_KEY', 'letmein'),
};
