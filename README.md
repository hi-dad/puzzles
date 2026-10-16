# Puzzle Table

Turn your own photos into jigsaw puzzles and solve them in the browser, on iPhone or Mac.

## Features
- Pick any photo, choose 24–1000 pieces, and preview the cut before starting
- Real jigsaw shapes with a different random cut for every puzzle
- Scrollable piece tray: swipe sideways to browse, swipe a piece up (or drag it with the mouse) to lift it, tap to drop it on the table
- Pinch / trackpad zoom, drag to pan, pieces snap together and lock into the frame
- Wooden table, felt-lined tray, puzzle mat and soft piece shadows (all drawn in code, no image files)
- A white ripple of light runs through the pieces whenever they click into place
- Sharp pieces even at 1000: the puzzle image is sized to the piece count (within iPhone memory limits)
- Optional rotation mode: pieces start turned, tap one to turn it 90°
- Adjustable tray piece size (⋯ menu)
- Select several table pieces (tap them or drag a box; Shift on a Mac) and move them together
- Tidy: send all single loose pieces back to the tray (placed pieces and joined clusters stay)
- Sort the tray by colour (shared with the "All pieces" view)
- "All pieces" view: every tray piece full-screen, sortable by colour; select several and place them together
- "Edges only" tray filter, a faint picture on the board as a guide, table colours, sounds
- Auto-saves every move on the device (IndexedDB); a library with progress and finish times

## Run locally
```
npm install
npm run db:local   # once: create the local database table
npm run dev        # app + backend at http://localhost:8787 (signed in as dev@example.com)
npm test           # board-logic unit tests
```
No build step: `public/` is plain HTML/CSS/ES modules. `npm run dev:static` serves just the
front end (no backend); the app then saves on the device only.

## How saving works
Every device keeps a full copy of each puzzle in the browser (IndexedDB), so play is instant
and works offline. When the backend is reachable, changes are also copied to Cloudflare:

```
browser ──/api/*──► Worker (worker/index.js) ──► D1  (one row per puzzle: positions, timer…)
   ▲                    │                     └─► R2  (the puzzle photo)
   └── HTML/JS/CSS ─────┘  served as static assets
```

- **Who you are** comes from Cloudflare Access in front of the Worker (email + one-time
  code). The verified email is the owner key for everything stored.
- **Sync** (`public/js/sync.js`): saves upload ~2.5 s after the last move; the library and
  open puzzle pull newer copies when the app is opened, focused, or every 2 minutes.
- **Conflicts** (same puzzle advanced on two devices): the most recent save wins; if the
  puzzle on screen is older than the cloud copy, the app asks "Load latest / Keep this one".
- The puzzle clock pauses after 2 idle minutes, so a device left open never saves over
  progress made elsewhere.

## Deploy (Cloudflare)
`wrangler.jsonc` describes the Worker, its D1 database and R2 bucket. The table schema is
in `worker/schema.sql`. Deploys run `npx wrangler deploy`, either from your computer or
automatically from GitHub via Cloudflare Workers Builds.

Live at https://puzzles.daniel-ryan312.workers.dev — every push to this branch redeploys it.

### Sign-in (Cloudflare Access)
- Worker → **Access** → protect **All traffic**; the policy uses the **Emails** selector
  (exact addresses), not "Email domain".
- Login method: **One-time PIN** (Zero Trust → Integrations → Identity providers), so people
  without a Cloudflare account get an emailed code.
- The Worker verifies each request's signed `Cf-Access-Jwt-Assertion` token against
  `TEAM_DOMAIN` and `POLICY_AUD` in `wrangler.jsonc` (public identifiers: the Access team
  domain and this app's audience tag). If the Access app is ever recreated, its audience tag
  changes: open `/api/me`, which lists `tokenAudience` when sign-in fails, and update
  `POLICY_AUD`.

## Code map
- `public/js/geometry.js`: grid sizing, seeded jigsaw cut, piece rendering
- `public/js/logic.js`: pure snapping/grouping rules (unit-tested)
- `public/js/game.js`: canvas board, tray, touch/mouse/trackpad input
- `public/js/main.js`: screens (library, new puzzle, play), saving, timer
- `public/js/textures.js`: procedural wood, felt and linen surfaces
- `public/js/sync.js`: cloud sync with the Worker
- `public/js/db.js`, `image.js`, `sound.js`: storage, photo prep, sound effects
- `worker/index.js`: the Cloudflare Worker (API + static assets), `worker/schema.sql`: D1 table

## Roadmap
- Play together live on one board (a Durable Object room per puzzle, WebSocket sync)
