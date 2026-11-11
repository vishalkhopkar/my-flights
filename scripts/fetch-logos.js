#!/usr/bin/env node
'use strict';
/*
 * Airline logo cache.
 *
 *   node scripts/fetch-logos.js              # all codes found in ../flights.json (hidden ones too)
 *   node scripts/fetch-logos.js aa jl        # explicit codes
 *   node scripts/fetch-logos.js --force      # re-download even if cached
 *
 * Also importable: const { ensureLogos, codesFromFlights } = require('./scripts/fetch-logos');
 * Logos are saved as logos/<code>.png (lowercase IATA code). Zero dependencies.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 10000;
const MIN_BYTES = 300;
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETRY_MS = 10 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (compatible; my-flights-board/1.0; +local logo cache)';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const CODE_RE = /^[a-z0-9]{2,3}$/;

// Ordered, key-less sources (verified working). {C} = upper-case code, {c} = lower-case.
const SOURCES = [
  { name: 'kiwi-128', url: 'https://images.kiwi.com/airlines/128x128/{C}.png', noRedirect: true } /* unknown codes 303 -> generic placeholder */,
  { name: 'gstatic-70', url: 'https://www.gstatic.com/flights/airline_logos/70px/{C}.png' },
  { name: 'avs-200', url: 'https://pics.avs.io/200/200/{C}.png' },
  { name: 'daisycon-128', url: 'https://daisycon.io/images/airline/?iata={C}&width=128&height=128' },
];

// sha256 of generic "unknown airline" placeholder images served by some sources (kiwi airlines.png, gstatic plane icon)
const PLACEHOLDER_SHA256 = new Set([
  '53545c0ed6a76040fb5afe0af343ff29feb7545fceae2caaa0680c711c95657b',
  'b9ffde2bf8c2a7cb9eb6ee601ceece2a477b76157b8256290819c508832952fa',
]);

const failedAt = new Map();   // code -> timestamp of last total failure (process lifetime)
const inFlight = new Map();   // code -> Promise (dedupe concurrent requests)

function normCode(c) {
  const s = String(c == null ? '' : c).trim().toLowerCase();
  return CODE_RE.test(s) ? s : null;
}

function recordCode(rec) {
  if (!rec || typeof rec !== 'object') return null;
  let code = normCode(rec.airlineCode);
  if (!code && typeof rec.flightNumber === 'string') {
    // "AA 61" -> aa ; "9W 123" -> 9w ; "AI2383" (no space) -> first two chars
    const fn = rec.flightNumber.trim();
    const prefix = fn.split(/\s+/)[0];
    code = normCode(prefix.length === 2 || prefix.length === 3 && /\s/.test(fn) ? prefix : fn.slice(0, 2));
  }
  return code;
}

/** Unique airline codes of ALL records (hidden included). Never throws; returns [] on bad input. */
function codesFromFlights(source) {
  let json = source;
  try {
    if (typeof source === 'string' || source === undefined) {
      const file = source || path.join(DEFAULT_ROOT, 'flights.json');
      json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    }
  } catch (_) {
    return [];
  }
  const list = Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : [];
  const out = new Set();
  for (const rec of list) {
    const c = recordCode(rec);
    if (c) out.add(c);
  }
  return [...out];
}

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > MIN_BYTES && buf.length <= MAX_BYTES &&
    buf.subarray(0, 4).equals(PNG_MAGIC);
}

