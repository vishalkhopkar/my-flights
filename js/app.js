/* Departures board — live FIDS-style flight board.
 * Data:   GET /flights.json   (no-store, polled + pushed via SSE /events)
 * Logos:  /logos/<airlineCode>.png
 * All text from JSON is inserted with textContent only (never innerHTML).
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */
  var FLIGHTS_URL = '/flights.json';
  var EVENTS_URL = '/events';
  var POLL_MS = 2000;
  var STATUS_REFRESH_MS = 30000;
  var FLIP = 60; // ms per half-flip; must match --flip in styles.css

  var DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  var MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function str(v) { return v == null ? '' : String(v).trim(); }

  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var wideMQ = window.matchMedia ? window.matchMedia('(min-width: 900px)') : { matches: true };
  function reduced() { return !!reduceMQ.matches; }

  function parseYMD(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function dateInfo(s) {
    var t = parseYMD(s);
    if (t == null) return null;
    var d = new Date(t);
    return { dow: d.getUTCDay(), day: d.getUTCDate(), mon: d.getUTCMonth(), year: d.getUTCFullYear() };
  }

  function shortDate(s) {
    var d = dateInfo(s);
    return d ? pad(d.day) + ' ' + MONTH_NAMES[d.mon] : (str(s) || '--');
  }

  function shortDay(s, fallback) {
    var d = dateInfo(s);
    if (d) return DAY_NAMES[d.dow].slice(0, 3);
    return str(fallback).slice(0, 3).toUpperCase();
  }

  function longDate(s) {
    var d = dateInfo(s);
    if (!d) return str(s).toUpperCase() || 'UNDATED';
    return DAY_NAMES[d.dow] + ' ' + d.day + ' ' + MONTH_NAMES[d.mon] + ' ' + d.year;
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function validTime(t) { return /^\d{1,2}:\d{2}$/.test(t || ''); }

  function normTime(t) {
    t = str(t);
    if (!validTime(t)) return '--:--';
    return t.length === 4 ? '0' + t : t;
  }

  /* ------------------------------------------------------------------ *
   * Split-flap tiles
   * ------------------------------------------------------------------ */
  function half(cls) {
    var box = el('span', 'half ' + cls);
    var sp = el('span');
    box.appendChild(sp);
    return { box: box, sp: sp };
  }

  function setChar(h, ch) { h.sp.textContent = ch === ' ' ? '' : ch; }

  function makeTile() {
    var root = el('span', 'flap');
    root.setAttribute('aria-hidden', 'true');
    var t = half('top'), b = half('bot'), ft = half('top leaf'), fb = half('bot leaf');
    root.appendChild(t.box);
    root.appendChild(b.box);
    root.appendChild(ft.box);
    root.appendChild(fb.box);
    return { root: root, t: t, b: b, ft: ft, fb: fb, ch: ' ', target: ' ', token: 0, timer: 0 };
  }

  function settle(tile, ch) {
    clearTimeout(tile.timer);
    tile.token++;
    tile.root.classList.remove('go');
    setChar(tile.t, ch);
    setChar(tile.b, ch);
    tile.ch = ch;
    tile.target = ch;
  }

  var DIGITS = '0123456789';
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function flipTo(tile, target, delay, cycles) {
    if (reduced()) { settle(tile, target); return; }
    clearTimeout(tile.timer);
    var token = ++tile.token;
    // normalise a possibly interrupted flip
    tile.root.classList.remove('go');
    setChar(tile.t, tile.ch);
    setChar(tile.b, tile.ch);
    tile.target = target;

    var pool = /[0-9]/.test(target) ? DIGITS : (/[A-Z]/.test(target) ? LETTERS : DIGITS);
    var seq = [];
    for (var i = 0; i < cycles; i++) seq.push(pool.charAt(Math.floor(Math.random() * pool.length)));
    seq.push(target);
    var idx = 0;

    function run() {
      if (tile.token !== token) return;
      if (idx >= seq.length) return;
      var ch = seq[idx++];
      if (ch === tile.ch) { run(); return; }
      var r = tile.root;
      setChar(tile.t, ch);
      setChar(tile.ft, tile.ch);
      setChar(tile.fb, ch);
      r.classList.remove('go');
      void r.offsetWidth; // restart CSS animation
      r.classList.add('go');
      tile.timer = setTimeout(function () {
        if (tile.token !== token) return;
        setChar(tile.b, ch);
        tile.ch = ch;
        r.classList.remove('go');
        run();
      }, FLIP * 2 + 10);
    }
    tile.timer = setTimeout(run, Math.max(0, delay));
  }

  function isStaticChar(c) { return c === ' ' || c === ':'; }

  /* container: element that holds the tiles. opts: {delay, cycles} */
  function setFlap(container, text, opts) {
    opts = opts || {};
    var delay = opts.delay || 0;
    var cycles = opts.cycles == null ? 2 : opts.cycles;
    var chars = Array.from(text);
    var items = container._items;
    var same = items && items.length === chars.length &&
      items.every(function (it, i) { return it.isStatic === isStaticChar(chars[i]); });

    if (!same) {
      container.textContent = '';
      var sr = el('span', 'sr', text);
      container.appendChild(sr);
      container._sr = sr;
      var k = 0;
      items = chars.map(function (c) {
        if (isStaticChar(c)) {
          var node = c === ' ' ? el('span', 'gap') : el('span', 'sep colon', c);
          node.setAttribute('aria-hidden', 'true');
          container.appendChild(node);
          return { isStatic: true, node: node, ch: c };
        }
        var tile = makeTile();
        container.appendChild(tile.root);
        flipTo(tile, c, delay + (k++) * 38, cycles + 1);
        return { isStatic: false, tile: tile, ch: c };
      });
      container._items = items;
    } else {
      var n = 0;
      container._sr.textContent = text;
      items.forEach(function (it, i) {
        if (it.isStatic) return;
        if (it.tile.target !== chars[i]) flipTo(it.tile, chars[i], delay + (n++) * 70, cycles);
        it.ch = chars[i];
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Data normalisation
   * ------------------------------------------------------------------ */
  function deriveCode(r) {
    var code = str(r.airlineCode).toLowerCase();
    if (!code) {
      var fn = str(r.flightNumber).toUpperCase();
      var m = /^([A-Z0-9]{2})(?:\s|\d|$)/.exec(fn) || /^([A-Z0-9]{2,3})\b/.exec(fn);
      code = m ? m[1].toLowerCase() : '';
    }
    return /^[a-z0-9]{2,3}$/.test(code) ? code : '';
  }

  function pushUnique(arr, v) {
    if (v && arr.indexOf(v) === -1) arr.push(v);
  }

  function splitNotes(n) {
    if (n == null) return [];
    return String(n).split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function groupFlights(rows, off) {
    var map = new Map();
    var out = [];
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object' || r.hidden === true) return;
      if (off.has(str(r.passenger))) return;
      var fn = str(r.flightNumber).toUpperCase();
      // one board row per flight AND PNR, so the PNR cell always holds exactly one code
      var key = fn + '|' + str(r.departureDate) + '|' + str(r.pnr);
      var g = map.get(key);
      if (!g) {
        g = {
          key: key,
          flightNumber: fn || '---',
          airline: str(r.airline),
          airlineCode: deriveCode(r),
          departureDate: str(r.departureDate),
          departureDay: str(r.departureDay),
          departureTime: str(r.departureTime),
          source: str(r.source).toUpperCase(),
          sourceAirport: str(r.sourceAirport),
          destination: str(r.destination).toUpperCase(),
          destinationAirport: str(r.destinationAirport),
          arrivalDate: str(r.arrivalDate),
          arrivalDay: str(r.arrivalDay),
          arrivalTime: str(r.arrivalTime),
          classes: [], passengers: [], pnrs: [], notes: []
        };
        map.set(key, g);
        out.push(g);
      }
      pushUnique(g.classes, str(r.class));
      pushUnique(g.passengers, str(r.passenger));
      pushUnique(g.pnrs, str(r.pnr));
      splitNotes(r.notes).forEach(function (n) { pushUnique(g.notes, n); });
    });
    return out;
  }

  function buildItems(groups) {
    return groups.map(function (g) { return { type: 'flight', key: 'f:' + g.key, g: g }; });
  }

  function statusOf(g, today) {
    var dep = parseYMD(g.departureDate);
    var now = parseYMD(today);
    var state = 'future';
    var label = 'ON SCHEDULE';
    var sub = '';
    if (dep != null && now != null) {
      var days = Math.round((dep - now) / 864e5);
      if (days < 0) { state = 'past'; label = 'DEPARTED'; }
      else if (days === 0) { state = 'today'; label = 'TODAY'; sub = 'DEPARTS TODAY'; }
      else if (days <= 30) { label = days === 1 ? 'IN 1 DAY' : 'IN ' + days + ' DAYS'; sub = 'ON SCHEDULE'; }
    }
    var warn = false;
    if (state !== 'past' && g.notes.some(function (n) { return /cancel/i.test(n); })) {
      warn = true;
      label = 'CHECK NOTES';
      sub = '';
    }
    return { state: state, label: label, sub: sub, warn: warn };
  }

  /* ------------------------------------------------------------------ *
   * Airline logo (with badge fallback)
   * ------------------------------------------------------------------ */
  var failedLogos = new Set();

  function badgeFor(code) {
    var b = el('span', 'logo badge', (code || '--').slice(0, 3).toUpperCase());
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  function makeLogo(code) {
    if (!code || failedLogos.has(code)) return badgeFor(code);
    var wrap = el('span', 'logo');
    wrap.setAttribute('aria-hidden', 'true');
    var img = new Image();
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.decoding = 'async';
    img.addEventListener('error', function () {
      failedLogos.add(code);
      if (wrap.parentNode) wrap.parentNode.replaceChild(badgeFor(code), wrap);
    });
    img.src = '/logos/' + encodeURIComponent(code) + '.png';
    wrap.appendChild(img);
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * Passenger colours + filter
   * Colour = position in the alphabetical list of all passengers, so it
   * stays stable while the filter changes. The filter stores the names that
   * are switched OFF, so a newly added passenger is shown by default.
   * ------------------------------------------------------------------ */
  var PAX_COLORS = 6; // pc-0 .. pc-5 in styles.css
  var STORE_KEY = 'flights.deselectedPassengers';
  var paxIndex = Object.create(null);
  var filterNames = [];
  var filterSig = null;

  function loadDeselected() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(v)) return new Set(v.map(String));
    } catch (e) { /* storage unavailable */ }
    return new Set();
  }

  function saveDeselected() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(deselected))); } catch (e) { /* ignore */ }
  }

  var deselected = loadDeselected();

  function paxColor(name) {
    var i = paxIndex[name];
    return i == null ? 0 : i % PAX_COLORS;
  }

  function passengerNames(rows) {
    var set = Object.create(null);
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object' || r.hidden === true) return;
      var p = str(r.passenger);
      if (p) set[p] = 1;
    });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
  }

  var filterEl = $('filter');
  var filterBtn = $('filter-btn');
  var filterVal = $('filter-value');
  var filterPanel = $('filter-panel');

  function refilter() {
    saveDeselected();
    if (lastGood) render(lastGood);
  }

  function onToggle(cb) {
    var left = filterNames.filter(function (n) { return !deselected.has(n); });
    if (!cb.checked) {
      if (left.length <= 1) { cb.checked = true; return; } // keep at least one passenger selected
      deselected.add(cb.value);
    } else {
      deselected.delete(cb.value);
    }
    refilter();
  }

  function buildFilterPanel(names) {
    filterPanel.textContent = '';
    names.forEach(function (n) {
      var label = el('label', 'opt');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = n;
      cb.addEventListener('change', function () { onToggle(cb); });
      var box = el('span', 'box pc-' + paxColor(n));
      box.setAttribute('aria-hidden', 'true');
      label.appendChild(cb);
      label.appendChild(box);
      label.appendChild(el('span', 'opt-name', n));
      filterPanel.appendChild(label);
    });
    var all = el('button', 'filter-all', 'SELECT ALL');
    all.type = 'button';
    all.addEventListener('click', function () { deselected.clear(); refilter(); });
    filterPanel.appendChild(all);
  }

  function updateFilter(names) {
    paxIndex = Object.create(null);
    names.forEach(function (n, i) { paxIndex[n] = i; });
    filterNames = names;

    // never end up hiding everyone (e.g. the data changed under a stored selection)
    if (names.length && names.every(function (n) { return deselected.has(n); })) {
      deselected.clear();
      saveDeselected();
    }

    filterEl.hidden = names.length < 2;
    var sig = names.join('\u0001');
    if (sig !== filterSig) {
      filterSig = sig;
      buildFilterPanel(names);
    }
    Array.prototype.forEach.call(filterPanel.querySelectorAll('input'), function (cb) {
      cb.checked = !deselected.has(cb.value);
    });

    var on = names.filter(function (n) { return !deselected.has(n); });
    filterVal.textContent = on.length === names.length ? 'ALL' : on.join(', ').toUpperCase();
  }

  function setFilterOpen(open) {
    filterPanel.hidden = !open;
    filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function initFilter() {
    filterBtn.addEventListener('click', function () { setFilterOpen(filterPanel.hidden); });
    document.addEventListener('click', function (e) {
      if (!filterPanel.hidden && !filterEl.contains(e.target)) setFilterOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !filterPanel.hidden) { setFilterOpen(false); filterBtn.focus(); }
    });
  }

  /* ------------------------------------------------------------------ *
   * Copy-to-clipboard button (PNR)
   * ------------------------------------------------------------------ */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICON_COPY = ['M9 9h10v12H9z', 'M5 15V3h10'];
  var ICON_CHECK = ['M5 13l4 4L19 7'];

  function setIcon(svg, paths) {
    svg.textContent = '';
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function copyButton(text) {
    var btn = el('button', 'copy');
    btn.type = 'button';
    btn.title = 'Copy ' + text;
    btn.setAttribute('aria-label', 'Copy PNR ' + text);
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    setIcon(svg, ICON_COPY);
    btn.appendChild(svg);
    var timer = 0;
    btn.addEventListener('click', function () {
      copyText(text).then(function () {
        btn.classList.add('done');
        btn.title = 'Copied!';
        setIcon(svg, ICON_CHECK);
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.classList.remove('done');
          btn.title = 'Copy ' + text;
          setIcon(svg, ICON_COPY);
        }, 1400);
      }, function () {
        btn.title = 'Copy failed';
      });
    });
    return btn;
  }

  /* ------------------------------------------------------------------ *
   * Columns
   * ------------------------------------------------------------------ */
  function flapCell(cell, cls) {
    if (!cell.flaps) {
      cell.flaps = el('span', 'flaps ' + cls);
      cell.inner.appendChild(cell.flaps);
    }
    return cell.flaps;
  }

  var COLS = [
    {
      id: 'airline', label: 'Airline', cls: 'c-airline',
      sig: function (g) { return g.airlineCode + '|' + g.airline; },
      render: function (cell, g) {
        var wrap = el('div', 'airline');
        wrap.appendChild(makeLogo(g.airlineCode));
        wrap.appendChild(el('span', 'al-name', g.airline || g.airlineCode.toUpperCase() || 'UNKNOWN'));
        cell.inner.textContent = '';
        cell.inner.appendChild(wrap);
      }
    },
    {
      id: 'flight', label: 'Flight', cls: 'c-flight', flap: true,
      sig: function (g) { return g.flightNumber; },
      render: function (cell, g, ctx) {
        setFlap(flapCell(cell, 'flightno'), g.flightNumber, { delay: ctx.delay, cycles: ctx.initial ? 3 : 2 });
      }
    },
    {
      id: 'date', label: 'Date', cls: 'c-date',
      sig: function (g) { return g.departureDate + '|' + g.departureDay; },
      render: function (cell, g) {
        cell.inner.textContent = '';
        cell.inner.appendChild(el('div', 'd-main', shortDate(g.departureDate)));
        cell.inner.appendChild(el('div', 'd-sub', shortDay(g.departureDate, g.departureDay)));
      }
    },
    {
      id: 'depart', label: 'Departs', cls: 'c-depart', flap: true,
      sig: function (g) { return normTime(g.departureTime); },
      render: function (cell, g, ctx) {
        setFlap(flapCell(cell, 'time'), normTime(g.departureTime), { delay: ctx.delay + 120, cycles: ctx.initial ? 3 : 2 });
      }
    },
    {
      id: 'from', label: 'From', cls: 'c-from',
      sig: function (g) { return g.source + '|' + g.sourceAirport; },
      render: function (cell, g) {
        cell.inner.textContent = '';
        cell.inner.appendChild(el('div', 'iata', g.source || '---'));
        if (g.sourceAirport) cell.inner.appendChild(el('div', 'apt', g.sourceAirport));
      }
    },
    {
      id: 'to', label: 'To', cls: 'c-to',
      sig: function (g) { return g.destination + '|' + g.destinationAirport; },
      render: function (cell, g) {
        cell.inner.textContent = '';
        cell.inner.appendChild(el('div', 'iata', g.destination || '---'));
        if (g.destinationAirport) cell.inner.appendChild(el('div', 'apt', g.destinationAirport));
      }
    },
    {
      id: 'arrive', label: 'Arrives', cls: 'c-arrive', flap: true,
      sig: function (g) { return g.arrivalDate + '|' + normTime(g.arrivalTime) + '|' + g.departureDate; },
      render: function (cell, g, ctx) {
        if (!cell.flaps) {
          var wrap = el('div', 'arr');
          cell.arrDate = el('div', 'd-sub');
          var line = el('div', 'arr-line');
          cell.flaps = el('span', 'flaps time');
          cell.plus = el('span', 'plus');
          line.appendChild(cell.flaps);
          line.appendChild(cell.plus);
          wrap.appendChild(cell.arrDate);
          wrap.appendChild(line);
          cell.inner.appendChild(wrap);
        }
        cell.arrDate.textContent = g.arrivalDate ? shortDate(g.arrivalDate) + ' · ' + shortDay(g.arrivalDate, g.arrivalDay) : '';
        var a = parseYMD(g.arrivalDate), d = parseYMD(g.departureDate);
        var diff = (a != null && d != null) ? Math.round((a - d) / 864e5) : 0;
        if (diff > 0) {
          cell.plus.hidden = false;
          cell.plus.textContent = '+' + diff;
          cell.plus.title = diff === 1 ? 'Arrives the next day' : 'Arrives ' + diff + ' days later';
        } else {
          cell.plus.hidden = true;
        }
        setFlap(cell.flaps, normTime(g.arrivalTime), { delay: ctx.delay + 200, cycles: ctx.initial ? 3 : 2 });
      }
    },
    {
      id: 'class', label: 'Class', cls: 'c-class',
      sig: function (g) { return g.classes.join('\u0001'); },
      render: function (cell, g) {
        cell.inner.textContent = '';
        var list = g.classes.length ? g.classes : ['—'];
        list.forEach(function (c) { cell.inner.appendChild(el('div', 'cls', c)); });
      }
    },
    {
      id: 'pax', label: 'Passenger(s)', cls: 'c-pax',
      sig: function (g) { return g.passengers.map(function (p) { return p + ':' + paxColor(p); }).join('\u0001'); },
      render: function (cell, g) {
        var box = el('div', 'pax');
        (g.passengers.length ? g.passengers : ['—']).forEach(function (p) {
          box.appendChild(el('span', 'chip pc-' + paxColor(p), p));
        });
        cell.inner.textContent = '';
        cell.inner.appendChild(box);
      }
    },
    {
      id: 'pnr', label: 'PNR/Ref', cls: 'c-pnr',
      sig: function (g) { return g.pnrs.join('\u0001'); },
      render: function (cell, g) {
        cell.inner.textContent = '';
        if (!g.pnrs.length) { cell.inner.appendChild(el('span', 'pnr', '—')); return; }
        g.pnrs.forEach(function (p) {
          var line = el('div', 'pnr-line');
          line.appendChild(el('span', 'pnr', p));
          line.appendChild(copyButton(p));
          cell.inner.appendChild(line);
        });
      }
    },
    {
      id: 'notes', label: 'Notes', cls: 'c-notes',
      sig: function (g) { return g.notes.join(''); },
      render: function (cell, g) {
        cell.inner.textContent = '';
        if (!g.notes.length) {
          cell.inner.appendChild(el('span', 'no-notes', '—'));
          return;
        }
        cell.inner.appendChild(buildTicker(g.notes));
        needFit = true;
      }
    }
  ];

  /* ------------------------------------------------------------------ *
   * Row records (keyed, diffed)
   * ------------------------------------------------------------------ */
  var table = $('board');
  var recs = new Map();
  var rendered = false;
  var lastGood = null;

  function restartFlip(inner) {
    inner.classList.remove('flip');
    void inner.offsetWidth;
    inner.classList.add('flip');
  }

  function createFlight(item) {
    var tb = el('tbody', 'flight');
    var main = el('tr', 'main');
    var cells = {};
    COLS.forEach(function (col) {
      var td = el('td', 'c ' + col.cls);
      td.setAttribute('data-label', col.label);
      var inner = el('div', 'cell-in');
      inner.addEventListener('animationend', function (e) {
        if (e.target === inner) inner.classList.remove('flip');
      });
      td.appendChild(inner);
      main.appendChild(td);
      cells[col.id] = { td: td, inner: inner, sig: null };
    });

    tb.appendChild(main);
    return { key: item.key, el: tb, cells: cells };
  }

  function buildTicker(notes) {
    var ticker = el('div', 'ticker');
    var track = el('div', 'track');
    function group(dup) {
      var g = el('span', 'grp' + (dup ? ' dup' : ''));
      if (dup) g.setAttribute('aria-hidden', 'true');
      notes.forEach(function (n, i) {
        if (i) {
          var s = el('span', 'sep', '◆');
          s.setAttribute('aria-hidden', 'true');
          g.appendChild(s);
        }
        g.appendChild(el('span', 'note', n));
      });
      return g;
    }
    track.appendChild(group(false));
    track.appendChild(group(true));
    ticker.appendChild(track);
    return ticker;
  }

  var needFit = false;

  function fitTicker(ticker) {
    ticker.classList.remove('scroll');
    ticker.style.removeProperty('--dur');
    if (!wideMQ.matches) return;
    var track = ticker.firstChild;
    var first = track.firstChild;
    if (first.scrollWidth > ticker.clientWidth + 2) {
      ticker.classList.add('scroll');
      var w = first.getBoundingClientRect().width || first.scrollWidth;
      ticker.style.setProperty('--dur', Math.max(12, Math.round(w / 45)) + 's');
    }
  }

  function fitTickers() {
    needFit = false;
    Array.prototype.forEach.call(document.querySelectorAll('.ticker'), fitTicker);
  }

  function updateFlight(rec, item, ctx, today) {
    var g = item.g;
    var st = statusOf(g, today);

    var cl = rec.el.classList;
    cl.toggle('past', st.state === 'past');
    cl.toggle('today', st.state === 'today');
    cl.toggle('future', st.state === 'future');
    cl.toggle('warn', st.warn);

    COLS.forEach(function (col) {
      var cell = rec.cells[col.id];
      var sig = col.sig(g, st);
      if (sig === cell.sig) return;
      var hadSig = cell.sig !== null;
      cell.sig = sig;
      col.render(cell, g, ctx, st);
      if (hadSig && !col.flap && !reduced()) restartFlip(cell.inner);
    });
  }

  /* ------------------------------------------------------------------ *
   * Render / reconcile
   * ------------------------------------------------------------------ */
  var emptyEl = $('empty');
  var loadingEl = $('loading');
  var countEl = $('count');

  function removeRec(rec) {
    recs.delete(rec.key);
    rec.el.classList.add('leaving');
    setTimeout(function () { if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el); }, reduced() ? 0 : 450);
  }

  function render(json) {
    var today = todayStr();
    updateFilter(passengerNames(json.data));
    var groups = groupFlights(json.data, deselected);
    var items = buildItems(groups);
    var initial = !rendered;
    rendered = true;

    var keep = new Set(items.map(function (i) { return i.key; }));
    Array.from(recs.values()).forEach(function (rec) { if (!keep.has(rec.key)) removeRec(rec); });

    var cursor = table.tHead ? table.tHead.nextElementSibling : table.firstElementChild;
    function skipLeaving() {
      while (cursor && cursor.classList.contains('leaving')) cursor = cursor.nextElementSibling;
    }

    items.forEach(function (item, idx) {
      var rec = recs.get(item.key);
      var isNew = !rec;
      if (isNew) {
        rec = createFlight(item);
        recs.set(item.key, rec);
      }
      var delay = initial ? 200 + Math.min(idx, 22) * 50 : 0;
      if (isNew && !reduced()) {
        rec.el.classList.add('enter');
        rec.el.style.setProperty('--d', (initial ? Math.min(idx, 22) * 50 : 0) + 'ms');
        (function (r) {
          setTimeout(function () { r.el.classList.remove('enter'); r.el.style.removeProperty('--d'); }, 1700 + (initial ? 1200 : 0));
        })(rec);
      }

      updateFlight(rec, item, { first: isNew, initial: initial, delay: delay }, today);

      skipLeaving();
      if (rec.el === cursor) cursor = cursor.nextElementSibling;
      else table.insertBefore(rec.el, cursor);
    });

    // empty state / table visibility
    var flightCount = groups.length;
    loadingEl.hidden = true;
    if (flightCount === 0) {
      emptyEl.hidden = false;
      setFlap($('empty-l1'), 'NO FLIGHTS', { delay: 100, cycles: 3 });
      setFlap($('empty-l2'), 'SCHEDULED', { delay: 500, cycles: 3 });
      setTimeout(function () { if (!recs.size) table.hidden = true; }, reduced() ? 0 : 480);
    } else {
      emptyEl.hidden = true;
      table.hidden = false;
    }

    var paxTotal = {};
    groups.forEach(function (g) { g.passengers.forEach(function (p) { paxTotal[p] = 1; }); });
    var np = Object.keys(paxTotal).length;
    countEl.textContent = flightCount + (flightCount === 1 ? ' FLIGHT' : ' FLIGHTS') +
      (np ? ' · ' + np + (np === 1 ? ' PASSENGER' : ' PASSENGERS') : '');

    // last scan
    var scanEl = $('last-scan');
    if (json.runDate) {
      var d = new Date(json.runDate);
      if (!isNaN(d.getTime())) {
        scanEl.textContent = DAY_NAMES[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MONTH_NAMES[d.getMonth()] +
          ' ' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        scanEl.dateTime = d.toISOString();
      } else {
        scanEl.textContent = str(json.runDate);
      }
    } else {
      scanEl.textContent = '—';
    }

    if (needFit) requestAnimationFrame(fitTickers);
  }

  /* ------------------------------------------------------------------ *
   * Connection indicator, fetching, SSE, polling
   * ------------------------------------------------------------------ */
  var connOk = null;

  function setConn(ok) {
    if (connOk === ok) return;
    connOk = ok;
    $('conn').hidden = ok;
  }

  var lastText = null;
  var inflight = false;
  var again = false;

  function load() {
    if (inflight) { again = true; return Promise.resolve(); }
    inflight = true;
    return fetch(FLIGHTS_URL + '?_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        setConn(true);
        if (text === lastText) return;
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (!json || !Array.isArray(json.data)) return; // mid-write / invalid: keep last good
        lastText = text;
        lastGood = json;
        render(json);
      })
      .catch(function () { setConn(false); })
      .then(function () {
        inflight = false;
        if (again) { again = false; load(); }
      });
  }

  function connectEvents() {
    if (!('EventSource' in window)) return;
    var es;
    try { es = new EventSource(EVENTS_URL); } catch (e) { return; }
    function onPush() { load(); }
    es.addEventListener('message', onPush);
    es.addEventListener('change', onPush);
    es.addEventListener('open', load);
  }

  /* ------------------------------------------------------------------ *
   * Clock
   * ------------------------------------------------------------------ */
  function tickClock() {
    var d = new Date();
    $('clock-time').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    $('clock-time').dateTime = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    $('clock-date').textContent = DAY_NAMES[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    initFilter();

    load();
    connectEvents();
    setInterval(load, POLL_MS);

    // refresh date-derived status text (new day, countdowns)
    setInterval(function () { if (lastGood) render(lastGood); }, STATUS_REFRESH_MS);

    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
    window.addEventListener('online', load);

    var resizeTimer = 0;
    function refit() { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitTickers, 150); }
    window.addEventListener('resize', refit);
    [wideMQ, reduceMQ].forEach(function (mq) {
      if (mq.addEventListener) mq.addEventListener('change', refit);
      else if (mq.addListener) mq.addListener(refit);
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTickers);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
