// =====================================================================
//  VOXELCRAFT - Servidor publico de conexion (para Render)
//
//  Este servidor NO tiene la logica del juego. Solo:
//    1) Hace que los jugadores de una misma sala se encuentren (señalizacion).
//    2) Hace de relevo: si dos jugadores no pueden conectarse directo
//       (WebRTC bloqueado por la red), sus mensajes pasan por aca.
//    3) Cada 5 minutos descarga su configuracion y su "plugin" desde el
//       WORKER de Cloudflare (WORKER_URL/srv/config y /srv/plugin.js).
//       Asi, actualizando solo el worker, el servidor se actualiza solo.
//
//  No usa dependencias: solo Node.js (>= 18).
//  Variables de entorno (en Render -> Environment):
//    WORKER_URL  -> la direccion de tu worker, ej: https://voxelcraft.tuusuario.workers.dev
//    SERVER_KEY  -> una clave secreta (la misma que en el worker) para guardar el mundo 24/7
//    PORT        -> la pone Render sola
// =====================================================================
'use strict';
const http = require('http');
const crypto = require('crypto');
const vm = require('vm');

const PORT = Number(process.env.PORT) || 10000;
const WORKER_URL = String(process.env.WORKER_URL || '').trim().replace(/\/+$/, '');
const SERVER_KEY = String(process.env.SERVER_KEY || '').trim();
const STATE = {}; // memoria que sobrevive cuando el plugin se actualiza
const STARTED = Date.now();
const DEFAULTS = { v: 'sin-worker', maxPeers: 12, maxMsg: 600000, rate: 600, maxRooms: 2000, motd: '', game: 'VOXELCRAFT' };

let CFG = Object.assign({}, DEFAULTS);
let PLUGIN = {};
let pluginCode = '';
let cfgAt = 0, cfgErr = WORKER_URL ? 'todavía no se cargó' : 'falta la variable WORKER_URL';
let lastReload = 0;

// ---------------------------------------------------------------------
//  Datos que vienen del worker
// ---------------------------------------------------------------------
async function loadFromWorker() {
  if (!WORKER_URL) return;
  try {
    const r = await fetch(WORKER_URL + '/srv/config', { headers: { 'user-agent': 'voxelcraft-server' } });
    if (!r.ok) throw new Error('config HTTP ' + r.status);
    const j = await r.json();
    CFG = Object.assign({}, DEFAULTS, j && typeof j === 'object' ? j : {});
    const p = await fetch(WORKER_URL + '/srv/plugin.js', { headers: { 'user-agent': 'voxelcraft-server' } });
    if (p.ok) {
      const code = await p.text();
      if (code !== pluginCode) {
        const mod = { exports: {} };
        vm.runInNewContext(code, { module: mod, exports: mod.exports, console: console, Math: Math, JSON: JSON, Date: Date, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval }, { timeout: 1000, filename: 'plugin.js' });
        if (PLUGIN && typeof PLUGIN.onUnload === 'function') { try { await PLUGIN.onUnload(API); } catch (e) { } }
        PLUGIN = mod.exports || {}; pluginCode = code;
        hook('onLoad');
        console.log('[worker] plugin cargado, versión', CFG.v);
      }
    }
    cfgAt = Date.now(); cfgErr = '';
  } catch (e) {
    cfgErr = String((e && e.message) || e);
    console.log('[worker] no se pudo cargar:', cfgErr);
  }
}
setInterval(loadFromWorker, 5 * 60 * 1000);
loadFromWorker();

function hook(name) {
  const args = Array.prototype.slice.call(arguments, 1);
  const f = PLUGIN && PLUGIN[name];
  if (typeof f !== 'function') return undefined;
  try { return f.apply(null, [API].concat(args)); } catch (e) { console.log('[plugin] error en', name, e && e.message); return undefined; }
}

