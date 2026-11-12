#!/usr/bin/env node
'use strict';
/*
 * Trips + flight departure board server. Zero dependencies.
 *   node server.js            -> http://localhost:3000   (PORT env to change, ROOT env to serve another folder)
 *
 * Serves an allowlist only: / (trips, index.html) , /departures (departures.html) ,
 * /css/* , /js/* , /logos/* , /flights.json , /hotels.json , /transport.json ,
 * /trips/<name>.json (per-person trip files + index.json; name must match ^[a-z0-9-]+$, no subfolders)
 * GET /events is a Server-Sent Events stream that emits `change` when flights.json, hotels.json,
 * transport.json or any file in trips/ changes (or when a new airline logo has been cached).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ensureLogos, codesFromFlights } = require('./scripts/fetch-logos');

const ROOT = path.resolve(process.env.ROOT || __dirname);
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const FLIGHTS = path.join(ROOT, 'flights.json');
const WATCHED = ['flights.json', 'hotels.json', 'transport.json']; // files in ROOT
const TRIPS_KEY = 'trips/'; // change-detection key for the trips/ folder as a whole
const TRIPS_DIR = path.join(ROOT, 'trips');
const TRIPS_FILE_RE = /^[a-z0-9-]+\.json$/;
const LOGOS = path.join(ROOT, 'logos');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + msg);
}

// ---------------------------------------------------------------- routing / static

/** Map a request URL path to an absolute file path, or null when not allowed. */
function resolveAllowed(rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath); } catch (_) { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  if (p === '/') p = '/index.html';
  else if (p === '/departures' || p === '/departures/') p = '/departures.html';
  else if (p === '/departures.html') return null; // only reachable as /departures
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  const allowed =
    p === '/index.html' ||
    p === '/departures.html' ||
    p === '/flights.json' ||
    p === '/hotels.json' ||
    p === '/transport.json' ||
    (segs.length === 2 && segs[0] === 'trips' && TRIPS_FILE_RE.test(segs[1])) ||
    (segs.length >= 2 && (segs[0] === 'css' || segs[0] === 'js' || segs[0] === 'logos'));
  if (!allowed) return null;
  const abs = path.resolve(ROOT, ...segs);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function cacheControl(urlPath) {
  return urlPath.startsWith('/logos/') ? 'public, max-age=60' : 'no-store';
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const abs = resolveAllowed(urlPath);
  if (!abs) return send(res, 404, 'Not found');
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(abs).toLowerCase();
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl(urlPath),
      'X-Content-Type-Options': 'nosniff',
      'Last-Modified': st.mtime.toUTCString(),
      ETag: etag,
    };
    if (headers['Cache-Control'] !== 'no-store' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(abs);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------- SSE

const clients = new Set();

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (req.socket) { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true); }
  res.write('retry: 2000\n: connected\n\n');
  clients.add(res);
  log('client connected (' + clients.size + ' open)');
  let gone = false;
  const cleanup = () => {
    if (gone) return;
    gone = true;
    clients.delete(res);
    log('client disconnected (' + clients.size + ' open)');
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function broadcast(eventName, data) {
  const msg = 'event: ' + eventName + '\ndata: ' + data + '\n\n';
  for (const c of clients) {
    try { c.write(msg); } catch (_) { clients.delete(c); }
  }
}

const heartbeat = setInterval(() => {
  for (const c of clients) {
    try { c.write(': ping\n\n'); } catch (_) { clients.delete(c); }
  }
}, 20000);

// ---------------------------------------------------------------- logos

let logoRunning = false;
let logoAgain = false;

async function refreshLogos(reason) {
  if (logoRunning) { logoAgain = true; return; }
  logoRunning = true;
  try {
    do {
      logoAgain = false;
      const codes = codesFromFlights(FLIGHTS);
      if (!codes.length) continue;
      let downloaded = 0;
      await ensureLogos(codes, {
        root: ROOT,
        logosDir: LOGOS,
        log,
        onDownload: (r) => { downloaded++; log('logo downloaded: ' + r.code + ' from ' + r.source); },
      });
      if (downloaded) {
        log('broadcasting change (' + downloaded + ' new logo' + (downloaded > 1 ? 's' : '') + ', ' + reason + ')');
        broadcast('change', new Date().toISOString());
      }
    } while (logoAgain);
  } catch (e) {
    log('logo fetch error: ' + (e && e.message || e));
  } finally {
    logoRunning = false;
  }
}

// ---------------------------------------------------------------- change detection

const lastSig = Object.create(null);
const debounceTimers = Object.create(null);

/** Signature of a watched root file (size + mtime), or null when it is missing. */
function fileSig(name, cb) {
  fs.stat(path.join(ROOT, name), (err, st) => cb(err || !st.isFile() ? null : st.size + ':' + Math.floor(st.mtimeMs)));
}

/** Signature of the trips/ folder: every .json entry's name + size + mtime ('' when missing/empty). */
function tripsSig(cb) {
  let sig = '';
  try {
    const names = fs.readdirSync(TRIPS_DIR).filter((n) => TRIPS_FILE_RE.test(n)).sort();
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(TRIPS_DIR, n));
        if (st.isFile()) sig += n + ':' + st.size + ':' + Math.floor(st.mtimeMs) + '|';
      } catch (_) { /* removed mid-scan */ }
    }
  } catch (_) { /* folder missing */ }
  cb(sig);
}

