// The image copies server files one by one, so a new module the server imports must be added to the Dockerfile too.
// (mcpUrl.js was missed once: the container crashed with ERR_MODULE_NOT_FOUND while every test passed.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function localImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = fs.readFileSync(path.join(here, file), 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([\w.-]+\.js)['"]/g)) localImports(m[1], seen);
  return seen;
}

test('the Dockerfile copies every local module server.js imports', () => {
  const docker = fs.readFileSync(path.join(here, 'Dockerfile'), 'utf8');
  const copied = new Set(docker.split('\n').filter((l) => /^COPY\s/.test(l)).flatMap((l) => l.trim().split(/\s+/).slice(1, -1)));
  const missing = [...localImports('server.js')].filter((f) => !copied.has(f));
  assert.deepEqual(missing, [], `add to the Dockerfile COPY line: ${missing.join(' ')}`);
});