// ---------------------------------------------------------------------
//  Salas
// ---------------------------------------------------------------------
const rooms = new Map(); // sala -> Map(id -> conexion)
const API = {
  get config() { return CFG; },
  send: function (room, id, obj) { const r = rooms.get(room); const c = r && r.get(id); if (c) c.sendJson(obj); },
  broadcast: function (room, obj, exceptId) { const r = rooms.get(room); if (r) r.forEach(function (c, id) { if (id !== exceptId) c.sendJson(obj); }); },
  roomSize: function (room) { const r = rooms.get(room); return r ? r.size : 0; },
  state: STATE,
  sendFrom: function (room, toId, fromId, d) { const r = rooms.get(room); const c = r && r.get(toId); if (c) c.sendText(JSON.stringify({ k: 'to', f: fromId, d: d })); },
  user: function (room, id) { const r = rooms.get(room); const c = r && r.get(id); return c ? c.user : null; },
  players: function (room) { const r = rooms.get(room), out = []; if (r) r.forEach(function (c, id) { out.push({ id: id, user: c.user || null }); }); return out; },
  kick: function (room, id, msg) { const r = rooms.get(room); const c = r && r.get(id); if (c) { if (msg) c.sendJson({ k: 'denied', m: msg }); c.close(4001); } },
  worker: function (path, body) {
    if (!WORKER_URL) return Promise.reject(new Error('falta WORKER_URL'));
    return fetch(WORKER_URL + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-server-key': SERVER_KEY, 'user-agent': 'voxelcraft-server' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); });
  },
  stats: function () { return stats(); },
  log: function () { console.log.apply(console, ['[plugin]'].concat(Array.prototype.slice.call(arguments))); }
};
function stats() {
  let players = 0; rooms.forEach(function (r) { players += r.size; });
  return { ok: true, game: CFG.game, version: CFG.v, rooms: rooms.size, players: players, uptime: Math.round((Date.now() - STARTED) / 1000), worker: WORKER_URL || null, workerLoaded: cfgAt ? new Date(cfgAt).toISOString() : null, workerError: cfgErr || null };
}
function joinRoom(conn) {
  let r = rooms.get(conn.room);
  if (!r) {
    if (rooms.size >= CFG.maxRooms) { conn.sendJson({ k: 'full', m: 'El servidor está lleno, probá más tarde.' }); conn.close(1013); return; }
    r = new Map(); rooms.set(conn.room, r);
  }
  const old = r.get(conn.id); if (old) old.close(4000);
  if (r.size >= CFG.maxPeers) { conn.sendJson({ k: 'full', m: 'La sala está llena (' + CFG.maxPeers + ' jugadores).' }); conn.close(1013); return; }
  const others = Array.from(r.keys());
  r.set(conn.id, conn);
  const virt = hook('virtual', conn.room); if (Array.isArray(virt)) virt.forEach(function (v) { if (typeof v === 'string') others.push(v); });
  conn.sendJson({ k: 'hello', v: CFG.v, peers: others, user: conn.user || null });
  r.forEach(function (c, id) { if (id !== conn.id) c.sendJson({ k: 'join', f: conn.id }); });
  hook('onJoin', conn.room, conn.id);
}
function leaveRoom(conn) {
  const r = rooms.get(conn.room); if (!r || r.get(conn.id) !== conn) return;
  r.delete(conn.id);
  r.forEach(function (c) { c.sendJson({ k: 'leave', f: conn.id }); });
  if (!r.size) rooms.delete(conn.room);
  hook('onLeave', conn.room, conn.id);
}
function onClientMessage(conn, txt) {
  // limite de mensajes por conexion (por cada 10 segundos)
  const now = Date.now();
  if (now - conn.rateT > 10000) { conn.rateT = now; conn.rateN = 0; }
  if (++conn.rateN > CFG.rate) return;
  let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (hook('onMessage', conn.room, conn.id, m) === false) return;
  const r = rooms.get(conn.room); if (!r) return;
  if (m.k === 'pub' && typeof m.d === 'string') { // para todos los de la sala
    const out = JSON.stringify({ k: 'pub', f: conn.id, d: m.d });
    r.forEach(function (c, id) { if (id !== conn.id) c.sendText(out); });
  } else if (m.k === 'to' && typeof m.t === 'string' && typeof m.d === 'string') { // para uno solo (señales o relevo del juego)
    if (m.t.charAt(0) === '@') { hook('onVirtual', conn.room, conn.id, m.t, m.d); return; } // jugador virtual del servidor (ej: el guardian del mundo 24/7)
    const c = r.get(m.t); if (c) c.sendText(JSON.stringify({ k: 'to', f: conn.id, d: m.d }));
  } else if (m.k === 'ping') conn.sendJson({ k: 'pong', t: m.t });
}

// ---------------------------------------------------------------------
//  WebSocket minimo (RFC 6455) sin dependencias
// ---------------------------------------------------------------------
function Conn(sock, room, id) {
  this.sock = sock; this.room = room; this.id = id; this.buf = Buffer.alloc(0); this.frag = null; this.alive = true; this.closed = false;
  this.rateT = Date.now(); this.rateN = 0; this.lastPong = Date.now();
  const self = this;
  sock.setNoDelay(true);
  sock.on('data', function (d) { self.onData(d); });
  sock.on('close', function () { self.cleanup(); });
  sock.on('error', function () { self.cleanup(); });
}
Conn.prototype.frame = function (op, payload) {
  const len = payload.length; let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 4294967296), 2); head.writeUInt32BE(len >>> 0, 6); }
  head[0] = 0x80 | op;
  if (!this.closed) try { this.sock.write(Buffer.concat([head, payload])); } catch (e) { }
};
Conn.prototype.deliver = function (txt) { if (this.pending) { if (this.pending.length < 200) this.pending.push(txt); return; } onClientMessage(this, txt); };
Conn.prototype.sendText = function (s) { this.frame(1, Buffer.from(s, 'utf8')); };
Conn.prototype.sendJson = function (o) { this.sendText(JSON.stringify(o)); };
Conn.prototype.close = function (code) {
  if (this.closed) return; const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000, 0); this.frame(8, b);
  this.closed = true; const s = this.sock; setTimeout(function () { try { s.destroy(); } catch (e) { } }, 200); this.cleanup();
};
Conn.prototype.cleanup = function () { if (this.gone) return; this.gone = true; this.closed = true; leaveRoom(this); };
Conn.prototype.onData = function (d) {
  this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
  while (this.buf.length >= 2) {
    const b0 = this.buf[0], b1 = this.buf[1], fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(2) * 4294967296 + this.buf.readUInt32BE(6); off = 10; }
    if (len > CFG.maxMsg + 1024) { this.close(1009); return; }
    if (!masked) { this.close(1002); return; }
    if (this.buf.length < off + 4 + len) return;
    const mask = this.buf.subarray(off, off + 4), data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    this.buf = this.buf.subarray(off + 4 + len);
    if (op === 8) { this.close(1000); return; }
    if (op === 9) { this.frame(10, data); continue; }
    if (op === 10) { this.lastPong = Date.now(); continue; }
    if (op === 1 || op === 2) { if (fin) { if (op === 1) this.deliver(data.toString('utf8')); } else this.frag = [data]; continue; }
    if (op === 0 && this.frag) {
      this.frag.push(data); let tot = 0; this.frag.forEach(function (x) { tot += x.length; });
      if (tot > CFG.maxMsg) { this.close(1009); return; }
      if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.deliver(all.toString('utf8')); }
    }
  }
};
// latido: si alguien no responde en 70 s se lo da por desconectado
setInterval(function () {
  const now = Date.now();
  rooms.forEach(function (r) { r.forEach(function (c) { if (now - c.lastPong > 70000) c.close(1001); else c.frame(9, Buffer.alloc(0)); }); });
}, 25000);
setInterval(function () { hook('onTick'); }, 10000);

