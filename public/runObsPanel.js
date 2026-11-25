// Rule 27 panel for this plain-JS page: a DOM port of the shared RunObservability panel
// (AI-DEMO-Standalone shared/run-observability/RunObservability.jsx). It builds the same markup, classes and
// data-testids as the React panel, so the vendored run-observability/run-observability.css (byte-for-byte, pinned)
// styles it. Everything is DOM text (createElement, textContent; never innerHTML), the same as jsonPane.js.
//
//   mountPanel(container) -> { set(head), loading(), record() }
//   set({ runId })        asks GET /api/run-record?runId=... and repaints from the record.
//   set(null)             the empty state; set({ none }) or set({ bad: true }) the lab's other states.
// Nothing is re-read on a timer and there is no re-read button: this lab reads no logs, so a re-read could find
// nothing new. A new run (a new runId) starts a clean panel: open rows and the layer filter belong to the run
// they were set on, exactly like the React panel's key.
import { showJson } from './jsonPane.js';

const LAYERS = [
  { id: 'person', label: 'Person', what: 'who signed in' },
  { id: 'agent', label: 'Agent', what: 'who acted for them' },
  { id: 'authorize', label: 'Authorize', what: 'PingOne Authorize decisions' },
  { id: 'privilege', label: 'Privilege', what: 'policy, AI Guard and approvals' },
  { id: 'gateway', label: 'Agent gateway', what: 'allowed, refused or blocked' },
  { id: 'resource', label: 'Resource server', what: 'the tool call served or refused' },
];
const LABEL = Object.fromEntries(LAYERS.map((l) => [l.id, l.label]));
const COVERAGE_LABEL = { logged: 'Logged', simulated: 'Simulated', response: 'Response', 'not-logged': 'Not logged', unreachable: 'Unreachable' };
const OUTCOME_LABEL = { allowed: 'ALLOWED', refused: 'REFUSED', blocked: 'BLOCKED', info: 'INFO' };
const GLYPH = { allowed: '✓', refused: '✕', blocked: '■', info: 'i' };
const ORIGIN_LABEL = { logged: 'logged', simulated: 'simulated', response: 'response', 'not-logged': 'not logged' };
const ORIGIN_NOTE = {
  logged: 'A line read, read-only, from the product’s own log, shown with that line’s own timestamp. Ids, tokens and addresses are masked.',
  simulated: 'Computed by the lab’s mock. It was not read from any product log.',
  response: 'A decision the lab already holds as the response of an API call. It is real, but it was not read from a product log, so it is not marked logged.',
  'not-logged': 'No line was found for this layer in the run’s window. The product may not log this event; nothing is claimed here.',
};
const HOT = ['outcome', 'origin', 'basis'];
const POLICY_NAME = { privilege: 'Privilege', p1az: 'P1AZ' };
const LEGEND = [
  ['logged', 'a line read, read-only, from the product’s own log, with its own timestamp'],
  ['response', 'a decision the lab holds as an API response; real, but not read from a log'],
  ['simulated', 'computed by the lab’s mock'],
  ['not-logged', 'no line was found; nothing is claimed'],
];
const TITLE = 'What each layer logged for this run';

const txt = (v) => {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return '[unreadable]'; } }
  return String(v);
};
const timeOf = (r) => (r.at ? r.atExact || r.at : 'no timestamp');
const byTime = (a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : a.at ? -1 : b.at ? 1 : 0);
const normRows = (list) => {
  const used = new Set();
  return (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object').map((r, i) => {
    let id = txt(r.id) || `row-${i}`;
    if (used.has(id)) id = `${id}-${i}`;
    used.add(id);
    return { ...r, id, layer: txt(r.layer), product: txt(r.product), message: txt(r.message), outcome: txt(r.outcome), origin: txt(r.origin), at: r.at ? txt(r.at) : null, atExact: r.atExact ? txt(r.atExact) : undefined };
  });
};

export function headOf(d) {
  if (d && typeof d === 'object' && !Array.isArray(d) && 'obs' in d) {
    if (d.obs && typeof d.obs === 'object' && typeof d.obs.id === 'string' && d.obs.id) return { runId: d.obs.id };
    if (d.obs === null) return { none: typeof d.obsNote === 'string' && d.obsNote ? d.obsNote : 'This request began no run, so nothing was recorded.' };
  }
  return { bad: true };
}

