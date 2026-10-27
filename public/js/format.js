// The version of the saved-puzzle format this code reads and writes. The website, the
// iPhone app and the Worker all use it, so an older copy of the code can never quietly
// damage a puzzle saved by a newer one. Rules for changing the format:
//  - only ever add fields; never rename one or change what an existing one means
//  - keep fields you don't recognise when saving (records are updated in place)
//  - bump FORMAT_VERSION when a change would confuse older code; older code then
//    refuses to open or overwrite those puzzles instead of guessing
export const FORMAT_VERSION = 1;

// Puzzles saved before versions existed count as version 1.
export function formatOf(rec) {
  return Number.isInteger(rec?.v) && rec.v > 0 ? rec.v : 1;
}

// Whether this code understands a saved puzzle well enough to open and save it.
export function canOpen(rec) {
  return formatOf(rec) <= FORMAT_VERSION;
}

// Whether saving `incoming` over `stored` would replace a newer format with an older one.
export function isDowngrade(stored, incoming) {
  return formatOf(stored) > formatOf(incoming);
}
