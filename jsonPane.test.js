// Rule 24: the page's JSON panes (public/jsonPane.js) render as text only, follow one Form | JSON choice, stand out the
// important keys, and are never capped. A tiny fake DOM stands in for the browser; setting innerHTML on it throws, so any
// markup path in the renderer fails these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

class FakeText {
  constructor(text) { this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
}
class FakeEl {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.children = []; this.handlers = {}; this.className = ''; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? new FakeText(n) : n); }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  click() { for (const fn of this.handlers.click || []) fn({ type: 'click' }); }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('innerHTML used: data must be rendered as text'); }
  get style() { return {}; }
}
globalThis.document = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };

const { showJson, setJsonView, jsonView } = await import('./public/jsonPane.js');

function all(node, pred, out = []) {
  if (node.nodeType === 1) {
    if (pred(node)) out.push(node);
    for (const c of node.children) all(c, pred, out);
  }
  return out;
}
const byClass = (node, cls) => all(node, (e) => e.className.split(/\s+/).includes(cls));
const buttons = (node) => all(node, (e) => e.tagName === 'BUTTON');

test('vendored JsonPane.css matches its sha256 pin (never hand-edited)', () => {
  const [pinned, name] = read('public/json/JsonPane.css.sha256').trim().split(/\s+/);
  assert.equal(name, 'JsonPane.css');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(here, 'public/json/JsonPane.css'))).digest('hex');
  assert.equal(actual, pinned);
});

test('hostile text stays text in both views: no elements from data, control and bidi characters escaped', () => {
  const hostile = { name: '<img src=x onerror=alert(1)>', note: 'left‮right', '<b>key</b>': '</pre><script>x()</script>' };
  for (const v of ['form', 'raw']) {
    setJsonView(v);
    const box = new FakeEl('div');
    showJson(box, hostile, { label: 'Hostile' });
    const tags = new Set(all(box, () => true).map((e) => e.tagName));
    for (const t of ['IMG', 'SCRIPT', 'B']) assert.ok(!tags.has(t), `${v}: no <${t.toLowerCase()}> built from data`);
    const text = box.textContent;
    assert.ok(text.includes('<img src=x onerror=alert(1)>'), `${v}: markup shown as text`);
    assert.ok(text.includes('</pre><script>x()</script>'), `${v}: closing tags shown as text`);
    assert.ok(text.includes('left\\u202eright') && !text.includes('‮'), `${v}: bidi override shown as an escape`);
  }
});

test('Form | JSON toggle: one choice repaints every pane, buttons say Form and JSON', () => {
  setJsonView('form');
  const a = new FakeEl('div');
  const b = new FakeEl('div');
  showJson(a, { authenticated: true, discoveredTools: 2 }, { label: 'Status', testId: 'statusBox', hot: ['authenticated'] });
  showJson(b, { names: ['one', 'two'] }, { label: 'Tools' });
  assert.equal(byClass(a, 'jform').length, 1, 'Form view is a form');
  const [formBtn, rawBtn] = buttons(a);
  assert.equal(formBtn.textContent, 'Form');
  assert.equal(rawBtn.textContent, 'JSON');
  assert.equal(formBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(formBtn.getAttribute('data-testid'), 'statusBox-formatted');

  rawBtn.click();
  assert.equal(jsonView(), 'raw');
  for (const box of [a, b]) {
    assert.equal(byClass(box, 'jform').length, 0, 'JSON view has no form');
    const pre = byClass(box, 'json--raw');
    assert.equal(pre.length, 1);
    assert.equal(pre[0].tagName, 'PRE');
    assert.ok(byClass(box, 'jtok--punct').length > 0, 'JSON view is coloured by part');
  }
  assert.equal(buttons(a)[1].getAttribute('aria-pressed'), 'true');
  assert.equal(byClass(a, 'json--raw')[0].textContent, JSON.stringify({ authenticated: true, discoveredTools: 2 }, null, 2), 'JSON view is the exact text');

  buttons(b)[0].click();
  assert.equal(jsonView(), 'form');
  assert.equal(byClass(a, 'jform').length, 1, 'the other pane follows');
});

test('important keys stand out in both views; errors in the alert colour', () => {
  const value = { authenticated: false, error: 'MCP URL is required', discoveredTools: 0 };
  setJsonView('form');
  const box = new FakeEl('div');
  showJson(box, value, { hot: ['authenticated'] });
  const rows = byClass(box, 'jform__row');
  assert.equal(rows.find((r) => r.textContent.startsWith('authenticated')).getAttribute('data-hot'), 'true');
  assert.equal(rows.find((r) => r.textContent.startsWith('error')).getAttribute('data-alert'), 'true');
  assert.equal(rows.find((r) => r.textContent.startsWith('discoveredTools')).getAttribute('data-hot'), null);
  setJsonView('raw');
  assert.deepEqual(byClass(box, 'jtok--hot').map((e) => e.textContent), ['"authenticated"']);
  assert.ok(byClass(box, 'jtok--alert').some((e) => e.textContent === '"error"'));
  setJsonView('form');
});

test('plain text and tokens are shown as given, without a toggle; missing value is an empty pane', () => {
  const box = new FakeEl('div');
  showJson(box, 'Suggest listTools first.', { label: 'LLM result' });
  assert.equal(buttons(box).length, 0);
  assert.equal(box.textContent, 'Suggest listTools first.');
  showJson(box, 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZW1vIn0.c2ln');
  assert.deepEqual(['jtok--jwt1', 'jtok--jwt2', 'jtok--jwt3'].map((c) => byClass(box, c).length), [1, 1, 1]);
  showJson(box, undefined);
  assert.equal(box.textContent, '');
});

test('full view: no JSON pane is capped, and the page builds no JSON text by hand', () => {
  const css = read('public/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const pane = /json|(?:^|[^a-z])pre(?:[^a-z]|$)|#(?:statusBox|toolsSummary|toolResult|rawRpcResult|llmResult)\b/i;
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!pane.test(selector)) continue;
    assert.ok(!/max-height\s*:\s*(?!none)/i.test(body), `${selector.trim()} has a max-height`);
    assert.ok(!/overflow(?:-[xy])?\s*:\s*[^;]*\b(?:auto|scroll)\b/i.test(body), `${selector.trim()} scrolls`);
  }
  assert.match(read('public/json/JsonPane.css'), /\.jsonbox, \.jsonbox \.json\.json \{ max-height: none; height: auto; overflow: visible; \}/);
  const html = read('public/index.html');
  assert.match(html, /href="\.\/json\/JsonPane\.css"/);
  for (const id of ['statusBox', 'toolsSummary', 'toolResult', 'rawRpcResult', 'llmResult']) assert.match(html, new RegExp(`<div id="${id}"></div>`));
  for (const file of ['public/app.js', 'public/jsonPane.js']) {
    const src = read(file);
    assert.ok(!/\.(?:textContent|innerText|innerHTML)\s*=\s*[^;\n]*JSON\.stringify\s*\(/.test(src), `${file} writes JSON text by hand`);
  }
  assert.ok(!/innerHTML/.test(read('public/jsonPane.js').replace(/^\s*\/\/.*$/gm, '')), 'the renderer never uses innerHTML');
});
