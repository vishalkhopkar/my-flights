# My Flights Board

A local airport-style departure board for my upcoming flights. `flights.json` is the data; the page re-renders live whenever that file changes. No npm dependencies, Node 18+ only.

## Run

```
node server.js          # or: npm start
```

Then open http://localhost:3000. Set `PORT=3001` to use another port. The server binds to `127.0.0.1` only (not reachable from the network).

## Live updates

The page opens a Server-Sent Events stream at `GET /events`. The server watches the project directory for changes to `flights.json` (`fs.watch`, so atomic save/rename by editors is caught) and also polls its size/mtime every second as a fallback. Changes are debounced (~150 ms) so one edit sends one `change` event, and the page refetches `/flights.json`. A `: ping` comment is sent every 20 s to keep the connection alive. A `change` event is also sent when a new airline logo has been cached.

## Airline logos

Logos are cached as `logos/<code>.png`, where `<code>` is the lowercase IATA airline code (`aa`, `jl`, `9w`, ...). The code comes from `airlineCode` in each flight, or from the `flightNumber` prefix when that is missing.

- The server fetches missing logos at startup and whenever `flights.json` changes (hidden flights included), retrying failures at most every 10 minutes.
- To prefetch manually: `npm run logos` (or `node scripts/fetch-logos.js`). Pass codes (`node scripts/fetch-logos.js aa jl`) or `--force` to re-download.
- Sources are tried in order (kiwi.com, Google gstatic, pics.avs.io, daisycon) with a 10 s timeout. Only real PNGs are saved, atomically; an existing logo is never overwritten without `--force`.
- If no source has a logo, nothing is written and the page shows a text badge instead. You can also drop your own `logos/<code>.png` in place.

## What the server exposes

Only an allowlist is served; everything else returns 404 (including `config.json`, `prompt.md`, `server.js`, dotfiles and `..` paths):

| Path | Notes |
| --- | --- |
| `/`, `/index.html` | no-store |
| `/css/*`, `/js/*` | no-store |
| `/flights.json` | no-store |
| `/logos/*` | `max-age=60` with ETag |
| `/events` | Server-Sent Events |

## Files

```
index.html            page shell
css/styles.css        styling
js/app.js             rendering, filtering, live updates
server.js             static server + SSE + logo caching
scripts/fetch-logos.js  logo downloader (CLI and module)
logos/                cached airline logos (logos/<code>.png)
flights.json          the flight data
config.json           local settings (not served)
prompt.md             prompt used to generate/update flights.json (not served)
```
