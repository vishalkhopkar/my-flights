# My Flights Board

A local airport-style departure board for my upcoming flights. `flights.json` is the data; the page re-renders live whenever that file changes. No npm dependencies, Node 18+ only.

## Run

```
node server.js          # or: npm start
```

Then open http://localhost:3000 for the trip itinerary (built from the per-person files in `trips/`, resolved against `flights.json`, `hotels.json` and `transport.json`), or http://localhost:3000/departures for the departure board (built from `flights.json`).

The itinerary page has a traveller selector (remembered in the browser), one expandable row per trip, and deep links: `/#<trip-id>` opens a trip of the selected traveller, `/#<person-file-without-.json>/<trip-id>` (e.g. `/#jane-doe/2027-03-10-lisbon`) also switches traveller first. Set `PORT=3001` to use another port. The server binds to `127.0.0.1` only (not reachable from the network).

## Live updates

The page opens a Server-Sent Events stream at `GET /events`. The server watches the project directory for changes to `flights.json` and `trips.json` (`fs.watch`, so atomic save/rename by editors is caught) and also polls its size/mtime every second as a fallback. Changes are debounced (~150 ms) so one edit sends one `change` event, and the page refetches `/flights.json`. A `: ping` comment is sent every 20 s to keep the connection alive. A `change` event is also sent when a new airline logo has been cached.

## Airline logos

Logos are cached as `logos/<code>.png`, where `<code>` is the lowercase IATA airline code (`aa`, `jl`, `9w`, ...). The code comes from `airlineCode` in each flight, or from the `flightNumber` prefix when that is missing.

- The server fetches missing logos at startup and whenever `flights.json` changes (hidden flights included), retrying failures at most every 10 minutes.
- To prefetch manually: `npm run logos` (or `node scripts/fetch-logos.js`). Pass codes (`node scripts/fetch-logos.js aa jl`) or `--force` to re-download.
- Sources are tried in order (kiwi.com, Google gstatic, pics.avs.io, daisycon) with a 10 s timeout. Only real PNGs are saved, atomically; an existing logo is never overwritten without `--force`.
- If no source has a logo, nothing is written and the page shows a text badge instead. You can also drop your own `logos/<code>.png` in place.

## What the server exposes

Only an allowlist is served; everything else returns 404 (including `config.json`, `flight-prompt.md`, `server.js`, dotfiles and `..` paths):

| Path | Notes |
| --- | --- |
| `/`, `/index.html` | trip itinerary, no-store |
| `/departures` | departure board (`departures.html`, not reachable by its file name), no-store |
| `/css/*`, `/js/*` | no-store |
| `/flights.json`, `/hotels.json`, `/transport.json` | source records (`{ runDate, nextId, data: [{ id, ... }] }`), no-store |
| `/trips/index.json`, `/trips/<name>.json` | per-person trips (`<name>` must match `^[a-z0-9-]+$`), no-store |
| `/logos/*` | `max-age=60` with ETag |
| `/events` | Server-Sent Events |

## Daily run (Windows)

`flight-prompt.md` is run in a headless Claude Code session once a day at the local time set by
`runTimes.flight` in `config.json` (24-hour `HH:mm`, default `08:00`; `runTimes` also holds `hotel` and `transport`, not scheduled yet).

```powershell
powershell -File scriptsschedule-daily.ps1               # create / update the scheduled task
powershell -File scriptsschedule-daily.ps1 -Unregister   # remove it
Start-ScheduledTask -TaskName MyFlightsDailyTracker        # run it now
```

Re-run the schedule script after changing `runTimes.flight`. The task runs only while you are logged on;
if the PC is off at the set time it runs at the next opportunity.

Each run appends a row to `log.csv`:

| column | meaning |
|---|---|
| `run_date` | scan start time, UTC |
| `success` | Claude Code ran and Gmail could be read (`flights.json` came back valid with a fresh `runDate`) |
| `changed` | the flight data differs from before the run |
| `type` | kind of run: `flight` or `hotel` |

If a run fails, `flights.json` is restored to what it was before. The full output of the last run is in
`last-run.txt`. The session is limited to read-only Gmail tools plus writes to the tracker's own files.

## Files

```
index.html            trip itinerary page shell (served at /)
css/trips.css         itinerary styling (light + dark themes, Schibsted Grotesk)
js/trips.js           itinerary rendering: traveller selector, id resolution, day-by-day timeline, flags, live updates
departures.html       departure board page shell (served at /departures)
css/styles.css        departure board styling
js/app.js             departure board rendering, filtering, live updates
server.js             static server + SSE + logo caching
scripts/fetch-logos.js  logo downloader (CLI and module)
logos/                cached airline logos (logos/<code>.png)
flights.json          flight records (one row per passenger, each with an id)
hotels.json           hotel records (each with an id)
transport.json        ground transport records (each with an id)
trips/index.json      list of travellers and their trip files
trips/<name>.json     one traveller's trips, referencing records by { source, id }
config.json           local settings (not served)
flight-prompt.md, hotel-prompt.md, transport-prompt.md   prompts that update the source files (not served)
combined-prompt.md    prompt that builds trips/ from the source files (not served)
scripts/run-tracker.ps1     headless daily run + log.csv row
scripts/schedule-daily.ps1  registers the daily scheduled task
log.csv, last-run.txt       run log and last run output (generated)
```
