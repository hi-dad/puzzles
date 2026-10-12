# Puzzle Table

Turn your own photos into jigsaw puzzles and solve them in the browser, on iPhone or Mac.

## Features
- Pick any photo, choose 24–1000 pieces, and preview the cut before starting
- Real jigsaw shapes with a different random cut for every puzzle
- Scrollable piece tray: swipe sideways to browse, swipe a piece up (or drag it with the mouse) to lift it, tap to drop it on the table
- Pinch / trackpad zoom, drag to pan, pieces snap together and lock into the frame
- Optional rotation mode: pieces start turned, tap one to turn it 90°
- Adjustable tray piece size (⋯ menu)
- "Edges only" tray filter, a faint picture on the board as a guide, table colours, sounds
- Auto-saves every move on the device (IndexedDB); a library with progress and finish times

## Run locally
```
npm run dev      # http://localhost:5173
npm test         # board-logic unit tests
```
No build step: `public/` is plain HTML/CSS/ES modules.

## Code map
- `public/js/geometry.js`: grid sizing, seeded jigsaw cut, piece rendering
- `public/js/logic.js`: pure snapping/grouping rules (unit-tested)
- `public/js/game.js`: canvas board, tray, touch/mouse/trackpad input
- `public/js/main.js`: screens (library, new puzzle, play), saving, timer
- `public/js/db.js`, `image.js`, `sound.js`: storage, photo prep, sound effects

## Roadmap
- Cloud save on Cloudflare (R2 for photos, D1/Durable Objects for progress) so puzzles follow you between devices
- Play together live on one board (a Durable Object room per puzzle, WebSocket sync)
- Private access via Cloudflare Access
