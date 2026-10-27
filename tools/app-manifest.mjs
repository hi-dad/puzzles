// Writes public/app-manifest.json: the list of game files (with fingerprints) that the
// iPhone app downloads to update itself from poozles.app. Run `npm run manifest` after
// changing anything in public/ (the tests fail if it's out of date).
//   minApp: the oldest app shell these files work with (GameFiles.shellVersion in the
//   app). Raise it when the web code starts needing something new from the shell.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_APP = 1;
const root = fileURLToPath(new URL('../public/', import.meta.url));
const out = join(root, 'app-manifest.json');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name.startsWith('.')) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function buildManifest() {
  const files = walk(root)
    .filter((p) => p !== out)
    .map((p) => ({ path: relative(root, p).split('\\').join('/'), sha256: createHash('sha256').update(readFileSync(p)).digest('hex') }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const version = createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex').slice(0, 16);
  return { version, minApp: MIN_APP, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(out, JSON.stringify(buildManifest(), null, 1) + '\n');
  console.log('app-manifest.json updated');
}
