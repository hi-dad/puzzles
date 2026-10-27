import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildManifest } from '../tools/app-manifest.mjs';

test('the app update list matches the files in public/ (run `npm run manifest`)', () => {
  const saved = JSON.parse(readFileSync(new URL('../public/app-manifest.json', import.meta.url)));
  assert.deepEqual(saved, buildManifest());
});