export const LOG_STREAMS = [
  { product: 'MCP demo client LAB (this lab’s container)', lives: 'its stdout. Each decision of a run is one line: the time, a step, the layer, the actor, a result and a run id. A line never holds a token, a person’s name or an address', streams: 'nowhere today: the family log collector’s source list does not name this container, so it would need an entry first' },
];
const NOTE = "Rows are this turn's relay hops and its own step list, in turn order — one row per hop, in the layer that spoke. The OAuth identity step is the Person layer (whether this client holds an access token, never the token itself); the LLM router is the Agent layer; the relay to the configured gateway URL is the Privilege layer (the lab relays and reports, it computes no policy verdict — the gateway computes it); the MCP server's answer is the Resource server layer. Every row was computed by this lab from the turn it recorded, never read from a product log.";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  return node;
}

function note(id, role, text) {
  const p = el('p', { class: 'ro-muted', 'data-testid': id });
  if (role) p.setAttribute('role', role);
  p.textContent = text;
  return p;
}

function Detail(row) {
  const { id, ...shown } = row;
  const box = el('div', { class: 'ro-detail', 'data-testid': `ro-detail-${row.id}` });
  box.appendChild(el('p', { class: 'ro-muted', text: ORIGIN_NOTE[row.origin] || '' }));
  if (row.basis === 'unverified-shape') {
    const p = el('p', { class: 'ro-muted', 'data-testid': `ro-unverified-${row.id}` });
    p.appendChild(el('strong', { text: 'UNVERIFIED line shape. ' }));
    p.appendChild(document.createTextNode('This kind of line has not been measured against a real product log, so read the outcome with care.'));
    box.appendChild(p);
  }
  if (row.matchedBy === 'window') box.appendChild(el('p', { class: 'ro-muted', text: 'Matched by the run’s time window only, not by an id from the run.' }));
  const jsonBox = el('div');
  box.appendChild(jsonBox);
  queueMicrotask(() => showJson(jsonBox, shown, { label: 'Log row', testId: `ro-row-${row.id}`, hot: HOT, toggle: false }));
  return box;
}

