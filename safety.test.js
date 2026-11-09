import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hostAllowed, labAllowedHosts, writeAllowed } from './safety.js';

// Example names only (.example); the real lab-proxy name lives in docker-compose.yml.
const LAB = 'lab.example';
const PROXY = 'front.example:8443';
const names = labAllowedHosts(` ${LAB.toUpperCase()}, bad name, http://x.example `);

test('LAB_ALLOWED_HOSTS keeps bare DNS names only', () => {
  assert.deepEqual([...names], [LAB]);
});

test('Host check: loopback on any port, the lab name only on this port, nothing else', () => {
  for (const h of ['localhost', '127.0.0.1:1', '[::1]:6884', 'LOCALHOST:6884', `${LAB}:6884`]) assert.ok(hostAllowed(h, names, 6884), h);
  for (const h of [`${LAB}:6885`, LAB, 'evil.example:6884', `x.${LAB}:6884`, 'front.example:6884', '', undefined, 'a b', '127.0.0.1.evil.example']) {
    assert.ok(!hostAllowed(h, names, 6884), String(h));
  }
});

const proxied = { host: `${LAB}:6884`, 'x-forwarded-host': PROXY, 'x-forwarded-proto': 'https' };
const ok = (headers, method = 'POST') => writeAllowed(method, headers, names, 6884);

test('writes: launcher, loopback and no-Origin accepted; reads always pass', () => {
  assert.ok(ok({ ...proxied, origin: `https://${PROXY}` }));
  assert.ok(ok({ host: '127.0.0.1:6884', origin: 'http://127.0.0.1:6884' }));
  assert.ok(ok({ host: 'localhost:6884', origin: 'http://localhost:6884' }));
  assert.ok(ok({ host: '127.0.0.1:6884' }));
  assert.ok(ok({ host: '127.0.0.1:6884', origin: 'https://evil.example' }, 'GET'));
});

test('writes: foreign or mismatched Origin refused, forwarded headers count only on the lab Host', () => {
  assert.ok(!ok({ ...proxied, origin: 'https://evil.example' }));
  assert.ok(!ok({ host: '127.0.0.1:6884', origin: 'https://evil.example' }));
  assert.ok(!ok({ host: '127.0.0.1:6884', origin: 'http://127.0.0.1:9999' }));
  assert.ok(!ok({ host: '127.0.0.1:6884', origin: 'null' }));
  // Forwarded headers on a loopback Host are ignored: the proxy's origin is not accepted there.
  assert.ok(!ok({ host: '127.0.0.1:6884', 'x-forwarded-host': PROXY, 'x-forwarded-proto': 'https', origin: `https://${PROXY}` }));
  // On the lab Host the forwarded headers must be present, well-formed and match the Origin exactly.
  assert.ok(!ok({ host: `${LAB}:6884`, origin: `https://${PROXY}` }));
  assert.ok(!ok({ ...proxied, 'x-forwarded-proto': 'ftp', origin: `ftp://${PROXY}` }));
  assert.ok(!ok({ ...proxied, 'x-forwarded-proto': undefined, origin: `https://${PROXY}` }));
  assert.ok(!ok({ ...proxied, origin: `http://${PROXY}` }));
  assert.ok(!ok({ ...proxied, host: `${LAB}:6885`, origin: `https://${PROXY}` }));
  assert.ok(!ok({ host: '127.0.0.1:6884', 'sec-fetch-site': 'cross-site' }));
});

// End to end against the real server.
const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const send = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  r.on('error', reject);
  r.end(body === undefined ? undefined : JSON.stringify(body));
});

test('server: launcher and loopback writes reach the route; foreign Origin 403; bad Host 421', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(here, 'server.js')], {
    env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), LAB_ALLOWED_HOSTS: LAB, HOME: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('exit', (code) => reject(new Error(`server exited early: ${code}`)));
      child.stdout.on('data', (d) => { if (String(d).includes('running on')) resolve(); });
    });
    const lab = { host: `${LAB}:${port}`, 'x-forwarded-host': PROXY, 'x-forwarded-proto': 'https' };
    const loop = { host: `127.0.0.1:${port}` };
    assert.equal(await send(port, 'GET', '/api/health', lab), 200);
    assert.equal(await send(port, 'GET', '/api/health', loop), 200);
    assert.equal(await send(port, 'POST', '/api/config', { ...lab, origin: `https://${PROXY}` }, { scopes: 'openid' }), 200);
    assert.equal(await send(port, 'POST', '/api/config', { ...loop, origin: `http://127.0.0.1:${port}` }, { scopes: 'openid' }), 200);
    assert.equal(await send(port, 'POST', '/api/config', { ...lab, origin: 'https://evil.example' }, {}), 403);
    assert.equal(await send(port, 'POST', '/api/config', { ...loop, origin: 'https://evil.example' }, {}), 403);
    assert.equal(await send(port, 'POST', '/api/config', { ...loop, 'x-forwarded-host': PROXY, 'x-forwarded-proto': 'https', origin: `https://${PROXY}` }, {}), 403);
    assert.equal(await send(port, 'GET', '/api/health', { host: `evil.example:${port}` }), 421);
    assert.equal(await send(port, 'POST', '/api/config', { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }, {}), 421);
  } finally {
    child.kill();
  }
});
