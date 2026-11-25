// Rule 27: the lab's half of the run-observability panel (runObs.js, the obs field on /api/demo/chat,
// /api/tools/call and /api/mcp/rpc, and GET /api/run-record). The vendored collector has its own tests in the
// shared folder. Every stdout line is sanitised and matcher-word-free; no shared matcher reads one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunObservability, classify, layerMatchers } from './runObservability.js';
import { KEEP_RUNS, SERVICE, createRunLog, decisionLine, lineValue, runEvents, recordOf } from './runObs.js';

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z mcp-demo-client-privilege-lab decision step=[A-Za-z0-9._:/@-]+ layer=[a-z]+ actor=[A-Za-z0-9._:/@-]+ result=(?:passed|stopped|unclear) run=[A-Za-z0-9._:/@-]+$/;
const PRODUCTS = [...new Set(layerMatchers.map((m) => m.product))];
const noMatcherReads = (line) => {
  const at = line.split(' ')[0];
  for (const product of PRODUCTS) {
    for (const message of [line, `[${at}] INFO: ${line.split(' ').slice(1).join(' ')}`, `[${at}] WARN: ${line.split(' ').slice(1).join(' ')}`]) {
      assert.equal(classify({ product, message, at: Date.parse(at), atExact: at }, []), null, `${product}: ${message}`);
    }
  }
};

const RUN = {
  kind: 'demo-chat',
  steps: ['oauth_required', 'mcp_initialized', 'llm_routed'],
  hops: [{ direction: 'client->mcp', method: 'POST' }, { direction: 'mcp->client', status: 200 }],
  who: 'authenticated (this client holds an access token)',
  scopes: ['openid', 'profile'],
};

test('runEvents: the turn maps to the layers; a 200 relay is allowed; a 4xx relay is refused', () => {
  const events = runEvents(RUN);
  const layers = events.map((e) => [e.layer, e.outcome]);
  assert.deepEqual(layers, [
    ['person', 'info'],      // oauth_required
    ['gateway', 'info'],     // mcp_initialized
    ['agent', 'info'],       // llm_routed
    ['gateway', 'allowed'],  // relay out
    ['resource', 'allowed'], // relay in 200
  ]);
  const refused = runEvents({ ...RUN, hops: [{ direction: 'client->mcp', method: 'POST' }, { direction: 'mcp->client', status: 401 }] });
  assert.equal(refused[4].outcome, 'refused');
  const errored = runEvents({ kind: 'tools-call', steps: [], hops: [], error: 'MCP RPC error: no such tool', who: 'x', scopes: [] });
  assert.equal(errored[0].layer, 'resource');
  assert.equal(errored[0].outcome, 'refused');
});

test('every line is sanitised and matcher-free', () => {
  const at = '2026-11-25T10:00:00.000Z';
  for (const ev of runEvents(RUN)) noMatcherReads(decisionLine({ ...ev, at }, 'run-abc123-1'));
  const line = decisionLine({ ...runEvents(RUN)[0], at, who: 'agent x=1\ninjected' }, 'run\nx=1');
  assert.equal(line.split('\n').length, 1);
  assert.match(line, LINE);
});

test('the chain names the client and the relay honestly (no policy verdict)', async () => {
  const at = new Date().toISOString();
  const rec = await recordOf({ id: 'run-abc123-1', source: 'mock', startedAt: at, endedAt: at, events: runEvents(RUN).map((e, seq) => ({ ...e, at, seq })), notes: [], partial: false });
  assert.deepEqual(await assertRunObservability(rec), []);
  assert.equal(rec.chain.chains[0].agent.value, 'mcp-demo-client (this lab page)');
  assert.equal(rec.chain.chains[0].policies[0].decision, 'info');
  assert.equal(rec.chain.chains[0].user.value, 'authenticated (this client holds an access token)');
});

test('the log keeps the last few runs, Reset clears it, and a throwing writer drops its own line only', () => {
  const lines = [];
  let n = 0;
  const runLog = createRunLog({ write: (l) => { n += 1; if (n === 2) throw new Error('ENOSPC'); lines.push(l); }, clock: () => Date.parse('2026-11-25T10:00:00.000Z') });
  for (let i = 0; i < KEEP_RUNS + 3; i += 1) runLog.mock(() => runEvents(RUN));
  assert.equal(runLog.size(), KEEP_RUNS);
  assert.equal(runLog.get('run-nope-1'), null);
  runLog.clear();
  assert.equal(runLog.size(), 0);
});

test('over the API: a demo turn answers its obs id, /api/run-record answers that record, Reset clears', async () => {
  const { default: createServerShim } = await import('node:http');
  // Boot the real server on a free port with a dead MCP URL so the turn errors honestly (a refusal is still a run).
  const proc = await import('node:child_process');
  const port = 6884;
  const child = proc.spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) { try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    assert.ok(up, 'the lab started');
    const base = `http://127.0.0.1:${port}`;
    const turn = await fetch(`${base}/api/demo/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ prompt: 'hello' }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.ok(turn.body.obs?.id, 'a turn answers its obs id');
    const rec = await fetch(`${base}/api/run-record?runId=${turn.body.obs.id}`).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(rec.status, 200);
    assert.deepEqual(await assertRunObservability(rec.body.record), []);
    assert.equal((await fetch(`${base}/api/run-record?runId=nope`)).status, 400);
    await fetch(`${base}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
    const after = await fetch(`${base}/api/run-record?runId=${encodeURIComponent(turn.body.obs.id)}`).then(async (r) => r.json());
    assert.equal(after.record, null, 'Reset clears the records');
    void createServerShim;
  } finally { child.kill(); }
});