function Chain(chain, reasons) {
  const list = Array.isArray(chain?.chains) ? chain.chains : [];
  const section = el('section', { class: 'ro-chain', 'data-testid': 'ro-chain', 'aria-label': 'The chain for this run' });
  section.appendChild(el('h3', { text: 'The chain for this run' }));
  if (list.length === 0) { section.appendChild(note('ro-chain-none', null, 'This lab does not record the chain for this run.')); return section; }
  section.appendChild(el('p', { class: 'ro-muted', text: 'A step is linked to the next only when both rows carry the same agent identifier. A name never links two steps.' }));
  list.forEach((c, i) => {
    const policies = Array.isArray(c.policies) ? c.policies : [];
    const links = c.links || {};
    const ol = el('ol', { class: 'ro-chain-steps' });
    const step = (name, label, ...children) => {
      const li = el('li', { class: 'ro-chain-step', 'data-testid': `ro-chain-step-${i}-${name}` });
      li.appendChild(el('span', { class: 'ro-chain-label', text: label }));
      for (const c2 of children) li.appendChild(c2);
      return li;
    };
    const missing = (r) => el('span', { class: 'ro-chain-missing', text: `not logged${r ? `: ${txt(r)}` : ''}` });
    const chip = (origin) => el('span', { class: 'ro-chip', 'data-origin': origin, text: ORIGIN_LABEL[origin] || txt(origin) });
    ol.appendChild(step('user', 'User',
      c.user ? el('span', { class: 'ro-chain-value', text: txt(c.user.value) }) : missing(reasons?.person),
      c.user ? chip(c.user.origin) : null));
    ol.appendChild(el('li', { class: 'ro-chain-link', 'data-testid': `ro-chain-link-${i}-userAgent`, 'data-linked': links.userAgent ? 'true' : 'false', text: links.userAgent ? 'linked on the same agent id' : 'not correlated in this run' }));
    ol.appendChild(step('agent', 'Agent',
      c.agent ? el('span', { class: 'ro-chain-value', text: txt(c.agent.value) }) : missing(reasons?.agent),
      c.agent ? chip(c.agent.origin) : null));
    ol.appendChild(el('li', { class: 'ro-chain-link', 'data-testid': `ro-chain-link-${i}-agentScopes`, 'data-linked': links.agentScopes ? 'true' : 'false', text: links.agentScopes ? 'linked on the same agent id' : 'not correlated in this run' }));
    ol.appendChild(step('scopes', 'Scopes',
      c.scopes ? el('span', { class: 'ro-chain-value', text: c.scopes.values.map((v) => txt(v)).join(', ') }) : (c.noScopeClaim ? el('span', { class: 'ro-chain-missing', text: 'no scope claim in this run' }) : missing(reasons?.agent)),
      c.scopes ? chip(c.scopes.origin) : null));
    ol.appendChild(el('li', { class: 'ro-chain-link', 'data-testid': `ro-chain-link-${i}-scopesPolicy`, 'data-linked': links.scopesPolicy ? 'true' : 'false', text: links.scopesPolicy ? 'linked on the same agent id' : 'not correlated in this run' }));
    const polLi = step('policies', 'Policies');
    if (policies.length === 0) polLi.appendChild(missing(reasons?.privilege || reasons?.authorize));
    else {
      const ul = el('ul', { class: 'ro-chain-policies' });
      policies.forEach((p, k) => {
        ul.appendChild(el('li', { class: 'ro-chain-policy', 'data-testid': `ro-chain-policy-${i}-${k}`, 'data-outcome': p.outcome, 'data-origin': p.origin },
          el('span', { class: 'ro-chain-label', text: POLICY_NAME[p.product] || txt(p.product) || 'Policy' }),
          el('span', { class: 'ro-chain-value', text: txt(p.decision) }),
          el('span', { class: 'ro-chip', 'data-outcome': p.outcome, text: OUTCOME_LABEL[p.outcome] || txt(p.outcome) }),
          p.id ? el('span', { class: 'ro-chain-value', text: `id ${txt(p.id)}` }) : el('span', { class: 'ro-chain-missing', text: 'policy id not logged' }),
          el('span', { class: 'ro-chip', 'data-origin': p.origin, text: ORIGIN_LABEL[p.origin] || txt(p.origin) })));
      });
      polLi.appendChild(ul);
    }
    ol.appendChild(polLi);
    section.appendChild(el('article', { class: 'ro-chain-run', 'data-testid': `ro-chain-run-${i}`, 'aria-label': c.agent ? `Chain for agent ${txt(c.agent.value)}` : 'Chain for rows with no agent id' }, ol));
  });
  return section;
}

function Legend() {
  const ul = el('ul', { class: 'ro-legend', 'data-testid': 'ro-legend', 'aria-label': 'What the origin tags mean' });
  for (const [o, t] of LEGEND) ul.appendChild(el('li', {}, el('span', { class: 'ro-chip', 'data-origin': o, text: ORIGIN_LABEL[o] }), ` ${t}`));
  return ul;
}

function Streams(streams) {
  const list = Array.isArray(streams) ? streams : [];
  const det = el('details', { class: 'ro-streams', 'data-testid': 'ro-streams' });
  det.appendChild(el('summary', { text: 'Where these logs live and where they stream' }));
  if (list.length === 0) det.appendChild(note('ro-streams-empty', null, 'This lab has not said where its logs live or where they stream.'));
  else {
    const ul = el('ul');
    for (const s of list) ul.appendChild(el('li', {}, el('strong', { text: txt(s?.product) }), `: lives in ${txt(s?.lives)}; streams to ${txt(s?.streams)}.`));
    det.appendChild(ul);
  }
  return det;
}