function sigOf(key, cb) {
  if (key === TRIPS_KEY) tripsSig(cb);
  else fileSig(key, cb);
}

function schedule(key) {
  clearTimeout(debounceTimers[key]);
  debounceTimers[key] = setTimeout(() => {
    sigOf(key, (sig) => {
      // Root file missing (mid-rename) or nothing changed: stay quiet. For trips/ an empty
      // signature is a real state (folder removed or emptied), so it is still broadcast.
      if ((sig === null && key !== TRIPS_KEY) || sig === lastSig[key]) return;
      lastSig[key] = sig;
      log(key + ' changed -> sending change to ' + clients.size + ' client(s)');
      broadcast('change', new Date().toISOString());
      if (key === 'flights.json') refreshLogos('flights.json changed');
    });
  }, 150);
}

// fs.watch on trips/ itself: created when the folder exists, re-created when it appears later or
// was replaced by a new folder (different inode), closed when it disappears.
let tripsWatcher = null;
let tripsWatchedIno = null;

function closeTripsWatcher() {
  if (!tripsWatcher) return;
  try { tripsWatcher.close(); } catch (_) {}
  tripsWatcher = null;
  tripsWatchedIno = null;
}

function ensureTripsWatcher() {
  let st = null;
  try { st = fs.statSync(TRIPS_DIR); } catch (_) {}
  if (!st || !st.isDirectory()) { closeTripsWatcher(); return; }
  if (tripsWatcher && tripsWatchedIno === st.ino) return;
  closeTripsWatcher();
  try {
    const w = fs.watch(TRIPS_DIR, { persistent: false }, () => schedule(TRIPS_KEY));
    w.on('error', () => { if (tripsWatcher === w) closeTripsWatcher(); schedule(TRIPS_KEY); });
    tripsWatcher = w;
    tripsWatchedIno = st.ino;
  } catch (_) { /* polling still covers it */ }
}

function startWatching() {
  WATCHED.forEach((name) => sigOf(name, (sig) => { lastSig[name] = sig; }));
  sigOf(TRIPS_KEY, (sig) => { lastSig[TRIPS_KEY] = sig; });
  ensureTripsWatcher();
  try {
    // Watch the directory (not the files): editors / atomic renames replace the file's inode.
    const w = fs.watch(ROOT, { persistent: false }, (_evt, name) => {
      const n = name ? String(name).toLowerCase() : null;
      WATCHED.forEach((f) => { if (!n || n === f) schedule(f); });
      if (!n || n === 'trips') {
        // trips/ created, replaced, removed or its contents touched: (re-)establish its own watcher.
        ensureTripsWatcher();
        schedule(TRIPS_KEY);
      }
    });
    w.on('error', (e) => log('fs.watch error (' + e.message + '); relying on polling'));
  } catch (e) {
    log('fs.watch unavailable (' + e.message + '); relying on polling');
  }
  // Polling fallback: never miss a change (and pick up a trips/ folder created later).
  setInterval(() => {
    WATCHED.forEach((name) => sigOf(name, (sig) => {
      if (sig !== null && sig !== lastSig[name]) schedule(name);
    }));
    ensureTripsWatcher();
    sigOf(TRIPS_KEY, (sig) => { if (sig !== lastSig[TRIPS_KEY]) schedule(TRIPS_KEY); });
  }, 1000);
}

// ---------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { return send(res, 400, 'Bad request'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  if (pathname === '/events') return handleEvents(req, res);
  serveStatic(req, res, pathname);
});
server.keepAliveTimeout = 5000;

server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Stop the other process or choose another port, e.g. PORT=3001 node server.js');
  } else {
    console.error('Server error: ' + err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log('Trips on http://localhost:' + PORT + '/ , departures on http://localhost:' + PORT + '/departures  (serving ' + ROOT + ')');
  startWatching();
  try { fs.mkdirSync(LOGOS, { recursive: true }); } catch (_) {}
  refreshLogos('startup');
  setInterval(() => refreshLogos('periodic retry'), 10 * 60 * 1000).unref();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  log('shutting down');
  clearInterval(heartbeat);
  for (const c of clients) { try { c.end(); } catch (_) {} }
  server.close(() => process.exit(0));
  if (server.closeAllConnections) server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
