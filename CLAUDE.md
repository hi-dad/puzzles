# Poozles (repo: hi-dad/puzzles)

- Run: `npm run dev` (Worker + site at http://localhost:8787; preview server name `poozles`). Tests: `npm test`.
- First time locally: `npm run db:local` creates the D1 tables. `.dev.vars` (gitignored) needs `DEV_EMAIL=dev@example.com` for the "Developer sign-in" button.
- **Pushing to main deploys live** (Cloudflare Workers Builds). Don't push without the owner's OK.
- Schema changes must also be applied to the live DB: `npx wrangler d1 execute puzzle-table --remote --file worker/schema.sql` (all statements are `IF NOT EXISTS`).
- Saves are keyed by the signed-in email (puzzles rows and R2 photo keys `encodeURIComponent(email)/id`). Never change that key: existing players' puzzles depend on it.
- The IndexedDB name stays `puzzle-table` (renaming it would hide players' local saves).
- Owner stays anonymous: never put a real name in the repo, README or commits.