async function fetchPng(url, noRedirect) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/png,image/*;q=0.8' },
    redirect: noRedirect ? 'manual' : 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!isPng(buf)) throw new Error('not a PNG (' + (res.headers.get('content-type') || 'unknown type') + ', ' + buf.length + ' bytes)');
  if (PLACEHOLDER_SHA256.has(require('crypto').createHash('sha256').update(buf).digest('hex'))) throw new Error('generic placeholder');
  // sanity: IHDR width/height
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w < 16 || h < 16) throw new Error('image too small ' + w + 'x' + h);
  return buf;
}

function fileOk(file) {
  try { return fs.statSync(file).size > 0; } catch (_) { return false; }
}

async function fetchOne(code, logosDir, force) {
  const file = path.join(logosDir, code + '.png');
  if (!force && fileOk(file)) return { code, status: 'cached' };
  const errors = [];
  for (const src of SOURCES) {
    const url = src.url.replace(/\{C\}/g, code.toUpperCase()).replace(/\{c\}/g, code);
    try {
      const buf = await fetchPng(url, src.noRedirect);
      const tmp = file + '.tmp';
      await fs.promises.mkdir(logosDir, { recursive: true });
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
      failedAt.delete(code);
      return { code, status: 'downloaded', source: src.name, bytes: buf.length };
    } catch (e) {
      errors.push(src.name + ': ' + (e && e.name === 'TimeoutError' ? 'timeout' : e && e.message || e));
      fs.promises.unlink(file + '.tmp').catch(() => {});
    }
  }
  failedAt.set(code, Date.now());
  return { code, status: 'failed', errors };
}

/**
 * Make sure logos/<code>.png exist for the given codes.
 * opts: { root, logosDir, force, retryMs, log(msg), onDownload(result) }
 * Resolves to an array of { code, status: 'cached'|'downloaded'|'failed'|'skipped', source?, errors? }.
 */
async function ensureLogos(codes, opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const logosDir = opts.logosDir || path.join(root, 'logos');
  const retryMs = opts.retryMs == null ? DEFAULT_RETRY_MS : opts.retryMs;
  const unique = [...new Set((codes || []).map(normCode).filter(Boolean))];
  const results = [];
  for (const code of unique) {
    const file = path.join(logosDir, code + '.png');
    if (!opts.force && fileOk(file)) { results.push({ code, status: 'cached' }); continue; }
    const last = failedAt.get(code);
    if (!opts.force && last && Date.now() - last < retryMs) { results.push({ code, status: 'skipped' }); continue; }
    let p = inFlight.get(code);
    if (!p) {
      p = fetchOne(code, logosDir, !!opts.force).finally(() => inFlight.delete(code));
      inFlight.set(code, p);
    }
    const r = await p;
    if (r.status === 'downloaded' && opts.onDownload) { try { opts.onDownload(r); } catch (_) {} }
    if (r.status === 'failed' && opts.log) opts.log('WARNING: no logo for "' + code + '" (' + r.errors.join('; ') + ')');
    results.push(r);
  }
  return results;
}

module.exports = { ensureLogos, codesFromFlights, SOURCES };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const explicit = args.filter((a) => !a.startsWith('--'));
    let codes;
    if (explicit.length) {
      codes = explicit.map(normCode).filter(Boolean);
      const bad = explicit.filter((a) => !normCode(a));
      if (bad.length) console.warn('Ignoring invalid codes: ' + bad.join(', '));
    } else {
      const file = path.join(DEFAULT_ROOT, 'flights.json');
      try {
        JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      } catch (e) {
        console.error('Cannot read ' + file + ': ' + e.message);
        process.exit(1);
      }
      codes = codesFromFlights(file);
    }
    if (!codes.length) { console.log('No airline codes found.'); return; }
    let failed = 0;
    for (const code of [...new Set(codes)]) {
      const [r] = await ensureLogos([code], { force, retryMs: 0 });
      if (r.status === 'cached') console.log(code + ': cached');
      else if (r.status === 'downloaded') console.log(code + ': downloaded from ' + r.source + ' (' + r.bytes + ' bytes)');
      else { failed++; console.log(code + ': FAILED (' + r.errors.join('; ') + ')'); }
    }
    if (failed) console.log(failed + ' logo(s) could not be fetched; the page will show a text badge for them.');
  })().catch((e) => { console.error(e); process.exit(1); });
}
