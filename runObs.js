// Rule 27: this lab's side of the shared run-observability panel. The vendored collector (runObservability.js) is
// never edited here; this is the one file that maps this lab's decisions onto the six layers. This lab reads no
// logs, so it vendors the core only: no readers file and no reader setting anywhere.
//
// What a run is here. ONE visitor action that talks to the gateway: a demo chat turn (POST /api/demo/chat — the
// page's guided flow: OAuth check, MCP session, tools/list, the LLM router) or one tool call (POST /api/tools/call
// → tools/call) or one raw RPC (POST /api/mcp/rpc). The relay events (client->mcp / mcp->client) and the turn's
// steps are the run's hops, recorded when the turn settles.
//
// Which layer holds what. This client is the browser's agent; the MCP server behind the gateway URL is the
// resource. The Person layer is this lab's OAuth identity state (authenticated or not — information, from the
// turn's own steps). The Agent layer is the LLM router hop. The Privilege layer is the gateway relay itself
// (information: the lab relays to the URL the operator configured; it computes no policy verdict). The Resource
// server layer is the MCP server's answer (tools/list, tools/call) — allowed or refused from the HTTP/RPC result.
//
// Stdout line: `<iso> mcp-demo-client-privilege-lab decision step=<step> layer=<layer> actor=<who> result=... run=<id>`,
// one per decision row. Every value passes the masker and the line sanitiser; no shared matcher reads one.
import crypto from 'node:crypto';
import { createMasker, createRunObservability, LAYERS } from './runObservability.js';

export const SERVICE = 'mcp-demo-client-privilege-lab';
export const KEEP_RUNS = 12;
export const NO_RUN_BEGAN = 'This request began no run, so nothing was recorded.';
export const RECORDER_DOWN = 'The lab could not keep a record of this run (the server log says why).';
export const NO_LONGER_KEPT = 'That run is no longer kept: the lab keeps the last few runs, and Reset clears them.';

export const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
const MATCHER_WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served|unauthori[sz]ed|insufficient/gi;
const { mask } = createMasker();
const field = (v) => lineValue(mask(String(v ?? ''))).replace(MATCHER_WORDS, '_');
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

export function reportFailure(where, err) {
  process.stderr.write(`[${SERVICE}] run observability: ${lineValue(where, 40)} ${lineValue(err?.code || err?.name || 'error', 40)} (the error's text is not logged)\n`);
}
export function safely(where, fn) {
  try { return fn(); } catch (err) { reportFailure(where, err); return undefined; }
}

// The layer map. The gateway relay is Privilege (information — the lab computes no verdict on the relay);
// the MCP server's answer is the Resource server layer; the LLM router is the Agent layer; the OAuth state
// note is the Person layer (information).
const STEP_LAYER = {
  oauth_required: ['person', 'oauth-check'],
  missing_client_id: ['person', 'oauth-check'],
  mcp_initialized: ['gateway', 'session'],
  llm_routed: ['agent', 'llm-router'],
  'oauth-check': ['person', 'oauth-check'],
  'session': ['gateway', 'session'],
  'llm-router': ['agent', 'llm-router'],
};
const layerOfStep = (step) => STEP_LAYER[String(step)]?.[0] ?? 'resource';
const stepOfStep = (step) => STEP_LAYER[String(step)]?.[1] ?? lineValue(String(step ?? 'step'), 40);

// The chain: user = the OAuth identity this lab holds (never the token), agent = this client's id.
function chainOf(run) {
  const out = {};
  if (run.who) out.user = run.who;
  out.agent = 'mcp-demo-client (this lab page)';
  out.scopes = Array.isArray(run.scopes) ? run.scopes.slice(0, 20) : [];
  out.policy = { product: 'the gateway relay (no policy verdict computed)', decision: 'info' };
  return out;
}

