import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(here, 'server.js')], {
    env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited early: ${code}`)));
    child.stdout.on('data', (d) => { if (String(d).includes('running on')) resolve(); });
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

test('GET /api/shelf returns SHELF_URL with the trailing slash trimmed; POST is not 200', async () => {
  const srv = await startServer({ SHELF_URL: 'https://shelf.example:8443/', HOME: '/nonexistent' });
  try {
    const res = await fetch(`${srv.base}/api/shelf`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { shelfUrl: 'https://shelf.example:8443' });
    const post = await fetch(`${srv.base}/api/shelf`, { method: 'POST' });
    assert.notEqual(post.status, 200);
  } finally {
    srv.stop();
  }
});

test('GET /api/shelf returns null when no shelf is configured', async () => {
  const srv = await startServer({ HOME: '/nonexistent' });
  try {
    const res = await fetch(`${srv.base}/api/shelf`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { shelfUrl: null });
  } finally {
    srv.stop();
  }
});
