import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cimdClientIdUrl, clientDocument, serverSupportsCimd, setupGuideUrl } from './cimd.js';
import { labAllowedHosts } from './safety.js';

// Example names only (.example); the real lab name lives in docker-compose.yml.
const LAB = 'lab.example';
const hosted = labAllowedHosts(LAB);
const loopbackOnly = labAllowedHosts('');

test('the document URL is https on the lab host and null without one', () => {
  assert.equal(cimdClientIdUrl(hosted), 'https://lab.example/client.json');
  assert.equal(cimdClientIdUrl(loopbackOnly), null);
  assert.equal(cimdClientIdUrl(labAllowedHosts('localhost')), null);
  assert.equal(cimdClientIdUrl(labAllowedHosts('127.0.0.1')), null);
});

test('the document names its own URL, one https redirect, and holds no secret', () => {
  const doc = clientDocument(hosted);
  assert.equal(doc.client_id, cimdClientIdUrl(hosted));
  assert.deepEqual(doc.redirect_uris, ['https://lab.example/auth/callback']);
  assert.equal(doc.token_endpoint_auth_method, 'none');
  assert.ok(!Object.keys(doc).some((k) => /secret|jwks|password/i.test(k)));
  assert.equal(clientDocument(loopbackOnly), null);
});

test('a server counts as CIMD-capable only with the flag true and "none" allowed', () => {
  const ok = { client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['client_secret_post', 'none'] };
  assert.equal(serverSupportsCimd(ok), true);
  assert.equal(serverSupportsCimd({ ...ok, client_id_metadata_document_supported: false }), false);
  assert.equal(serverSupportsCimd({ ...ok, client_id_metadata_document_supported: 'true' }), false);
  assert.equal(serverSupportsCimd({ ...ok, token_endpoint_auth_methods_supported: ['client_secret_post'] }), false);
  assert.equal(serverSupportsCimd({ client_id_metadata_document_supported: true }), false);
  assert.equal(serverSupportsCimd(null), false);
});

// End to end: the real server against an in-process stub authorization server.
const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

// Stub: a 401 MCP endpoint, resource metadata, AS metadata (CIMD flag on or off) and a /register counter.
function stubAs(cimd, { acceptAll = false } = {}) {
  const calls = { register: 0 };
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/door/mcp') return send(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/rm"` });
    if (req.url === '/rm') return send(200, { authorization_servers: [`${base}/as`] });
    if (req.url === '/as/.well-known/oauth-authorization-server') {
      return send(200, {
        authorization_endpoint: `${base}/as/authorize`,
        token_endpoint: `${base}/as/token`,
        registration_endpoint: `${base}/as/register`,
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        ...(cimd ? { client_id_metadata_document_supported: true } : {})
      });
    }
    if (req.url.startsWith('/as/authorize')) {
      const q = new URL(req.url, base).searchParams;
      if (acceptAll) { res.writeHead(302, { location: 'https://signin.example/' }); return res.end(); }
      if (String(q.get('redirect_uri')).includes('evil')) { res.writeHead(400, { 'content-type': 'text/html' }); return res.end('<style>.x{color:red}</style><h1>redirect_uri is not registered for this client</h1>'); }
      if (String(q.get('client_id')).includes('example.com')) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('This client is not approved for use here. The document is not listed for this tenant.'); }
      res.writeHead(302, { location: 'https://signin.example/' }); return res.end();
    }
    if (req.url === '/as/register' && req.method === 'POST') {
      calls.register += 1;
      req.resume();
      return send(201, { client_id: 'registered-id', redirect_uris: ['http://127.0.0.1/cb'] });
    }
    return send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` })));
}

async function withApp(labHosts, fn, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(here, 'server.js')], {
    env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), LAB_ALLOWED_HOSTS: labHosts, HOME: '/nonexistent', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('exit', (code) => reject(new Error(`server exited early: ${code}`)));
      child.stdout.on('data', (d) => { if (String(d).includes('running on')) resolve(); });
    });
    await fn(port);
  } finally {
    child.kill();
  }
}

// A same-origin request as the browser would send it. Behind the ingress the Host is the bare lab name
// and the origin comes from the forwarded headers; on loopback the Origin must equal the Host.
// (Node's fetch cannot set Host, so use http.request, as safety.test.js does.)
const LAB_VIA_INGRESS = { host: LAB, 'x-forwarded-host': LAB, 'x-forwarded-proto': 'https', origin: `https://${LAB}` };
const call = (port, method, p, body, viaLab = false) => new Promise((resolve, reject) => {
  const headers = viaLab ? LAB_VIA_INGRESS : { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(text) }));
  });
  r.on('error', reject);
  r.end(body === undefined ? undefined : JSON.stringify(body));
});

