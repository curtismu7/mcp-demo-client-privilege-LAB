// Rule 24 JSON pane for this plain-JS page: a DOM port of the shared JsonPane (AI-DEMO-Standalone shared/json/JsonPane.jsx).
// It builds the same markup and classes as JsonPane, so the vendored json/JsonPane.css (byte-for-byte, sha256 pin) styles it.
//   Form = a label and a read-only value per field, nested objects as indented groups, scopes / audiences as chips, timestamps with
//          their date, true / false as chips.
//   JSON = the exact JSON text, coloured by what each part is; tokens in three segments; important and error keys stood out.
// One Form | JSON choice for every pane on the page (kept in localStorage). Everything is DOM text (createElement, textContent,
// text nodes; never innerHTML) and passes `visible()`, so control and bidi characters show as escapes.
// FULL VIEW: the pane never scrolls; it grows to its content and long lines wrap (JsonPane.css enforces it).
import { visible } from './safeText.js';

function readPref(key, valid, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return valid(v) ? v : fallback;
  } catch { return fallback; }
}
function writePref(key, v) {
  try { window.localStorage.setItem(key, v); } catch { /* private mode: choice lives for the session */ }
}

const KEY = 'aag.json.view';
let view = readPref(KEY, (v) => v === 'form' || v === 'raw', 'form');
const mounted = new Map(); // container -> { value, opts }: every pane on the page, repainted when the view changes
export const jsonView = () => view;
export function setJsonView(v) {
  if (v !== 'form' && v !== 'raw') return;
  view = v;
  writePref(KEY, v);
  for (const container of [...mounted.keys()]) {
    if (container.isConnected === false) mounted.delete(container);
    else paint(container);
  }
}

const JWT = /^eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*$/;
const BEARER = /^(Bearer|DPoP) (eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*)$/;
const URLISH = /^https?:\/\/\S+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;
const TIME_KEYS = new Set(['iat', 'exp', 'nbf', 'auth_time']);
const HOT = new Set(['sub', 'act', 'may_act', 'aud', 'scope', 'client_id', 'azp', 'iss', 'cnf', 'grant_type', 'subject_token', 'actor_token', 'access_token', 'authorization']);
const ALERT = new Set(['error', 'error_description', 'detail_code', 'outcome', 'decision', 'verdict', 'reason', 'note']);
const SPLIT = new Set(['scope', 'aud', 'scp']);

export function parseJsonText(s) {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return undefined;
  try { const v = JSON.parse(t); return v !== null && typeof v === 'object' ? v : undefined; } catch { return undefined; }
}

const MAX_PANE_CHARS = 150000; // above this a pane is plain text
const MAX_FORM_DEPTH = 60; // deeper than this the Form view shows the rest as text
const prim = (v) => v === null || typeof v !== 'object';
const nestedValue = (v) => !prim(v) && !(Array.isArray(v) && v.every(prim));
const date = (n) => (Number.isFinite(n) && n > 1e9 && n < 1e11 ? `${new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC` : null);

export function kindOf(v, key = '') {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return TIME_KEYS.has(key) ? 'time' : 'number';
  if (typeof v !== 'string') return 'string';
  if (JWT.test(v) || BEARER.test(v)) return 'token';
  if (URLISH.test(v)) return 'url';
  if (UUID.test(v)) return 'id';
  if (ISO.test(v)) return 'time';
  return 'string';
}

// h(tag, attrs, ...children): an element with attributes set as text and children appended as nodes or text nodes.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'className') el.className = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return el;
}

// A token in three colours: header . payload . signature (a Bearer / DPoP prefix stays plain).
function jwt(text) {
  const m = BEARER.exec(text);
  const raw = m ? m[2] : text;
  const parts = raw.split('.');
  return h('span', { className: 'jwt' },
    m && h('span', { className: 'jtok jtok--plain' }, `${m[1]} `),
    parts.map((p, i) => h('span', null, i > 0 && h('span', { className: 'jtok jtok--punct' }, '.'), h('span', { className: `jtok jtok--jwt${Math.min(i, 2) + 1}` }, visible(p)))));
}

