/* Itinerary — per-person trips resolved against the source record files.
 *
 * Data:  GET /trips/index.json          { generatedAt, sourceRunDates, people:[{name,file,tripCount}] }
 *        GET /trips/<file>              { generatedAt, person, sourceRunDates, trips:[...], unassigned:{flights,hotels,transport} }
 *        GET /flights.json, /hotels.json, /transport.json   { runDate, nextId, data:[{ id, ... }] }
 * Trips reference records by { source, id }; every id is resolved here. Unknown ids are shown as
 * "missing record" flags and never crash the page.
 * Live:  SSE /events (change|message) + 2 s polling; re-render only when any response text changed.
 * All text from JSON is inserted with textContent. No innerHTML with data.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */
  var INDEX_URL = '/trips/index.json';
  var TRIPS_DIR = '/trips/';
  var SOURCE_URLS = { flights: '/flights.json', hotels: '/hotels.json', transport: '/transport.json' };
  var EVENTS_URL = '/events';
  var POLL_MS = 2000;
  var DAY_CHECK_MS = 60000;
  var KEY_PERSON = 'itin.person';
  var KEY_OPEN = 'itin.open.';

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var MODE_LABEL = {
    flight: 'Flight', train: 'Train', bus: 'Bus', ferry: 'Ferry', taxi: 'Taxi', transfer: 'Transfer',
    shuttle: 'Shuttle', rentalCar: 'Rental car', car: 'Car', pass: 'Pass', metro: 'Metro', tram: 'Tram'
  };
  var MODE_ICON = {
    flight: 'plane', train: 'train', metro: 'train', tram: 'train', bus: 'bus', shuttle: 'bus', transfer: 'bus',
    ferry: 'ferry', taxi: 'taxi', rentalCar: 'car', car: 'car', pass: 'ticket'
  };
  var ISSUE_LABEL = {
    missingLodging: 'No accommodation', overlappingStays: 'Overlapping stays', noReturnBooked: 'No return booked',
    startsAwayFromHome: 'Starts away from home', stayFarFromRoute: 'Stay far from route', airportChange: 'Airport change',
    tightConnection: 'Tight connection', rentalMismatch: 'Rental mismatch', rentalOverlap: 'Rental overlap',
    checkoutTiming: 'Timing clash', uncertainStatus: 'Status uncertain', unmappedName: 'Unknown name',
    noTravelBooked: 'No travel booked', missingRecord: 'Missing record'
  };
  var RED_ISSUES = { missingLodging: 1, overlappingStays: 1, noReturnBooked: 1, rentalOverlap: 1, rentalMismatch: 1, noTravelBooked: 1, missingRecord: 1 };

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

  function frag() { return document.createDocumentFragment(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function uniq(list) {
    var out = [];
    list.forEach(function (v) { if (v && out.indexOf(v) === -1) out.push(v); });
    return out;
  }

  function parseYMD(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function ymd(t) {
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function addDays(s, n) { var t = parseYMD(s); return t == null ? null : ymd(t + n * 864e5); }

  function daysBetween(a, b) {
    var x = parseYMD(a), y = parseYMD(b);
    return x == null || y == null ? null : Math.round((y - x) / 864e5);
  }

  function dow(s) { var t = parseYMD(s); return t == null ? '' : DOW[new Date(t).getUTCDay()]; }
  function dowLong(s) { var t = parseYMD(s); return t == null ? '' : DOW_LONG[new Date(t).getUTCDay()]; }

  /* 14 Nov 2026 */
  function fmtDate(s) {
    var t = parseYMD(s);
    if (t == null) return str(s) || '—';
    var d = new Date(t);
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* 14 Nov */
  function fmtShort(s) {
    var t = parseYMD(s);
    if (t == null) return str(s) || '—';
    var d = new Date(t);
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()];
  }

  /* Sat 14 Nov */
  function fmtDay(s) { return str(s) ? dow(s) + ' ' + fmtShort(s) : '—'; }

  /* "11 Nov 19:34" in local time, from an ISO stamp */
  function fmtStamp(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function normTime(t) {
    t = str(t);
    var m = /^(\d{1,2}):(\d{2})/.exec(t);
    return m ? pad(+m[1]) + ':' + m[2] : '';
  }

  function layoverText(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(str(hhmm));
    if (!m) return str(hhmm);
    return (+m[1]) + 'h' + (m[2] !== '00' ? ' ' + (+m[2]) + 'm' : '');
  }

  function splitNotes(n) {
    if (n == null) return [];
    return String(n).split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function refKey(ref) { return ref && ref.source ? ref.source + ':' + ref.id : ''; }

  /* ------------------------------------------------------------------ *
   * Storage (per-viewer conveniences only; every access guarded)
   * ------------------------------------------------------------------ */
  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* unavailable */ } }

  /* ------------------------------------------------------------------ *
   * Icons (inline SVG, stroke based)
   * ------------------------------------------------------------------ */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    plane: ['M20.5 15.5v-1.8l-7.5-4.7V4.4a1.3 1.3 0 0 0-2.6 0V9L3 13.7v1.8l7.4-2.3v4.5l-1.9 1.4v1.4l3.2-.9 3.2.9v-1.4l-1.9-1.4v-4.5z'],
    train: ['M8 3.5h8a3.5 3.5 0 0 1 3.5 3.5v8a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3V7A3.5 3.5 0 0 1 8 3.5z', 'M4.5 11h15', 'M8.5 14.5h.01M15.5 14.5h.01', 'M8 18l-1.5 2.5M16 18l1.5 2.5'],
    bus: ['M5 4.5h14a2 2 0 0 1 2 2v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-10a2 2 0 0 1 2-2z', 'M3 11h18', 'M7 14.5h.01M17 14.5h.01', 'M6.5 18v2M17.5 18v2'],
    ferry: ['M3.5 14.5 12 11.5l8.5 3-1.5 5h-14z', 'M6 12.5V8h12v4.5', 'M12 8V4.5M9.5 4.5h5'],
    car: ['M5 16.5H3.5v-4l2-5h13l2 5v4H19', 'M3.5 12.5h17', 'M8 16.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 16.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z', 'M8 16.5h8'],
    taxi: ['M5 16.5H3.5v-4l2-5h13l2 5v4H19', 'M3.5 12.5h17', 'M8 16.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 16.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z', 'M8 16.5h8', 'M9.5 7.5V5h5v2.5'],
    ticket: ['M4 8.5V6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2.5a2 2 0 0 0 0 4V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2.5a2 2 0 0 0 0-4z', 'M9.5 5v11'],
    bed: ['M3 6.5v13', 'M3 10.5h14.5a3.5 3.5 0 0 1 3.5 3.5v5.5', 'M3 16.5h18', 'M9 10.5a2 2 0 1 0-4 0 2 2 0 0 0 4 0z'],
    home: ['M3.5 11.5 12 4l8.5 7.5', 'M5.5 10v10h13V10', 'M10 20v-5.5h4V20'],
    alert: ['M12 3.5 21 19.5H3z', 'M12 10v4', 'M12 16.8h.01'],
    chevron: ['M9 6l6 6-6 6'],
    copy: ['M9 9h10.5v11H9z', 'M5 15V4.5h10'],
    check: ['M5 12.5l4.5 4.5L19.5 7'],
    clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5v5l3 2'],
    moon: ['M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z'],
    pin: ['M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z', 'M12 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
    user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20.5a7.5 7.5 0 0 1 15 0'],
    arrow: ['M4 12h15', 'M13.5 6.5 19 12l-5.5 5.5'],
    key: ['M14.5 14.5a5 5 0 1 0-4.8-3.6', 'M9.7 10.9 3.5 17v3h3v-2h2v-2h2l1.3-1.3'],
    shuffle: ['M4 7h3.5l9 10H20', 'M17 4.5 20 7l-3 2.5', 'M4 17h3.5l2-2.2', 'M13 9.3 16.5 7H20', 'M17 14.5 20 17l-3 2.5'],
    check_circle: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M8.5 12.5l2.5 2.5 4.5-5']
  };

  function icon(name, cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    setPaths(svg, ICONS[name] || ICONS.arrow);
    return svg;
  }

  function setPaths(svg, paths) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
  }

  /* ------------------------------------------------------------------ *
   * Logos, badges, copy buttons
   * ------------------------------------------------------------------ */
  var failedLogos = {};

  function textBadge(text) {
    var b = el('span', 'logo logo-text', (str(text) || '—').slice(0, 3).toUpperCase());
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  function iconBadge(name) {
    var b = el('span', 'logo logo-icon');
    b.setAttribute('aria-hidden', 'true');
    b.appendChild(icon(name));
    return b;
  }

  function airlineLogo(code, fallback) {
    code = str(code).toLowerCase();
    if (!/^[a-z0-9]{2,3}$/.test(code) || failedLogos[code]) return textBadge(code || fallback);
    var wrap = el('span', 'logo');
    wrap.setAttribute('aria-hidden', 'true');
    var img = new Image();
    img.alt = '';
    img.width = 28;
    img.height = 28;
    img.decoding = 'async';
    img.addEventListener('error', function () {
      failedLogos[code] = true;
      if (wrap.parentNode) wrap.parentNode.replaceChild(textBadge(code), wrap);
    });
    img.src = '/logos/' + encodeURIComponent(code) + '.png';
    wrap.appendChild(img);
    return wrap;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
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
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  /* booking reference + copy button */
  function refChip(code, label) {
    code = str(code);
    var box = el('span', 'ref');
    if (!code) { box.appendChild(el('span', 'ref-code muted', '—')); return box; }
    if (label) box.appendChild(el('span', 'ref-label', label));
    box.appendChild(el('span', 'ref-code', code));
    var btn = el('button', 'copy');
    btn.type = 'button';
    btn.title = 'Copy ' + code;
    btn.setAttribute('aria-label', 'Copy ' + code);
    var svg = icon('copy');
    btn.appendChild(svg);
    var timer = 0;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(code).then(function () {
        btn.classList.add('done');
        setPaths(svg, ICONS.check);
        clearTimeout(timer);
        timer = setTimeout(function () { btn.classList.remove('done'); setPaths(svg, ICONS.copy); }, 1400);
      }, function () { btn.title = 'Copy failed'; });
    });
    box.appendChild(btn);
    return box;
  }

  function notesBlock(notes, cls) {
    var parts = splitNotes(notes);
    if (!parts.length) return null;
    var text = parts.join('  ·  ');
    var box = el('div', 'notes' + (cls ? ' ' + cls : ''));
    if (text.length <= 140 && parts.length === 1) {
      box.appendChild(el('p', 'notes-text', text));
      return box;
    }
    var d = el('details', 'notes-more');
    d.appendChild(el('summary', null, 'Notes'));
    var ul = el('ul');
    parts.forEach(function (p) { ul.appendChild(el('li', null, p)); });
    d.appendChild(ul);
    box.appendChild(d);
    return box;
  }

  function missingRow(ref, cls) {
    var row = el('div', 'missing ' + (cls || ''));
    row.appendChild(icon('alert'));
    row.appendChild(el('span', null, 'Missing record (' + str(ref.source) + ' #' + str(ref.id) + ')'));
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Record database and reference resolution
   * ------------------------------------------------------------------ */
  function buildDb(sources) {
    var db = {};
    Object.keys(SOURCE_URLS).forEach(function (k) {
      var m = new Map();
      var json = sources[k];
      if (json && Array.isArray(json.data)) {
        json.data.forEach(function (r, i) {
          if (!r || typeof r !== 'object') return;
          var id = r.id != null ? Number(r.id) : i + 1;
          if (!m.has(id)) m.set(id, r);
        });
      }
      db[k] = m;
    });
    return db;
  }

  /* ------------------------------------------------------------------ *
   * Views: normalise a flight or transport record into one leg shape
   * ------------------------------------------------------------------ */
  function legView(source, rec) {
    if (source === 'flights') {
      return {
        mode: 'flight', carrier: str(rec.airline), code: str(rec.airlineCode) || str(rec.flightNumber).slice(0, 2),
        number: str(rec.flightNumber),
        depDate: str(rec.departureDate), depTime: normTime(rec.departureTime), depCode: str(rec.source), depName: str(rec.sourceAirport),
        arrDate: str(rec.arrivalDate), arrTime: normTime(rec.arrivalTime), arrCode: str(rec.destination), arrName: str(rec.destinationAirport),
        detail: str(rec['class']), ref: str(rec.pnr), notes: rec.notes, overnight: false, who: str(rec.passenger)
      };
    }
    var t = str(rec.transportType) || 'transfer';
    return {
      mode: t, carrier: str(rec.provider) || (MODE_LABEL[t] || 'Transport'), code: '',
      number: str(rec.serviceNumber),
      depDate: str(rec.departureDate || rec.startDate), depTime: normTime(rec.departureTime), depCode: '', depName: str(rec.departureLocation),
      arrDate: str(rec.arrivalDate || rec.endDate), arrTime: normTime(rec.arrivalTime), arrCode: '', arrName: str(rec.arrivalLocation),
      detail: str(rec.vehicle), ref: str(rec.confirmationNumber), notes: rec.notes, overnight: str(rec.term) === 'overnight',
      who: arr(rec.passengers).join(', ')
    };
  }

  /* ------------------------------------------------------------------ *
   * Components
   * ------------------------------------------------------------------ */

  /* ONE segment row for every flight and ground leg, wherever it appears */
  function segRow(source, rec, opts) {
    opts = opts || {};
    var v = legView(source, rec);
    var row = el('article', 'seg seg-' + (v.mode === 'flight' ? 'flight' : 'ground'));
    row.setAttribute('aria-label', (MODE_LABEL[v.mode] || 'Leg') + ' ' + (v.number || v.carrier));
    if (opts.past) row.classList.add('past');

    // carrier
    row.appendChild(v.mode === 'flight' ? airlineLogo(v.code, v.number) : iconBadge(MODE_ICON[v.mode] || 'arrow'));
    var car = el('div', 'seg-carrier');
    car.appendChild(el('span', 'seg-name', v.carrier || (MODE_LABEL[v.mode] || 'Leg')));
    var sub = el('span', 'seg-no');
    if (v.number) sub.appendChild(el('span', 'mono', v.number));
    sub.appendChild(el('span', 'seg-mode', (v.number ? ' · ' : '') + (MODE_LABEL[v.mode] || v.mode)));
    car.appendChild(sub);
    row.appendChild(car);

    // leg: dep -> arr
    var leg = el('div', 'seg-leg');
    leg.appendChild(endpoint('dep', v.depTime, v.depCode, v.depName, v.depDate, 0));
    var mid = el('div', 'seg-arrow');
    mid.appendChild(el('span', 'seg-line'));
    mid.appendChild(icon(v.mode === 'flight' ? 'plane' : 'arrow', 'seg-arrow-ic'));
    mid.appendChild(el('span', 'seg-line'));
    leg.appendChild(mid);
    var plus = daysBetween(v.depDate, v.arrDate);
    leg.appendChild(endpoint('arr', v.arrTime, v.arrCode, v.arrName, v.arrDate, plus));
    row.appendChild(leg);

    // meta
    var meta = el('div', 'seg-meta');
    if (v.detail) meta.appendChild(el('span', 'seg-detail', v.detail));
    var tags = el('span', 'seg-tags');
    if (v.overnight || (plus != null && plus > 0)) tags.appendChild(el('span', 'tag tag-neutral', 'Overnight'));
    if (opts.who && v.who) tags.appendChild(el('span', 'tag tag-neutral', v.who));
    if (tags.childNodes.length) meta.appendChild(tags);
    row.appendChild(meta);

    // booking ref
    var refc = el('div', 'seg-ref');
    refc.appendChild(refChip(v.ref));
    row.appendChild(refc);

    var n = notesBlock(v.notes, 'seg-notes');
    if (n) row.appendChild(n);
    return row;
  }

  function endpoint(kind, time, code, name, date, plus) {
    var e = el('div', 'ep ep-' + kind);
    var t = el('span', 'ep-time', time || '—');
    if (plus > 0) {
      var sup = el('sup', 'ep-plus', '+' + plus);
      sup.setAttribute('title', 'Arrives ' + fmtDay(date));
      t.appendChild(sup);
    }
    e.appendChild(t);
    if (code) {
      e.appendChild(el('span', 'ep-code', code));
      if (name) e.appendChild(el('span', 'ep-name', name));
    } else {
      e.appendChild(el('span', 'ep-place', name || '—'));
    }
    return e;
  }

  function connRow(conn, warn) {
    var row = el('div', 'conn' + (warn ? ' warn' : ''));
    row.appendChild(icon(warn === 'airport' ? 'shuffle' : 'clock'));
    var body = el('div', 'conn-body');
    var head = el('span', 'conn-head');
    var lay = str(conn.layover);
    head.appendChild(document.createTextNode((lay ? layoverText(lay) + ' connection' : 'Connection') + (str(conn.city) ? ' in ' + str(conn.city) : '')));
    if (conn.overnight) head.appendChild(el('span', 'tag tag-neutral', 'Overnight'));
    if (warn === 'airport') head.appendChild(el('span', 'tag tag-amber', 'Airport change'));
    else if (warn) head.appendChild(el('span', 'tag tag-amber', 'Tight'));
    body.appendChild(head);
    if (str(conn.notes)) body.appendChild(el('span', 'conn-notes', str(conn.notes)));
    row.appendChild(body);
    return row;
  }

  function stayCard(rec, opts) {
    opts = opts || {};
    var card = el('article', 'stay');
    card.setAttribute('aria-label', 'Stay at ' + (str(rec.propertyName) || 'property'));
    card.appendChild(iconBadge('bed'));

    var main = el('div', 'stay-main');
    var name = str(rec.propertyName) || 'Stay';
    var url = str(rec.googleMapsUrl);
    var title;
    if (/^https:\/\//.test(url)) {
      title = el('a', 'stay-name', name);
      title.href = url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    } else {
      title = el('span', 'stay-name', name);
    }
    main.appendChild(title);
    main.appendChild(el('span', 'stay-place', [str(rec.city), str(rec.country)].filter(Boolean).join(', ')));
    card.appendChild(main);

    var nights = rec.nights != null ? +rec.nights : daysBetween(rec.checkInDate, rec.checkOutDate);
    var times = el('div', 'stay-times');
    times.appendChild(stayTime('Check-in', rec.checkInTime, rec.checkInDate));
    var mid = el('div', 'stay-nights');
    mid.appendChild(el('span', 'seg-line'));
    mid.appendChild(el('span', 'stay-nights-text', nights != null ? plural(nights, 'night') : ''));
    mid.appendChild(el('span', 'seg-line'));
    times.appendChild(mid);
    times.appendChild(stayTime('Check-out', rec.checkOutTime, rec.checkOutDate));
    card.appendChild(times);

    var meta = el('div', 'stay-meta');
    if (str(rec.roomType)) meta.appendChild(el('span', 'stay-room', rec.roomType));
    var via = [];
    if (str(rec.bookedVia)) via.push('via ' + str(rec.bookedVia));
    if (arr(rec.guests).length) via.push(plural(arr(rec.guests).length, 'guest'));
    else if (rec.noOfGuests != null) via.push(plural(+rec.noOfGuests, 'guest'));
    if (via.length) meta.appendChild(el('span', 'stay-via', via.join(' · ')));
    card.appendChild(meta);

    var refc = el('div', 'stay-ref');
    refc.appendChild(refChip(rec.confirmationNumber));
    card.appendChild(refc);

    if (str(rec.address)) {
      var addr = el('div', 'stay-addr');
      addr.appendChild(icon('pin'));
      addr.appendChild(el('span', null, rec.address));
      card.appendChild(addr);
    }
    var n = notesBlock(rec.notes, 'stay-notes');
    if (n) card.appendChild(n);
    return card;
  }

  function stayTime(label, time, date) {
    var c = el('div', 'stay-time');
    c.appendChild(el('span', 'ep-time', normTime(time) || '—'));
    c.appendChild(el('span', 'ep-code', label));
    if (str(date)) c.appendChild(el('span', 'ep-name', fmtDay(date)));
    return c;
  }

  /* one-line status for a night (stay continuing, gap, layover, in transit, home) */
  function nightLine(night, resolved) {
    var type = str(night.type) || 'none';
    var rec = resolved && resolved.rec;
    var row = el('div', 'night night-' + type);
    var label, iconName;
    if (type === 'stay') {
      iconName = 'bed';
      if (rec) {
        var n = daysBetween(rec.checkInDate, night.date);
        var total = rec.nights != null ? +rec.nights : daysBetween(rec.checkInDate, rec.checkOutDate);
        label = (n != null && total ? 'Night ' + (n + 1) + ' of ' + total + ' · ' : 'Stay · ') + (str(rec.propertyName) || 'stay');
      } else {
        label = 'Stay';
      }
    } else if (type === 'none') { iconName = 'alert'; label = 'No accommodation booked'; }
    else if (type === 'layover') { iconName = 'clock'; label = 'Overnight layover'; }
    else if (type === 'inTransit') { iconName = 'moon'; label = 'In transit overnight'; }
    else if (type === 'home') { iconName = 'home'; label = 'At home'; }
    else { iconName = 'moon'; label = type; }

    row.appendChild(icon(iconName));
    var body = el('div', 'night-body');
    var head = el('span', 'night-head');
    head.appendChild(el('span', 'night-label', label));
    if (str(night.place)) head.appendChild(el('span', 'night-place', str(night.place)));
    body.appendChild(head);
    if (resolved && !resolved.rec) body.appendChild(missingRow(resolved, 'inline'));
    if (str(night.note)) body.appendChild(el('span', 'night-note', str(night.note)));
    row.appendChild(body);
    return row;
  }

  /* rental pickup / return event in the timeline */
  function ltEvent(rec, kind) {
    var row = el('div', 'evt');
    row.appendChild(icon(MODE_ICON[str(rec.transportType)] || 'car'));
    var body = el('div', 'evt-body');
    var head = el('span', 'evt-head');
    head.appendChild(el('span', 'evt-label', kind === 'pickup' ? 'Pick up' : 'Return'));
    head.appendChild(el('span', 'evt-what', (str(rec.provider) || MODE_LABEL[str(rec.transportType)] || 'Rental') + (str(rec.vehicle) ? ' · ' + str(rec.vehicle) : '')));
    body.appendChild(head);
    var where = kind === 'pickup' ? str(rec.departureLocation) : str(rec.arrivalLocation);
    if (where) body.appendChild(el('span', 'evt-where', where));
    row.appendChild(body);
    var refc = el('div', 'evt-ref');
    refc.appendChild(refChip(rec.confirmationNumber));
    row.appendChild(refc);
    return row;
  }

  /* long-term transport row used outside the timeline (unassigned section) */
  function ltCard(rec) {
    var card = el('article', 'lt');
    card.appendChild(iconBadge(MODE_ICON[str(rec.transportType)] || 'car'));
    var main = el('div', 'lt-main');
    main.appendChild(el('span', 'lt-name', (str(rec.provider) || 'Rental') + ' · ' + (MODE_LABEL[str(rec.transportType)] || 'Transport')));
    if (str(rec.vehicle)) main.appendChild(el('span', 'lt-vehicle', rec.vehicle));
    main.appendChild(el('span', 'lt-dates', fmtDay(rec.startDate) + ' → ' + fmtDay(rec.endDate) + (rec.days != null ? ' · ' + plural(+rec.days, 'day') : '')));
    if (str(rec.departureLocation)) main.appendChild(el('span', 'lt-loc', 'Pick up: ' + rec.departureLocation));
    if (str(rec.arrivalLocation)) main.appendChild(el('span', 'lt-loc', 'Return: ' + rec.arrivalLocation));
    card.appendChild(main);
    var refc = el('div', 'lt-ref');
    refc.appendChild(refChip(rec.confirmationNumber));
    card.appendChild(refc);
    var n = notesBlock(rec.notes, 'lt-notes');
    if (n) card.appendChild(n);
    return card;
  }

  /* ------------------------------------------------------------------ *
   * Trip model: resolve references and lay items out per day
   * ------------------------------------------------------------------ */
  function statusOf(trip, today) {
    var s = str(trip.startDate), e = str(trip.endDate);
    if (e && e < today) return { key: 'completed', label: 'Completed' };
    if (s && s > today) {
      var d = daysBetween(today, s);
      return { key: 'upcoming', label: d === 1 ? 'Tomorrow' : 'In ' + d + ' days' };
    }
    if (!s && !e) return { key: str(trip.status) || 'upcoming', label: str(trip.status) || 'Upcoming' };
    return { key: 'ongoing', label: 'Ongoing' };
  }

  function headline(trip) {
    var stops = arr(trip.stops);
    var cities = uniq(stops.map(function (s) { return str(s.city); }));
    var countries = uniq(stops.map(function (s) { return str(s.country); }));
    if (!cities.length) return str(trip.title) || 'Trip';
    if (cities.length <= 3) return cities.join(' · ');
    if (countries.length === 1) return countries[0];
    return countries.join(' · ');
  }

  function buildModel(trip, db) {
    var missing = [];
    function res(ref) {
      if (!ref || !ref.source) return null;
      var m = db[ref.source];
      var rec = m ? m.get(Number(ref.id)) : null;
      if (!rec) missing.push(ref);
      return { source: ref.source, id: ref.id, rec: rec || null };
    }

    var segs = arr(trip.segments).map(res).filter(Boolean);
    var stays = arr(trip.stays).map(function (id) { return res({ source: 'hotels', id: id }); });
    var lts = arr(trip.longTermTransport).map(function (id) { return res({ source: 'transport', id: id }); });
    var nights = arr(trip.nights).slice().sort(function (a, b) { return str(a.date) < str(b.date) ? -1 : 1; });

    // date range
    var dates = [str(trip.startDate), str(trip.endDate)];
    segs.forEach(function (s) { if (s.rec) dates.push(str(s.rec.departureDate || s.rec.startDate), str(s.rec.arrivalDate || s.rec.endDate)); });
    stays.forEach(function (s) { if (s.rec) dates.push(str(s.rec.checkInDate), str(s.rec.checkOutDate)); });
    lts.forEach(function (s) { if (s.rec) dates.push(str(s.rec.startDate), str(s.rec.endDate)); });
    nights.forEach(function (n) { dates.push(str(n.date)); });
    dates = dates.filter(function (d) { return parseYMD(d) != null; }).sort();
    var start = dates[0] || null, end = dates[dates.length - 1] || null;

    var days = [], byDate = Object.create(null);
    if (start) {
      var span = Math.min(daysBetween(start, end) || 0, 400);
      for (var i = 0; i <= span; i++) {
        var d = addDays(start, i);
        var day = { date: d, items: [] };
        days.push(day);
        byDate[d] = day;
      }
    }
    var loose = { date: null, items: [] }; // items without a usable date

    function put(date, key, order, build) {
      var day = byDate[str(date)] || loose;
      day.items.push({ key: key || '00:00', order: order || 0, build: build });
    }

    // issues keyed by reference
    var issues = arr(trip.issues).slice();
    var byRef = Object.create(null);
    issues.forEach(function (it) {
      arr(it.refs).forEach(function (r) { var k = refKey(r); if (k) (byRef[k] = byRef[k] || []).push(it); });
    });

    // connections keyed by the departing leg
    var connByDep = Object.create(null);
    arr(trip.connections).forEach(function (c) { var k = refKey(c.departure); if (k) connByDep[k] = c; });

    // legs
    segs.forEach(function (s) {
      var k = refKey(s);
      if (!s.rec) { put(null, '00:00', 0, function () { return missingRow(s, 'block'); }); return; }
      var v = legView(s.source, s.rec);
      var key = v.depTime || '12:00';
      var conn = connByDep[k];
      if (conn) {
        var warn = '';
        var ak = refKey(conn.arrival);
        (byRef[k] || []).forEach(function (it) {
          if (!arr(it.refs).some(function (r) { return refKey(r) === ak; })) return;
          if (it.type === 'airportChange') warn = 'airport';
          else if (it.type === 'tightConnection' && !warn) warn = 'tight';
        });
        if (!warn && /airport change/i.test(str(conn.notes))) warn = 'airport';
        put(v.depDate, key, -1, function () { return connRow(conn, warn); });
      }
      put(v.depDate, key, 0, function () { return segRow(s.source, s.rec); });
    });

    // stays: card on the check-in day
    var cardOn = Object.create(null);
    stays.forEach(function (s) {
      if (!s.rec) { put(null, '00:00', 0, function () { return missingRow(s, 'block'); }); return; }
      cardOn[str(s.rec.checkInDate) + '|' + refKey(s)] = true;
      put(s.rec.checkInDate, normTime(s.rec.checkInTime) || '15:00', 1, function () { return stayCard(s.rec); });
    });

    // nights
    var gapNights = 0;
    nights.forEach(function (n) {
      var d = str(n.date);
      if (str(n.type) === 'none') gapNights++;
      var r = n.ref ? res(n.ref) : null;
      if (str(n.type) === 'stay' && r && r.rec && str(r.rec.checkInDate) === d) {
        if (!cardOn[d + '|' + refKey(r)]) { cardOn[d + '|' + refKey(r)] = true; put(d, normTime(r.rec.checkInTime) || '15:00', 1, function () { return stayCard(r.rec); }); }
        return; // the card is the night
      }
      put(d, '24:00', 0, function () { return nightLine(n, r); });
    });

    // long-term transport: events + bars + overlaps
    var ltRecs = lts.filter(function (x) { return x.rec; });
    ltRecs.forEach(function (x) {
      put(x.rec.startDate, normTime(x.rec.departureTime) || '12:00', 2, function () { return ltEvent(x.rec, 'pickup'); });
      put(x.rec.endDate, normTime(x.rec.arrivalTime) || '12:00', -2, function () { return ltEvent(x.rec, 'return'); });
    });
    lts.forEach(function (x) { if (!x.rec) put(null, '00:00', 0, function () { return missingRow(x, 'block'); }); });

    var overlaps = Object.create(null);
    ltRecs.forEach(function (a, i) {
      ltRecs.forEach(function (b, j) {
        if (i >= j) return;
        var as = str(a.rec.startDate), ae = str(a.rec.endDate), bs = str(b.rec.startDate), be = str(b.rec.endDate);
        if (!as || !ae || !bs || !be || !(as < be && bs < ae)) return;
        var ka = refKey(a), kb = refKey(b);
        (overlaps[ka] = overlaps[ka] || []).push(b);
        (overlaps[kb] = overlaps[kb] || []).push(a);
        var already = issues.some(function (it) {
          var ks = arr(it.refs).map(refKey);
          return /rental/i.test(str(it.type)) && ks.indexOf(ka) !== -1 && ks.indexOf(kb) !== -1;
        });
        if (!already) {
          issues.push({ type: 'rentalOverlap', date: as > bs ? as : bs, refs: [{ source: 'transport', id: a.id }, { source: 'transport', id: b.id }],
            message: ltName(a.rec) + ' overlaps ' + ltName(b.rec) + ' (' + fmtShort(bs) + ' – ' + fmtShort(be) + ').' });
        }
      });
    });

    // missing records become issues too
    var seenMissing = Object.create(null);
    missing.forEach(function (r) {
      var k = refKey(r);
      if (seenMissing[k]) return;
      seenMissing[k] = true;
      issues.push({ type: 'missingRecord', date: null, refs: [r], message: 'Referenced ' + str(r.source) + ' record #' + str(r.id) + ' was not found in ' + str(r.source) + '.json.' });
    });

    // sort items inside each day
    days.concat([loose]).forEach(function (day) {
      day.items.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : a.order - b.order; });
    });

    var other = issues.filter(function (it) { return it.type !== 'missingLodging'; }).length;
    return { days: days, loose: loose, issues: issues, gapNights: gapNights, otherCount: other, lts: ltRecs, overlaps: overlaps, start: start, end: end };
  }

  function ltName(rec) {
    return (str(rec.provider) || MODE_LABEL[str(rec.transportType)] || 'Rental') + (str(rec.confirmationNumber) ? ' ' + str(rec.confirmationNumber) : '');
  }

  /* ------------------------------------------------------------------ *
   * Trip sections
   * ------------------------------------------------------------------ */
  function summaryBlock(trip, model) {
    var box = el('div', 'summary');
    function item(label, nodeOrText, wide) {
      var it = el('div', 'sum-item' + (wide ? ' wide' : ''));
      it.appendChild(el('span', 'sum-label', label));
      var v = el('span', 'sum-value');
      if (nodeOrText instanceof Node) v.appendChild(nodeOrText); else v.textContent = nodeOrText;
      it.appendChild(v);
      box.appendChild(it);
    }
    if (str(trip.title)) item('Route', trip.title, true);
    var dates = fmtDay(trip.startDate) + ' → ' + (str(trip.endDate) ? fmtDay(trip.endDate) : 'open');
    if (trip.nightsAway != null) dates += ' · ' + plural(+trip.nightsAway, 'night') + ' away';
    item('Dates', dates);
    var homes = [];
    if (str(trip.startHome)) homes.push('From ' + str(trip.startHome));
    if (str(trip.endHome)) homes.push('back to ' + str(trip.endHome));
    if (trip.returnBooked === false) homes.push('return not booked');
    if (homes.length) item('Home', homes.join(', '));
    if (arr(trip.countries).length) item('Countries', arr(trip.countries).map(str).join(', '));
    var comps = groupCompanions(arr(trip.companions));
    if (comps.length) {
      var list = el('span', 'companions');
      comps.forEach(function (c) {
        var chip = el('span', 'companion');
        chip.appendChild(icon('user'));
        chip.appendChild(el('span', 'companion-name', c.name));
        if (c.ranges) chip.appendChild(el('span', 'companion-range', c.ranges));
        list.appendChild(chip);
      });
      item('Travelling with', list, true);
    }
    if (str(trip.notes)) item('Notes', str(trip.notes), true);
    return box;
  }

  /* the same person can appear several times with separate date ranges: one chip per name */
  function groupCompanions(list) {
    var order = [], byName = Object.create(null);
    list.forEach(function (c) {
      if (!c) return;
      var name = str(c.name) || 'Companion';
      if (!byName[name]) { byName[name] = []; order.push(name); }
      var from = str(c.from), to = str(c.to);
      var text = !from && !to ? '' : from && to && from !== to ? fmtShort(from) + '–' + fmtShort(to) : fmtShort(from || to);
      if (text && byName[name].indexOf(text) === -1) byName[name].push(text);
    });
    return order.map(function (n) { return { name: n, ranges: byName[n].join(', ') }; });
  }

  function flagsPanel(issues) {
    var box = el('section', 'flags');
    box.setAttribute('aria-label', 'Flags');
    if (!issues.length) {
      var ok = el('div', 'flags-ok');
      ok.appendChild(icon('check_circle'));
      ok.appendChild(el('span', null, 'No issues flagged on this trip'));
      box.appendChild(ok);
      return box;
    }
    var sorted = issues.slice().sort(function (a, b) {
      var x = str(a.date) || '9999', y = str(b.date) || '9999';
      return x < y ? -1 : x > y ? 1 : 0;
    });
    var ul = el('ul', 'flag-list');
    sorted.forEach(function (it) {
      var li = el('li', 'flag ' + (RED_ISSUES[it.type] ? 'flag-red' : 'flag-amber'));
      var head = el('span', 'flag-head');
      head.appendChild(el('span', 'flag-type', ISSUE_LABEL[it.type] || str(it.type) || 'Issue'));
      head.appendChild(el('span', 'flag-date', str(it.date) ? fmtDay(it.date) : ''));
      li.appendChild(head);
      li.appendChild(el('span', 'flag-msg', str(it.message)));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  /* ground transport band: one date-range bar per rental / pass across the trip span */
  function ganttBlock(model) {
    var days = model.days;
    if (!model.lts.length || !days.length) return null;
    var n = days.length;
    var box = el('section', 'gantt');
    box.setAttribute('aria-label', 'Ground transport');
    box.appendChild(el('h3', 'band-title', 'Ground transport'));

    var scale = el('div', 'gantt-scale');
    scale.style.gridTemplateColumns = 'repeat(' + n + ', minmax(0, 1fr))';
    var every = n > 20 ? 4 : n > 10 ? 2 : 1;
    days.forEach(function (d, i) {
      var t = parseYMD(d.date);
      var dd = new Date(t).getUTCDate();
      var cell = el('span', 'gantt-tick', (i % every === 0 || dd === 1) ? (dd === 1 || i === 0 ? fmtShort(d.date) : String(dd)) : '');
      scale.appendChild(cell);
    });
    var scaleRow = el('div', 'gantt-row gantt-head');
    scaleRow.appendChild(el('span', 'gantt-label'));
    scaleRow.appendChild(scale);
    scaleRow.appendChild(el('span', 'gantt-ref'));
    box.appendChild(scaleRow);

    function colOf(date, edge) {
      var i = daysBetween(days[0].date, date);
      if (i == null) return edge === 'end' ? n : 0;
      return Math.max(0, Math.min(n, edge === 'end' ? i + 1 : i));
    }

    model.lts.forEach(function (x) {
      var rec = x.rec;
      var over = arr(model.overlaps[refKey(x)]);
      var row = el('div', 'gantt-row' + (over.length ? ' overlap' : ''));
      var label = el('div', 'gantt-label');
      var l1 = el('span', 'gantt-name');
      l1.appendChild(icon(MODE_ICON[str(rec.transportType)] || 'car'));
      l1.appendChild(el('span', null, str(rec.provider) || MODE_LABEL[str(rec.transportType)] || 'Rental'));
      label.appendChild(l1);
      if (str(rec.vehicle)) label.appendChild(el('span', 'gantt-vehicle', rec.vehicle));
      row.appendChild(label);

      var track = el('div', 'gantt-track');
      track.style.gridTemplateColumns = 'repeat(' + n + ', minmax(0, 1fr))';
      track.style.setProperty('--n', String(n));
      var c0 = colOf(rec.startDate, 'start'), c1 = colOf(rec.endDate, 'end');
      if (c1 <= c0) c1 = Math.min(n, c0 + 1);
      var bar = el('span', 'gantt-bar');
      bar.style.gridColumn = (c0 + 1) + ' / ' + (c1 + 1);
      bar.appendChild(el('span', 'gantt-bar-text', fmtShort(rec.startDate) + ' – ' + fmtShort(rec.endDate) + (rec.days != null ? ' · ' + plural(+rec.days, 'day') : '')));
      bar.title = str(rec.departureLocation) + (str(rec.arrivalLocation) && rec.arrivalLocation !== rec.departureLocation ? ' → ' + str(rec.arrivalLocation) : '');
      track.appendChild(bar);
      row.appendChild(track);

      var refc = el('div', 'gantt-ref');
      refc.appendChild(refChip(rec.confirmationNumber));
      row.appendChild(refc);

      var sub = el('div', 'gantt-sub');
      var pick = str(rec.departureLocation), ret = str(rec.arrivalLocation);
      if (pick) sub.appendChild(el('span', null, 'Pick up ' + pick));
      if (ret && ret !== pick) sub.appendChild(el('span', null, 'Return ' + ret));
      else if (ret) sub.appendChild(el('span', null, 'Return to the same location'));
      if (over.length) {
        var o = el('span', 'gantt-overlap');
        o.appendChild(icon('alert'));
        o.appendChild(el('span', null, 'Overlaps ' + over.map(function (b) { return ltName(b.rec); }).join(', ')));
        sub.appendChild(o);
      }
      row.appendChild(sub);
      box.appendChild(row);
    });
    return box;
  }

  function timelineBlock(model, today) {
    var box = el('section', 'timeline');
    box.setAttribute('aria-label', 'Day by day');
    box.appendChild(el('h3', 'band-title', 'Day by day'));
    model.days.forEach(function (day) {
      var sec = el('div', 'day' + (day.date === today ? ' today' : '') + (day.date < today ? ' past' : ''));
      var head = el('div', 'day-head');
      head.appendChild(el('span', 'day-date', fmtDay(day.date)));
      head.appendChild(el('span', 'day-year', String(day.date).slice(0, 4)));
      head.appendChild(el('span', 'day-rule'));
      if (day.date === today) head.appendChild(el('span', 'tag tag-accent', 'Today'));
      sec.appendChild(head);
      var body = el('div', 'day-body');
      if (!day.items.length) body.appendChild(el('div', 'day-empty', 'Nothing scheduled'));
      day.items.forEach(function (it) { body.appendChild(it.build()); });
      sec.appendChild(body);
      box.appendChild(sec);
    });
    if (model.loose.items.length) {
      var sec = el('div', 'day');
      var head = el('div', 'day-head');
      head.appendChild(el('span', 'day-date', 'Undated'));
      head.appendChild(el('span', 'day-rule'));
      sec.appendChild(head);
      var body = el('div', 'day-body');
      model.loose.items.forEach(function (it) { body.appendChild(it.build()); });
      sec.appendChild(body);
      box.appendChild(sec);
    }
    return box;
  }

  /* ------------------------------------------------------------------ *
   * Trip card (collapsed row + expanded body)
   * ------------------------------------------------------------------ */
  /* /#<trip-id> opens a trip of the current person; /#<person-slug>/<trip-id> also switches person */
  function parseHash() {
    var h = '';
    try { h = decodeURIComponent(location.hash.slice(1)); } catch (e) { h = ''; }
    if (!h) return { person: null, trip: '' };
    var i = h.indexOf('/');
    if (i === -1) return { person: null, trip: h };
    return { person: h.slice(0, i) + '.json', trip: h.slice(i + 1) };
  }

  /* trip id from the hash when it applies to the person on screen */
  function hashId() {
    var p = parseHash();
    if (p.person && p.person !== state.personFile) return '';
    return p.trip;
  }

  function tripCard(trip, db, today, openSet) {
    var id = str(trip.id) || (str(trip.startDate) + '-' + str(trip.title));
    var st = statusOf(trip, today);
    var model = buildModel(trip, db);
    var isOpen = openSet.has(id);

    var card = el('section', 'trip trip-' + st.key + (isOpen ? ' open' : ''));
    card.id = 'trip-' + id.replace(/[^a-zA-Z0-9_-]/g, '-');
    card.dataset.id = id;
    var bodyId = 'trip-body-' + id.replace(/[^a-zA-Z0-9_-]/g, '-');

    // collapsed row
    var row = el('button', 'trip-row');
    row.type = 'button';
    row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    row.setAttribute('aria-controls', bodyId);

    var chev = el('span', 'chev');
    chev.appendChild(icon('chevron'));
    row.appendChild(chev);

    var main = el('span', 'trip-main');
    main.appendChild(el('span', 'trip-name', headline(trip)));
    if (str(trip.title)) main.appendChild(el('span', 'trip-sub', trip.title));
    var badges = el('span', 'badges');
    badges.appendChild(el('span', 'tag tag-' + st.key, st.label));
    if (trip.nightsAway != null) badges.appendChild(el('span', 'tag tag-neutral', plural(+trip.nightsAway, 'night')));
    if (model.gapNights) badges.appendChild(flagTag('red', plural(model.gapNights, 'night') + ' without a stay'));
    if (model.otherCount) badges.appendChild(flagTag('amber', plural(model.otherCount, model.gapNights ? 'other issue' : 'issue')));
    if (trip.returnBooked === false) badges.appendChild(flagTag('red', 'No return booked'));
    if (!model.gapNights && !model.otherCount && trip.returnBooked !== false) badges.appendChild(el('span', 'tag tag-ok', 'No issues'));
    main.appendChild(badges);
    row.appendChild(main);

    row.appendChild(dateCell(trip.startDate, 'Start', 'start'));
    row.appendChild(dateCell(trip.endDate, 'End', 'end'));
    card.appendChild(row);

    // expanded body
    var body = el('div', 'trip-body');
    body.id = bodyId;
    body.hidden = !isOpen;
    body.appendChild(summaryBlock(trip, model));
    body.appendChild(flagsPanel(model.issues));
    var g = ganttBlock(model);
    if (g) body.appendChild(g);
    body.appendChild(timelineBlock(model, today));
    card.appendChild(body);

    row.addEventListener('click', function () {
      var open = body.hidden;
      body.hidden = !open;
      card.classList.toggle('open', open);
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) openSet.add(id); else openSet.delete(id);
      saveOpen();
    });
    return card;
  }

  function flagTag(kind, text) {
    var t = el('span', 'tag tag-' + kind);
    t.appendChild(icon('alert'));
    t.appendChild(document.createTextNode(text));
    return t;
  }

  function dateCell(date, label, cls) {
    var c = el('span', 'trip-date trip-date-' + cls);
    c.appendChild(el('span', 'trip-date-label', label));
    c.appendChild(el('b', null, str(date) ? fmtDate(date) : 'Open'));
    c.appendChild(el('small', null, str(date) ? dowLong(date) : ''));
    return c;
  }

  /* ------------------------------------------------------------------ *
   * State and rendering
   * ------------------------------------------------------------------ */
  var state = { index: null, people: [], personFile: null, personJson: null, db: null, sig: null };
  var openSets = Object.create(null); // personFile -> Set
  var renderedDay = null;
  var scrolledTo = null;

  function currentOpenSet() {
    var file = state.personFile || '_';
    if (openSets[file]) return openSets[file];
    var set = null;
    try {
      var v = JSON.parse(lsGet(KEY_OPEN + file) || 'null');
      if (Array.isArray(v)) set = new Set(v.map(String));
    } catch (e) { set = null; }
    if (!set) {
      // never chosen: open ongoing trips by default
      set = new Set();
      var today = todayStr();
      arr(state.personJson && state.personJson.trips).forEach(function (t) {
        if (statusOf(t, today).key === 'ongoing') set.add(str(t.id));
      });
    }
    var h = hashId();
    if (h) set.add(h);
    openSets[file] = set;
    return set;
  }

  function saveOpen() {
    var file = state.personFile || '_';
    if (openSets[file]) lsSet(KEY_OPEN + file, JSON.stringify(Array.from(openSets[file])));
  }

  function setEmpty(title, sub) {
    $('empty').hidden = false;
    $('empty-title').textContent = title;
    $('empty-sub').textContent = sub || '';
  }

  function renderSelect() {
    var sel = $('person');
    sel.textContent = '';
    if (!state.people.length) {
      var o = el('option', null, 'No travellers');
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    state.people.forEach(function (p) {
      var o = el('option', null, str(p.name) + (p.tripCount != null ? ' (' + p.tripCount + ')' : ''));
      o.value = str(p.file);
      sel.appendChild(o);
    });
    sel.value = state.personFile || '';
    sel.disabled = false;
  }

  function renderUnassigned(json, db) {
    var u = (json && json.unassigned) || {};
    var box = $('unassigned-body');
    box.textContent = '';
    var any = false;
    arr(u.flights).forEach(function (id) {
      any = true;
      var rec = db.flights.get(Number(id));
      box.appendChild(rec ? segRow('flights', rec, { who: true }) : missingRow({ source: 'flights', id: id }, 'block'));
    });
    arr(u.transport).forEach(function (id) {
      any = true;
      var rec = db.transport.get(Number(id));
      if (!rec) box.appendChild(missingRow({ source: 'transport', id: id }, 'block'));
      else box.appendChild(str(rec.term) === 'longTerm' ? ltCard(rec) : segRow('transport', rec, { who: true }));
    });
    arr(u.hotels).forEach(function (id) {
      any = true;
      var rec = db.hotels.get(Number(id));
      box.appendChild(rec ? stayCard(rec) : missingRow({ source: 'hotels', id: id }, 'block'));
    });
    $('unassigned').hidden = !any;
  }

  function render() {
    var today = todayStr();
    renderedDay = today;
    $('loading').hidden = true;
    $('empty').hidden = true;
    renderSelect();

    var up = $('updated');
    var gen = (state.personJson && state.personJson.generatedAt) || (state.index && state.index.generatedAt);
    up.textContent = fmtStamp(gen);
    if (gen && !isNaN(new Date(gen).getTime())) up.dateTime = new Date(gen).toISOString();

    var list = $('trips');
    list.textContent = '';
    var trips = arr(state.personJson && state.personJson.trips).slice().sort(function (a, b) {
      return str(a.startDate) < str(b.startDate) ? -1 : str(a.startDate) > str(b.startDate) ? 1 : 0;
    });

    if (!state.index) {
      $('list-section').hidden = true;
      $('unassigned').hidden = true;
      setEmpty('Trips have not been generated yet', 'Run the combined prompt to create trips/index.json. This page updates on its own once it exists.');
    } else if (!state.personFile) {
      $('list-section').hidden = true;
      $('unassigned').hidden = true;
      setEmpty('No travellers configured', 'trips/index.json lists no people.');
    } else if (!state.personJson) {
      $('list-section').hidden = true;
      $('unassigned').hidden = true;
      setEmpty('No trips file for ' + personName(), 'Expected ' + TRIPS_DIR + state.personFile + '. It appears here when the next run writes it.');
    } else {
      var openSet = currentOpenSet();
      trips.forEach(function (t) { list.appendChild(tripCard(t, state.db, today, openSet)); });
      $('list-section').hidden = !trips.length;
      renderUnassigned(state.personJson, state.db);
      if (!trips.length) setEmpty('No trips for ' + personName(), $('unassigned').hidden ? 'Nothing is booked for this traveller yet.' : 'Some bookings exist but none form a trip; see below.');
    }

    var upc = trips.filter(function (t) { return statusOf(t, today).key !== 'completed'; }).length;
    $('count').textContent = trips.length ? plural(trips.length, 'trip') + ' · ' + upc + ' upcoming or ongoing' : '';
    var src = (state.personJson && state.personJson.sourceRunDates) || (state.index && state.index.sourceRunDates) || {};
    $('sources').textContent = ['flights', 'hotels', 'transport'].map(function (k) {
      return k.charAt(0).toUpperCase() + k.slice(1) + ' scanned ' + fmtStamp(src[k]);
    }).join(' · ');

    // deep link: scroll once per hash
    var h = hashId();
    var hk = state.personFile + '#' + h;
    if (h && scrolledTo !== hk) {
      var target = null;
      Array.prototype.forEach.call(list.children, function (c) { if (c.dataset.id === h) target = c; });
      if (target) {
        scrolledTo = hk;
        var r = target.getBoundingClientRect();
        var bar = document.querySelector('.appbar');
        var top = bar ? bar.offsetHeight : 0;
        if (r.top < top || r.top > window.innerHeight - 120) window.scrollBy(0, r.top - top - 8);
      }
    }
  }

  function personName() {
    var p = state.people.filter(function (x) { return str(x.file) === state.personFile; })[0];
    return p ? str(p.name) : 'this traveller';
  }

  /* ------------------------------------------------------------------ *
   * Fetching, SSE, polling
   * ------------------------------------------------------------------ */
  var inflight = false;
  var again = false;

  function setConn(ok) { $('conn').hidden = ok; }

  function fetchText(url) {
    return fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (res.status === 404) return { status: 404, text: null };
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text().then(function (t) { return { status: 200, text: t }; });
      });
  }

  function parseOr(text, fallback) {
    if (text == null) return fallback;
    try { return JSON.parse(text); } catch (e) { return undefined; } // undefined = invalid (mid-write)
  }

  function pickPerson(people) {
    var files = people.map(function (p) { return str(p.file); }).filter(Boolean);
    if (!files.length) return null;
    var fromHash = parseHash().person;
    if (fromHash && files.indexOf(fromHash) !== -1) {
      if (fromHash !== lsGet(KEY_PERSON)) lsSet(KEY_PERSON, fromHash);
      return fromHash;
    }
    var want = lsGet(KEY_PERSON);
    return want && files.indexOf(want) !== -1 ? want : files[0];
  }

  function load() {
    if (inflight) { again = true; return; }
    inflight = true;
    var urls = [INDEX_URL, SOURCE_URLS.flights, SOURCE_URLS.hotels, SOURCE_URLS.transport];
    Promise.all(urls.map(fetchText))
      .then(function (r) {
        var index = parseOr(r[0].text, null);
        if (index === undefined) return null; // mid-write
        var people = index ? arr(index.people).filter(function (p) { return p && /^[a-z0-9-]+\.json$/i.test(str(p.file)); }) : [];
        var file = pickPerson(people);
        var personReq = file ? fetchText(TRIPS_DIR + file) : Promise.resolve({ status: 404, text: null });
        return personReq.then(function (pr) {
          var sig = [file || '', r[0].text, r[1].text, r[2].text, r[3].text, pr.text].join('\u0000');
          if (sig === state.sig) return;
          var personJson = parseOr(pr.text, null);
          var sources = { flights: parseOr(r[1].text, null), hotels: parseOr(r[2].text, null), transport: parseOr(r[3].text, null) };
          if (personJson === undefined || sources.flights === undefined || sources.hotels === undefined || sources.transport === undefined) return; // keep last good
          if (personJson && !Array.isArray(personJson.trips)) personJson = null;
          state.sig = sig;
          state.index = index;
          state.people = people;
          state.personFile = file;
          state.personJson = personJson;
          state.db = buildDb(sources);
          render();
        });
      })
      .then(function () { setConn(true); })
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
    es.addEventListener('message', load);
    es.addEventListener('change', load);
    es.addEventListener('open', load);
  }

  function boot() {
    $('person').addEventListener('change', function () {
      var file = this.value;
      lsSet(KEY_PERSON, file);
      state.sig = null; // force a re-render with the new file
      load();
    });
    load();
    connectEvents();
    setInterval(load, POLL_MS);
    setInterval(function () { if (state.index && todayStr() !== renderedDay) render(); }, DAY_CHECK_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
    window.addEventListener('online', load);
    window.addEventListener('hashchange', function () {
      var p = parseHash();
      if (p.person && p.person !== state.personFile) { state.sig = null; load(); return; } // switches person, then opens
      var h = hashId();
      if (h && state.personJson) { currentOpenSet().add(h); saveOpen(); render(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