test('hosted build serves its document and a CIMD server gets it as client_id with no registration', async () => {
  const stub = await stubAs(true);
  try {
    await withApp(LAB, async (port) => {
      const doc = await call(port, 'GET', '/client.json', undefined, true);
      assert.equal(doc.status, 200);
      assert.equal((await doc.json()).client_id, 'https://lab.example/client.json');

      assert.equal((await call(port, 'POST', '/api/config', { mcpUrl: `${stub.base}/door/mcp`, clientId: '' }, true)).status, 200);
      const start = await call(port, 'POST', '/api/auth/start', undefined, true);
      assert.equal(start.status, 200);
      const body = await start.json();
      assert.equal(body.clientIdentity, 'cimd');
      assert.equal(body.clientId, 'https://lab.example/client.json');
      const authUrl = new URL(body.authUrl);
      assert.equal(authUrl.searchParams.get('client_id'), 'https://lab.example/client.json');
      assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://lab.example/auth/callback');
      assert.equal(stub.calls.register, 0, 'CIMD means no registration call');
    });
  } finally {
    stub.server.close();
  }
});

test('a server without CIMD still gets dynamic registration', async () => {
  const stub = await stubAs(false);
  try {
    await withApp(LAB, async (port) => {
      await call(port, 'POST', '/api/config', { mcpUrl: `${stub.base}/door/mcp`, clientId: '' }, true);
      const body = await (await call(port, 'POST', '/api/auth/start', undefined, true)).json();
      assert.equal(body.clientIdentity, 'dcr');
      assert.equal(body.clientId, 'registered-id');
      assert.equal(stub.calls.register, 1);
    });
  } finally {
    stub.server.close();
  }
});

test('the loopback build has no public document, so it registers even with a CIMD server', async () => {
  const stub = await stubAs(true);
  try {
    await withApp('', async (port) => {
      assert.equal((await call(port, 'GET', '/client.json')).status, 404);
      await call(port, 'POST', '/api/config', { mcpUrl: `${stub.base}/door/mcp`, clientId: '' });
      const body = await (await call(port, 'POST', '/api/auth/start')).json();
      assert.equal(body.clientIdentity, 'dcr');
      assert.equal(stub.calls.register, 1);
    });
  } finally {
    stub.server.close();
  }
});

test('a Client ID you type is kept and no document or registration is used', async () => {
  const stub = await stubAs(true);
  try {
    await withApp(LAB, async (port) => {
      await call(port, 'POST', '/api/config', { mcpUrl: `${stub.base}/door/mcp`, clientId: 'typed-id' }, true);
      const body = await (await call(port, 'POST', '/api/auth/start', undefined, true)).json();
      assert.equal(body.clientIdentity, 'manual');
      assert.equal(body.clientId, 'typed-id');
      assert.equal(stub.calls.register, 0);
    });
  } finally {
    stub.server.close();
  }
});

test('the setup guide link is an https address from SETUP_GUIDE_URL, or nothing', () => {
  assert.equal(setupGuideUrl({ SETUP_GUIDE_URL: 'https://docs.example/guide' }), 'https://docs.example/guide');
  assert.equal(setupGuideUrl({ SETUP_GUIDE_URL: '  https://docs.example/guide  ' }), 'https://docs.example/guide');
  assert.equal(setupGuideUrl({}), null);
  assert.equal(setupGuideUrl({ SETUP_GUIDE_URL: '' }), null);
  assert.equal(setupGuideUrl({ SETUP_GUIDE_URL: 'http://docs.example/guide' }), null);
  assert.equal(setupGuideUrl({ SETUP_GUIDE_URL: 'javascript:alert(1)' }), null);
  assert.equal(setupGuideUrl({ SETUP_GUIDE_URL: 'not a url' }), null);
});