export function mountPanel(container) {
  let runId = null;
  let record = null;
  let layer = null;
  let openRows = new Set();
  let currentKey = null;

  const root = el('section', { class: 'ro', 'data-testid': 'run-observability', 'aria-label': TITLE });
  container.replaceChildren(root);

  function paint() {
    const key = runId;
    root.replaceChildren(el('h2', { text: TITLE }), el('p', { class: 'ro-lead', text: 'Excerpt of this run’s logs. Ids, tokens and addresses are masked.' }),
      el('p', { class: 'ro-muted', 'data-testid': 'ro-basis', text: 'Simulated: the lab’s mock computed these rows. None of them was read from a product log.' }));
    if (!record) { root.appendChild(note('ro-empty', null, 'Run the demo: the log lines each layer wrote for the run appear here, in time order.')); return; }
    if (record.error) {
      const div = el('div', { class: 'ro-error', role: 'alert', 'data-testid': 'ro-error' });
      div.appendChild(el('strong', { text: 'The run’s logs could not be collected. ' }));
      div.appendChild(document.createTextNode(txt(record.message) || txt(record.error)));
      root.appendChild(div);
      return;
    }
    const rows = normRows(record.rows).sort(byTime);
    const shown = layer ? rows.filter((r) => r.layer === layer) : rows;
    const counted = rows.filter((r) => r.origin !== 'not-logged');
    const unverified = counted.filter((r) => r.basis === 'unverified-shape').length;
    const n = (o) => counted.filter((r) => r.basis !== 'unverified-shape' && r.outcome === o).length;
    const info = counted.filter((r) => r.basis === 'unverified-shape' || r.outcome === 'info').length;
    root.appendChild(el('p', { class: 'ro-summary', 'data-testid': 'ro-summary', text: counted.length === 0
      ? 'No log lines in this excerpt.'
      : `${n('allowed')} allowed, ${n('refused')} refused, ${n('blocked')} blocked, ${info} for information (information is not a pass${unverified ? `; ${unverified} UNVERIFIED-shape ${unverified === 1 ? 'row is' : 'rows are'} counted here whatever outcome ${unverified === 1 ? 'it carries' : 'they carry'}` : ''}). Window ${txt(record.window?.from)} to ${txt(record.window?.to)}.` }));
    root.appendChild(Chain(record.chain, record.reasons));
    root.appendChild(Legend());
    const lanes = el('ol', { class: 'ro-lanes', 'data-testid': 'ro-lanes', 'aria-label': 'Layers' });
    for (const l of LAYERS) {
      const own = rows.filter((r) => r.layer === l.id && r.origin !== 'not-logged');
      const coverage = record.coverage?.[l.id];
      const reason = record.reasons?.[l.id];
      const partial = Boolean(record.partial?.[l.id]);
      const li = el('li', { class: 'ro-lane', 'data-testid': `ro-lane-${l.id}`, 'data-layer': l.id, 'data-coverage': coverage || 'unknown' });
      li.appendChild(el('button', { type: 'button', class: 'ro-lane-name', 'aria-pressed': layer === l.id ? 'true' : 'false', title: `Show only ${l.label} rows`, onclick: () => { layer = layer === l.id ? null : l.id; paint(); } }, l.label));
      li.appendChild(el('span', { class: 'ro-chip', 'data-coverage': coverage || 'unknown', 'data-partial': partial && coverage === 'not-logged' ? 'true' : undefined, 'data-testid': `ro-coverage-${l.id}`, text: partial && coverage === 'not-logged' ? 'Not found (partial search)' : COVERAGE_LABEL[coverage] || 'Not reported' }));
      li.appendChild(el('span', { class: 'ro-what', text: l.what }));
      const marks = el('span', { class: 'ro-marks', 'aria-label': `${own.length} events` });
      for (const r of own) marks.appendChild(el('span', { class: 'ro-mark', 'data-outcome': r.outcome, title: `${timeOf(r)}: ${r.outcome}: ${r.message}`, role: 'img', 'aria-label': `${r.outcome} at ${timeOf(r)}`, text: GLYPH[r.outcome] }));
      li.appendChild(marks);
      if (reason) li.appendChild(el('span', { class: 'ro-reason', 'data-testid': `ro-reason-${l.id}`, text: txt(reason) }));
      lanes.appendChild(li);
    }
    root.appendChild(lanes);
    if (record.truncated) root.appendChild(note('ro-truncated', null, 'This excerpt was cut at the row or line cap; narrow the run’s window to see the rest.'));
    if (layer) {
      const p = el('p', { class: 'ro-muted', 'data-testid': 'ro-filter-note', text: `Showing ${shown.length} of ${rows.length} rows (${LABEL[layer]} only). ` });
      p.appendChild(el('button', { type: 'button', class: 'ro-link', onclick: () => { layer = null; paint(); } }, 'Show all layers'));
      root.appendChild(p);
    }
    if (shown.length === 0) root.appendChild(note('ro-no-rows', null, 'No rows to show. The layers above say why: a layer that is not logged or unreachable has no lines.'));
    else {
      const table = el('table', { class: 'ro-table', 'data-testid': 'ro-table' });
      const thead = el('thead');
      const hr = el('tr');
      for (const h of ['Time', 'Layer', 'Product', 'Outcome', 'Message', 'Origin']) hr.appendChild(el('th', { scope: 'col', text: h }));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const r of shown) {
        const isOpen = openRows.has(r.id);
        const tr = el('tr', { class: 'ro-row', 'data-testid': `ro-row-${r.id}-line`, 'data-layer': r.layer, 'data-outcome': r.outcome, 'data-origin': r.origin });
        const timeTd = el('td', { class: 'ro-time' });
        timeTd.appendChild(el('button', { type: 'button', class: 'ro-expand', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { const s = new Set(openRows); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); openRows = s; paint(); } },
          el('span', { 'aria-hidden': 'true', text: isOpen ? '▾' : '▸' }), ` ${timeOf(r)}`));
        tr.appendChild(timeTd);
        tr.appendChild(el('td', { text: LABEL[r.layer] || r.layer }));
        tr.appendChild(el('td', { text: r.product }));
        const outTd = el('td', {});
        outTd.appendChild(el('span', { class: 'ro-chip', 'data-outcome': r.outcome, text: OUTCOME_LABEL[r.outcome] || r.outcome }));
        tr.appendChild(outTd);
        tr.appendChild(el('td', { class: 'ro-msg', text: r.message }));
        const originTd = el('td', {});
        originTd.appendChild(el('span', { class: 'ro-chip', 'data-origin': r.origin, text: ORIGIN_LABEL[r.origin] || r.origin }));
        if (r.basis === 'unverified-shape') originTd.appendChild(el('span', { class: 'ro-tag', text: 'UNVERIFIED shape' }));
        if (r.matchedBy === 'window') originTd.appendChild(el('span', { class: 'ro-tag', text: 'time window' }));
        if (r.multiline) originTd.appendChild(el('span', { class: 'ro-tag', text: 'multi-line entry' }));
        tr.appendChild(originTd);
        tbody.appendChild(tr);
        if (isOpen) {
          const xr = el('tr', { class: 'ro-xrow' });
          const td = el('td', { colspan: '6' });
          td.appendChild(Detail(r));
          xr.appendChild(td);
          tbody.appendChild(xr);
        }
      }
      table.appendChild(tbody);
      root.appendChild(table);
    }
    root.appendChild(Streams(LOG_STREAMS));
    const p = el('p', { class: 'ro-muted', 'data-testid': 'ro-lab-note', text: NOTE });
    root.appendChild(p);
  }

  async function ask() {
    if (!runId) return;
    const key = runId;
    let next;
    try {
      const r = await fetch(`/api/run-record?runId=${encodeURIComponent(runId)}`);
      let data = null;
      try { data = await r.json(); } catch { data = null; }
      if (key !== currentKey) return; // a newer turn took over
      next = !r.ok
        ? { problem: data && typeof data.detail === 'string' && data.detail ? data.detail : `The lab answered ${r.status} when asked for this run's record.` }
        : data && typeof data === 'object' && 'record' in data
          ? (data.record === null ? { empty: typeof data.message === 'string' && data.message ? data.message : 'There is no record for this run.' }
            : data.record && typeof data.record === 'object' ? { record: data.record } : { problem: 'The lab’s answer was not a run record.' })
          : { problem: 'The lab’s answer was not a run record.' };
    } catch (e) {
      if (key !== currentKey) return;
      next = { problem: `Could not reach the lab (${String(e && e.message ? e.message : e).slice(0, 120)}).` };
    }
    if (next.record) { record = next.record; paint(); }
    else if (next.empty) { root.replaceChildren(note('ro-gone', null, next.empty)); }
    else { const div = note('ro-problem', 'alert', next.problem || 'The record could not be shown.'); root.replaceChildren(div); }
  }

  return {
    set(head) {
      if (head && head.runId) {
        runId = head.runId; currentKey = runId; record = null; layer = null; openRows = new Set();
        paint();
        return ask();
      }
      runId = null; currentKey = null; record = null;
      if (head && head.none) root.replaceChildren(note('ro-no-run', null, head.none));
      else if (head) root.replaceChildren(note('ro-bad', 'alert', 'The lab’s answer did not say which run it was, so there is no record to show (and no older one is shown in its place).'));
      else root.replaceChildren(note('ro-empty', null, 'Nothing has run yet. Run a turn and its record appears here.'));
    },
    loading() {
      root.replaceChildren(note('ro-loading', null, 'Collecting this run’s logs…'));
    },
  };
}
