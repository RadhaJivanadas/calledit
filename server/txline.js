'use strict';
/**
 * TxLINE client: guest JWT lifecycle, REST snapshots, SSE streams.
 *
 * Endpoints used (devnet host by default):
 *   POST /auth/guest/start                      -> guest JWT
 *   GET  /api/fixtures/snapshot                 -> schedule
 *   GET  /api/scores/historical/{fixtureId}     -> full match event sequence (capture tooling)
 *   GET  /api/odds/updates/{day}/{hour}/{slot}  -> historical StablePrice odds (capture tooling)
 *   GET  /api/scores/stream                     -> live score events (SSE)
 *   GET  /api/odds/stream                       -> live StablePrice odds (SSE)
 */
const { EventEmitter } = require('events');

class TxLineClient extends EventEmitter {
  constructor({ host, apiToken }) {
    super();
    this.host = host.replace(/\/$/, '');
    this.apiToken = apiToken;
    this.jwt = null;
    this.jwtFetchedAt = 0;
    this.streams = [];
    this.stopped = false;
  }

  async guestJwt(force = false) {
    if (!force && this.jwt && Date.now() - this.jwtFetchedAt < 20 * 60 * 1000) return this.jwt;
    const res = await fetch(`${this.host}/auth/guest/start`, { method: 'POST' });
    if (!res.ok) throw new Error(`guest/start ${res.status}`);
    const { token } = await res.json();
    this.jwt = token;
    this.jwtFetchedAt = Date.now();
    return token;
  }

  async headers() {
    const jwt = await this.guestJwt();
    return { Authorization: `Bearer ${jwt}`, 'X-Api-Token': this.apiToken };
  }

  async getJson(pathname, retried = false) {
    const res = await fetch(`${this.host}${pathname}`, { headers: await this.headers() });
    if (res.status === 401 && !retried) {
      await this.guestJwt(true);
      return this.getJson(pathname, true);
    }
    if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
    return res.json();
  }

  fixturesSnapshot() { return this.getJson('/api/fixtures/snapshot'); }

  /**
   * Connect an SSE stream and emit ('data', parsedJson) per message.
   * Reconnects with backoff until stop() is called.
   */
  openStream(pathname, label) {
    const state = { alive: true, label };
    this.streams.push(state);
    const run = async () => {
      let backoff = 1000;
      while (state.alive && !this.stopped) {
        try {
          const res = await fetch(`${this.host}${pathname}`, {
            headers: {
              ...(await this.headers()),
              Accept: 'text/event-stream',
              'Cache-Control': 'no-cache',
            },
          });
          if (res.status === 401) { await this.guestJwt(true); continue; }
          if (!res.ok) throw new Error(`${label} stream ${res.status}`);
          this.emit('stream_open', label);
          backoff = 1000;
          let buf = '';
          const decoder = new TextDecoder();
          for await (const chunk of res.body) {
            if (!state.alive || this.stopped) break;
            buf += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
              const dataLines = block.split(/\r?\n/).filter(l => l.startsWith('data:'));
              if (!dataLines.length) continue;
              const payload = dataLines.map(l => l.slice(5).trim()).join('\n');
              try { this.emit('data', label, JSON.parse(payload)); }
              catch { /* non-JSON heartbeat */ }
            }
          }
        } catch (err) {
          this.emit('stream_error', label, err.message);
        }
        if (state.alive && !this.stopped) {
          await new Promise(r => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
    run();
    return () => { state.alive = false; };
  }

  stop() {
    this.stopped = true;
    this.streams.forEach(s => { s.alive = false; });
  }
}

module.exports = { TxLineClient };
