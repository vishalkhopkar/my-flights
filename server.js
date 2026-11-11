#!/usr/bin/env node
'use strict';
/*
 * Flight departure board server. Zero dependencies.
 *   node server.js            -> http://localhost:3000   (PORT env to change, ROOT env to serve another folder)
 *
 * Serves an allowlist only: / , /index.html , /css/* , /js/* , /logos/* , /flights.json
 * GET /events is a Server-Sent Events stream that emits `change` when flights.json changes
 * (or when a new airline logo has been cached).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ensureLogos, codesFromFlights } = require('./scripts/fetch-logos');

const ROOT = path.resolve(process.env.ROOT || __dirname);
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const FLIGHTS = path.join(ROOT, 'flights.json');
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
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  const allowed =
    p === '/index.html' ||
    p === '/flights.json' ||
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

let lastSig = null;
let debounceTimer = null;

function sigOf(cb) {
  fs.stat(FLIGHTS, (err, st) => cb(err || !st.isFile() ? null : st.size + ':' + Math.floor(st.mtimeMs)));
}

function schedule() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    sigOf((sig) => {
      if (sig === null || sig === lastSig) return; // missing (mid-rename) or unchanged
      lastSig = sig;
      log('flights.json changed -> sending change to ' + clients.size + ' client(s)');
      broadcast('change', new Date().toISOString());
      refreshLogos('flights.json changed');
    });
  }, 150);
}

function startWatching() {
  sigOf((sig) => { lastSig = sig; });
  try {
    // Watch the directory (not the file): editors / atomic renames replace the file's inode.
    const w = fs.watch(ROOT, { persistent: false }, (_evt, name) => {
      if (!name || String(name).toLowerCase() === 'flights.json') schedule();
    });
    w.on('error', (e) => log('fs.watch error (' + e.message + '); relying on polling'));
  } catch (e) {
    log('fs.watch unavailable (' + e.message + '); relying on polling');
  }
  // Polling fallback: never miss a change.
  setInterval(() => sigOf((sig) => { if (sig !== null && sig !== lastSig) schedule(); }), 1000);
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
  log('Flight board listening on http://localhost:' + PORT + '  (serving ' + ROOT + ')');
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