// ---------------------------------------------------------------------
//  HTTP: estado (para UptimeRobot), estadisticas y la conexion WebSocket
// ---------------------------------------------------------------------
const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (u.pathname === '/health' || u.pathname === '/ping') { res.writeHead(200, Object.assign({ 'content-type': 'text/plain' }, cors)); res.end('ok'); return; }
  if (u.pathname === '/stats') { res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors)); res.end(JSON.stringify(stats())); return; }
  if (u.pathname === '/reload') { // fuerza a bajar de nuevo los datos del worker (como mucho cada 30 s)
    if (Date.now() - lastReload > 30000) { lastReload = Date.now(); loadFromWorker(); }
    res.writeHead(200, Object.assign({ 'content-type': 'text/plain' }, cors)); res.end('recargando datos del worker'); return;
  }
  const s = stats();
  res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, cors));
  res.end('<!doctype html><meta charset="utf-8"><title>' + esc(CFG.game) + ' - servidor</title><body style="font:16px sans-serif;background:#1b1d22;color:#eee;padding:24px">' +
    '<h2>🟢 Servidor de ' + esc(CFG.game) + ' funcionando</h2>' +
    '<p>Jugadores conectados: <b>' + s.players + '</b> en <b>' + s.rooms + '</b> sala(s)</p>' +
    '<p>Versión de los datos del worker: <b>' + esc(String(s.version)) + '</b></p>' +
    '<p>Worker: ' + esc(WORKER_URL || '(falta configurar WORKER_URL)') + (cfgErr ? ' — <span style="color:#f88">' + esc(cfgErr) + '</span>' : ' — ✅ cargado') + '</p>' +
    '<p>Encendido hace ' + Math.round(s.uptime / 60) + ' min</p></body>');
});
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
server.on('upgrade', function (req, sock) {
  const u = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  const room = u.searchParams.get('room') || '', id = u.searchParams.get('id') || '';
  if (u.pathname !== '/ws' || !key || !/^[A-Za-z0-9_\/.:-]{4,100}$/.test(room) || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
    try { sock.write('HTTP/1.1 400 Bad Request\r\n\r\n'); sock.destroy(); } catch (e) { } return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const conn = new Conn(sock, room, id), q = {}; u.searchParams.forEach(function (v, k) { q[k] = v; });
  let auth; try { auth = PLUGIN && typeof PLUGIN.auth === 'function' ? PLUGIN.auth(API, room, id, q) : null; } catch (e) { auth = { ok: false, msg: 'Error del servidor' }; }
  if (!auth) { joinRoom(conn); return; }
  conn.pending = [];
  Promise.resolve(auth).then(function (a) {
    if (conn.closed) return;
    if (!a || !a.ok) { conn.sendJson({ k: 'denied', m: (a && a.msg) || 'No tenés permiso para entrar.' }); conn.close(4003); return; }
    conn.user = a.user || null;
    const r = rooms.get(room); if (r && conn.user) r.forEach(function (c) { if (c.user === conn.user) { c.sendJson({ k: 'denied', m: 'Entraste con tu cuenta desde otro lugar.' }); c.close(4002); } });
    joinRoom(conn); const pend = conn.pending; conn.pending = null; pend.forEach(function (t) { onClientMessage(conn, t); });
  }, function () { conn.sendJson({ k: 'denied', m: 'No se pudo verificar tu cuenta, probá de nuevo.' }); conn.close(4003); });
});
server.listen(PORT, function () { console.log('Servidor de VOXELCRAFT escuchando en el puerto ' + PORT + (WORKER_URL ? ' · worker: ' + WORKER_URL : ' · (falta WORKER_URL)')); });
// al apagarse (Render reinicia o redespliega) se le da tiempo al plugin para guardar el mundo
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  try { if (PLUGIN && typeof PLUGIN.onUnload === 'function') await Promise.race([PLUGIN.onUnload(API), new Promise(function (r) { setTimeout(r, 8000); })]); } catch (e) { }
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