// A run { kind, steps, ok, error, who, scopes, hops:[{direction,status,method}] } -> decision events.
export function runEvents(run) {
  if (!run) return [];
  const chain = chainOf(run);
  const evs = [];
  for (const step of run.steps || []) {
    const layer = layerOfStep(step);
    evs.push({
      layer, product: PRODUCT[layer], step: stepOfStep(step), outcome: 'info',
      who: chain.agent,
      message: `${step}: the turn's own step list, in turn order.`,
      detail: { step: String(step), runKind: run.kind, ...chain },
    });
  }
  for (const h of run.hops || []) {
    const layer = h.direction === 'client->mcp' ? 'gateway' : 'resource';
    const refused = h.status !== undefined && h.status >= 400;
    evs.push({
      layer, product: PRODUCT[layer], step: h.direction === 'client->mcp' ? 'relay-out' : 'relay-in',
      outcome: refused ? 'refused' : 'allowed',
      who: chain.agent,
      message: `${h.direction}${h.method ? ` ${h.method}` : ''}${h.status !== undefined ? ` -> ${h.status}` : ''}: the gateway relay.`,
      detail: { direction: h.direction, status: h.status ?? null, method: h.method ?? null, ...chain },
    });
  }
  if (run.error) {
    evs.push({ layer: 'resource', product: PRODUCT.resource, step: 'run-error', outcome: 'refused', who: chain.agent, message: lineValue(run.error, 200), detail: { ...chain, kind: run.kind } });
  } else if (evs.length === 0) {
    evs.push({ layer: 'gateway', product: PRODUCT.gateway, step: 'turn', outcome: 'info', who: chain.agent, message: 'The turn recorded no relay hop.', detail: { ...chain, kind: run.kind } });
  }
  return evs;
}

const PRODUCT = {
  person: 'lab OAuth identity state', agent: 'lab LLM router', privilege: 'lab gateway relay',
  authorize: 'no Authorize hop (the gateway computes the verdict)', gateway: 'lab gateway relay', resource: 'the MCP server behind the gateway',
};

// ---- Stdout lines ------------------------------------------------------------------------------------------------------------------------------------
export function decisionLine(ev, runId) {
  return `${ev.at} ${SERVICE} decision step=${lineValue(ev.step)} layer=${lineValue(ev.layer, 12)} actor=${field(ev.who)} result=${RESULT[ev.outcome] ?? 'unclear'} run=${lineValue(runId)}`;
}

// ---- The run log: bounded. Mock and Real turns are recorded the same way (a Real turn's rows are the same shape). ----
export function createRunLog({ write = (line) => process.stdout.write(`${line}\n`), clock = Date.now } = {}) {
  const part = crypto.randomBytes(3).toString('hex');
  let made = 0;
  const kept = [];
  const prune = () => { while (kept.length > KEEP_RUNS) kept.shift(); };
  const line = (ev, id) => safely('line', () => write(decisionLine(ev, id)));

  return {
    mock(build, { source = 'mock' } = {}) {
      return safely('run', () => {
        const events = build();
        const at = new Date(clock()).toISOString();
        const run = { id: `run-${part}-${++made}`, source, startedAt: at, endedAt: at, events: events.map((e, seq) => ({ ...e, at, seq })), notes: [], partial: false };
        kept.push(run); prune();
        for (const ev of run.events) line(ev, run.id);
        return run.id;
      }) ?? null;
    },
    get(id) { return kept.find((r) => r.id === id) || null; },
    clear() { kept.length = 0; },
    size() { return kept.length; },
  };
}
export const runField = (id) => (id ? { obs: { id } } : { obs: null, obsNote: RECORDER_DOWN });
export const NO_RUN = Object.freeze({ obs: null, obsNote: NO_RUN_BEGAN });

// ---- The record ----------------------------------------------------------------------------------------------------------------------------------------
const WHY = {
  person: 'The Person layer holds the turn\'s OAuth identity step: whether this client holds an access token (never the token itself), read from the turn\'s own step list.',
  agent: 'The Agent layer holds the LLM router hop: which tool the router suggested, read from the turn\'s step list.',
  authorize: 'This lab makes no Authorize hop: the gateway behind the configured URL computes the verdict, and the lab sees only the relay.',
  privilege: 'The Privilege layer holds the relay hops to the configured gateway URL: the lab relays and reports, it computes no policy verdict.',
  gateway: 'No relay hop was recorded for this turn.',
  resource: 'The Resource server layer holds the MCP server\'s answer (tools/list, tools/call): allowed or refused from the HTTP/RPC result.',
};

export async function recordOf(run, { clock = Date.now } = {}) {
  return createRunObservability({ clock }).collectRun({
    runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, source: 'mock',
    layers: LAYERS.map((layer) => {
      const own = run.events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: e.product, outcome: e.outcome, message: e.message, detail: { ...e.detail, eventSeq: e.seq } }));
      return { layer, products: [], reason: WHY[layer], simulated: own };
    }),
  });
}