// ---- JSON view: the exact text, coloured. A tiny scanner (no eval, no HTML); anything unparsable becomes one plain token.
function scan(text) {
  const out = [];
  let i = 0;
  const nextMeaning = (from) => { let j = from; while (j < text.length && /\s/.test(text[j])) j += 1; return text[j]; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1; let esc = false;
      while (j < text.length) { if (esc) esc = false; else if (text[j] === '\\') esc = true; else if (text[j] === '"') break; j += 1; }
      out.push({ kind: nextMeaning(j + 1) === ':' ? 'key' : 'string', text: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i; while (j < text.length && /\s/.test(text[j])) j += 1;
      out.push({ kind: 'plain', text: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i; while (j < text.length && /[-0-9.eE+]/.test(text[j])) j += 1;
      out.push({ kind: 'number', text: text.slice(i, j) });
      i = j;
      continue;
    }
    const word = text.slice(i).match(/^(true|false|null)/);
    if (word) { out.push({ kind: word[1] === 'null' ? 'null' : 'bool', text: word[1] }); i += word[1].length; continue; }
    if (/[{}[\],:]/.test(ch)) { out.push({ kind: 'punct', text: ch }); i += 1; continue; }
    let j = i; while (j < text.length && !/["{}[\],:]/.test(text[j])) j += 1;
    out.push({ kind: 'plain', text: text.slice(i, j) });
    i = j;
  }
  return out;
}

function rawJson(text, hot) {
  let key = '';
  return scan(text).map((t) => {
    if (t.kind === 'key') {
      key = t.text.slice(1, -1);
      return h('span', { className: `jtok jtok--${hot.has(key) ? 'hot' : ALERT.has(key) ? 'alert' : 'key'}` }, visible(t.text));
    }
    if (t.kind === 'string') {
      let inner = t.text.slice(1, -1);
      try { inner = JSON.parse(t.text); } catch { /* keep the escaped text */ }
      const k = kindOf(inner, key);
      if (k === 'token') return h('span', { className: 'jtok jtok--plain' }, '"', jwt(inner), '"');
      return h('span', { className: `jtok jtok--${k === 'string' && ALERT.has(key) ? 'alert' : k === 'string' && hot.has(key) ? 'hot' : k}` }, visible(t.text));
    }
    if (t.kind === 'number') return h('span', { className: `jtok jtok--${TIME_KEYS.has(key) ? 'time' : 'number'}` }, t.text);
    return h('span', { className: `jtok jtok--${t.kind}` }, visible(t.text));
  });
}

// ---- Form view: a form.
function valueEl(v, k, hot) {
  const kind = kindOf(v, k);
  if (kind === 'null') return h('span', { className: 'jform__v jform__v--null' }, 'none');
  if (kind === 'bool') return h('span', { className: 'jform__chip', 'data-on': v ? 'true' : 'false' }, v ? 'true' : 'false');
  if (kind === 'token') return h('span', { className: 'jform__v jform__v--token' }, jwt(v));
  if (typeof v === 'string' && SPLIT.has(k) && /\s/.test(v.trim())) return chipList(v.trim().split(/\s+/), k, hot);
  if (kind === 'time') { const d = typeof v === 'number' ? date(v) : null; return h('span', { className: 'jform__v jform__v--time' }, visible(String(v)), d && h('span', { className: 'jform__sub' }, ` ${d}`)); }
  // A string that would read as another type keeps its quotes, so the Form view never hides string-versus-object.
  const typed = typeof v === 'string' && /^(?:\{[\s\S]*\}|\[[\s\S]*\]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/.test(v.trim());
  return h('span', { className: `jform__v jform__v--${kind}` }, visible(typed ? JSON.stringify(v) : String(v)));
}

function chipList(items, k, hot) {
  if (!items.length) return h('span', { className: 'jform__v jform__v--null' }, 'none');
  return h('ul', { className: 'jform__chips', 'data-hot': hot && hot.has(k) ? 'true' : undefined }, items.map((x) => h('li', { className: 'jform__chip' }, visible(String(x)))));
}

function form(value, hot, k = '', depth = 0) {
  if (depth > MAX_FORM_DEPTH) return h('span', { className: 'jform__v' }, visible(JSON.stringify(value)));
  if (Array.isArray(value)) {
    if (value.every(prim)) return chipList(value, k, hot);
    return h('ol', { className: 'jform__list' }, value.map((x, i) => h('li', null, h('span', { className: 'jform__idx' }, String(i + 1)), form(x, hot, '', depth + 1))));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return h('span', { className: 'jform__v jform__v--null' }, 'empty');
    return h('dl', { className: 'jform', 'data-depth': Math.min(depth, 3) }, entries.map(([key, v]) =>
      h('div', { className: 'jform__row', 'data-hot': hot.has(key) ? 'true' : undefined, 'data-alert': ALERT.has(key) ? 'true' : undefined, 'data-nested': nestedValue(v) ? 'true' : undefined },
        h('dt', { className: 'jform__k' }, visible(key)),
        h('dd', { className: 'jform__d' }, prim(v) ? valueEl(v, key, hot) : form(v, hot, key, depth + 1)))));
  }
  return valueEl(value, k);
}

// ---- The pane. value: an object or array (or a string holding one) gets the Form | JSON choice; `hot` (array of key names) stands
// those keys out in both views; any other string (a token, or text) is shown as it is, a token in its three colours.
function buildPane(container, given, { label, testId, toggle = true, hot } = {}) {
  const value = given === undefined ? '' : given; // a missing value is an empty pane, never the word "undefined"
  const hotSet = hot && hot.length ? new Set([...HOT, ...hot]) : HOT;
  const fromText = typeof value === 'string' ? parseJsonText(value) : undefined;
  const data = fromText !== undefined ? fromText : value;
  const isJson = typeof data === 'object' && data !== null;
  // A string is shown EXACTLY as given in the JSON view; only an object or array is laid out with two-space indent.
  const text = typeof value === 'string' ? value : isJson ? JSON.stringify(data, null, 2) : JSON.stringify(value);
  const tid = (suffix) => (testId ? `${testId}${suffix}` : undefined);
  if (text.length > MAX_PANE_CHARS) {
    return h('div', { className: 'jsonbox', 'data-testid': tid('-box'), 'data-view': 'text' },
      h('pre', { className: 'json json--raw', tabindex: 0, 'aria-label': label, 'data-testid': testId }, visible(text)));
  }
  const asForm = isJson && view === 'form';
  const pick = (v, n) => () => {
    setJsonView(v);
    const again = container.querySelector?.(`.jsonbox__toggle button:nth-child(${n})`);
    if (again) again.focus();
  };
  let bar = null;
  if (isJson && toggle) {
    const formBtn = h('button', { type: 'button', 'aria-pressed': asForm, 'data-testid': tid('-formatted') }, 'Form');
    const rawBtn = h('button', { type: 'button', 'aria-pressed': !asForm, 'data-testid': tid('-raw') }, 'JSON');
    formBtn.addEventListener('click', pick('form', 1));
    rawBtn.addEventListener('click', pick('raw', 2));
    bar = h('span', { className: 'jsonbox__toggle', role: 'group', 'aria-label': `${label || 'JSON'} view` }, formBtn, rawBtn);
  }
  const body = asForm
    ? h('div', { className: 'json json--form', tabindex: 0, role: 'group', 'aria-label': label, 'data-testid': testId }, form(data, hotSet))
    : h('pre', { className: 'json json--raw', tabindex: 0, 'aria-label': label, 'data-testid': testId },
      isJson ? rawJson(text, hotSet) : kindOf(text) === 'token' ? jwt(text) : visible(text));
  return h('div', { className: 'jsonbox', 'data-testid': tid('-box'), 'data-view': isJson ? view : 'text' }, bar, body);
}

function paint(container) {
  const { value, opts } = mounted.get(container);
  container.replaceChildren(buildPane(container, value, opts));
}

// Show `value` in `container` as a JSON pane (replacing what was there). The pane follows the page's Form | JSON choice.
export function showJson(container, value, opts = {}) {
  mounted.set(container, { value, opts });
  paint(container);
}
