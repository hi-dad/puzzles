# Poozles (repo: hi-dad/puzzles)

- Run: `npm run dev` (Worker + site at http://localhost:8787; preview server name `poozles`). Tests: `npm test`.
- First time locally: `npm run db:local` creates the D1 tables. `.dev.vars` (gitignored) needs `DEV_EMAIL=dev@example.com` for the "Developer sign-in" button.
- **Pushing to main deploys live** (Cloudflare Workers Builds). Don't push without the owner's OK.
- Schema changes must also be applied to the live DB: `npx wrangler d1 execute puzzle-table --remote --file worker/schema.sql` (all statements are `IF NOT EXISTS`).
- Saves are keyed by the signed-in email (puzzles rows and R2 photo keys `encodeURIComponent(email)/id`). Never change that key: existing players' puzzles depend on it.
- The IndexedDB name stays `puzzle-table` (renaming it would hide players' local saves).
- Owner stays anonymous: never put a real name in the repo, README or commits.
- Saved-puzzle format is versioned (`public/js/format.js`, field `v`). Only add fields; never rename or repurpose one; keep unknown fields when saving. Bump `FORMAT_VERSION` for changes older code would misread. Older code then won't open those puzzles, and the Worker answers 426 instead of letting an older format overwrite a newer one.
- iPhone/iPad app: `app/` (Swift, WKWebView shell, bundle ID `app.poozles`, team 4J889SV3P4). Build: `cd app && xcodebuild -project Poozles.xcodeproj -scheme Poozles -destination 'platform=iOS Simulator,id=<sim>' -derivedDataPath build CODE_SIGNING_ALLOWED=NO build`. A build step copies `public/` into the app as `web/`, served at `poozles://app/`. Debug launch arg `-api http://localhost:8787` points it at `npm run dev` (dev sign-in then works in the app).
- The app updates its game files from `public/app-manifest.json`: run `npm run manifest` after any change in `public/` (a test fails otherwise). Raise `minApp` in tools/app-manifest.mjs and `GameFiles.shellVersion` together when web code needs new native features.
- Web code detects the app via `public/js/native.js` (`window.poozlesApp`); the Worker allows origin `poozles://app` (CORS) and accepts the app's live-room token as WebSocket sub-protocol `poozles, <token>`.