test('/api/info carries the setup guide link only when it is set to https', async () => {
  await withApp('', async (port) => {
    assert.equal((await (await call(port, 'GET', '/api/info')).json()).setupGuideUrl, 'https://docs.example/guide');
  }, { SETUP_GUIDE_URL: 'https://docs.example/guide' });
  await withApp('', async (port) => {
    assert.equal((await (await call(port, 'GET', '/api/info')).json()).setupGuideUrl, null);
  });
  await withApp('', async (port) => {
    assert.equal((await (await call(port, 'GET', '/api/info')).json()).setupGuideUrl, null);
  }, { SETUP_GUIDE_URL: 'javascript:alert(1)' });
});

test('the page has a hidden Setup guide link that is shown only from /api/info', async () => {
  await withApp('', async (port) => {
    const html = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve(t));
      }).on('error', reject);
    });
    assert.match(html, /id="guide-link"[^>]*style="display:none;"[^>]*>Setup guide</);
    assert.match(html, /info\.setupGuideUrl/);
  });
});

test('/api/state tells the walkthrough how the client identified itself, and the document URL', async () => {
  const stub = await stubAs(true);
  try {
    await withApp(LAB, async (port) => {
      assert.equal((await (await call(port, 'GET', '/api/state', undefined, true)).json()).walk.identity, null);
      await call(port, 'POST', '/api/config', { mcpUrl: `${stub.base}/door/mcp`, clientId: '' }, true);
      await call(port, 'POST', '/api/auth/start', undefined, true);
      const state = await (await call(port, 'GET', '/api/state', undefined, true)).json();
      assert.deepEqual(state.walk, { discovered: true, serverCimd: true, identity: 'cimd', redirectUri: 'https://lab.example/auth/callback' });
      assert.equal(state.cimdDocumentUrl, 'https://lab.example/client.json');
    });
  } finally {
    stub.server.close();
  }
});

test('the refusal probes ask the door and report what it says; no document means 409', async () => {
  const stub = await stubAs(true);
  try {
    await withApp(LAB, async (port) => {
      await call(port, 'POST', '/api/config', { mcpUrl: `${stub.base}/door/mcp`, clientId: '' }, true);
      const res = await call(port, 'POST', '/api/cimd/refusals', undefined, true);
      assert.equal(res.status, 200);
      const { results } = await res.json();
      assert.deepEqual(results.map((r) => [r.id, r.status, r.refused]), [['wrong-redirect', 400, true], ['not-listed', 400, true]]);
      assert.match(results[0].message, /redirect_uri is not registered/);
      assert.ok(!/color:red/.test(results[0].message), 'style contents must not leak into the message');
      assert.match(results[1].message, /not listed/);
    });
    await withApp('', async (port) => {
      assert.equal((await call(port, 'POST', '/api/cimd/refusals')).status, 409);
    });
  } finally {
    stub.server.close();
  }
});

test('the page has the six numbered walkthrough steps and the module that fills them', async () => {
  await withApp('', async (port) => {
    const get = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
      }).on('error', reject);
    });
    const html = (await get('/')).text;
    for (let n = 1; n <= 6; n += 1) assert.match(html, new RegExp(`id="walk${n}Body"`));
    assert.equal((html.match(/class="walk-n"/g) || []).length, 6);
    assert.equal((await get('/walkthrough.js')).status, 200);
  });
});

test('a gateway that does NOT refuse is reported as not refused', async () => {
  const stub = await stubAs(true, { acceptAll: true });
  try {
    await withApp(LAB, async (port) => {
      await call(port, 'POST', '/api/config', { mcpUrl: `${stub.base}/door/mcp`, clientId: '' }, true);
      const { results } = await (await call(port, 'POST', '/api/cimd/refusals', undefined, true)).json();
      assert.deepEqual(results.map((r) => [r.status, r.refused]), [[302, false], [302, false]]);
    });
  } finally {
    stub.server.close();
  }
});
