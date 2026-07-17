// WebSocket client with reconnect + event-time clock sync.
const listeners = new Set();
let ws = null;
let profile = null;
let watching = 'replay';
let backoff = 800;

// event-time interpolation: displayNow() advances at speedHint between snapshots
let lastEventNow = 0;
let lastRecvWall = 0;
let speedHint = 1;

export function clientId() {
  let id = localStorage.getItem('ci_id');
  if (!id) {
    id = 'u-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('ci_id', id);
  }
  return id;
}

export function displayNow() {
  if (!lastEventNow) return 0;
  return lastEventNow + (Date.now() - lastRecvWall) * speedHint;
}

export function getSpeedHint() { return speedHint; }

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    backoff = 800;
    const p = profile || JSON.parse(localStorage.getItem('ci_profile') || 'null');
    ws.send(JSON.stringify({ type: 'hello', clientId: clientId(), ...(p || {}) }));
    ws.send(JSON.stringify({ type: 'watch', sessionId: watching }));
    emit({ type: '_open' });
  };
  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'snapshot') {
      lastEventNow = msg.match.now;
      lastRecvWall = Date.now();
      speedHint = msg.speedHint || 1;
    }
    emit(msg);
  };
  ws.onclose = () => {
    emit({ type: '_closed' });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.7, 10_000);
  };
}

export function setProfile(name, emoji) {
  profile = { name, emoji };
  localStorage.setItem('ci_profile', JSON.stringify(profile));
  sendMsg({ type: 'profile', name, emoji });
}

export function watch(sessionId) {
  watching = sessionId;
  sendMsg({ type: 'watch', sessionId });
}

export function sendMsg(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(msg) { listeners.forEach(fn => fn(msg)); }
