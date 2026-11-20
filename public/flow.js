// The run as a chat and a vertical movie reel, drawn from the server's record of the run (/api/state flow), so it
// survives the sign-in redirect and a reload. Chat messages and reel frames are the same hops. All text from servers
// goes in as text. Nothing here talks to a gateway except the one refusals probe.
import { isPlaceholderMcpUrl } from './mcpUrlCheck.js';

const LANES = {
  client: { name: 'Demo client', letter: 'C', token: '--lane-browser' },
  gateway: { name: 'Privilege gateway', letter: 'G', token: '--lane-gateway' },
  idp: { name: 'PingOne', letter: 'P', token: '--lane-idp' },
  mcp: { name: 'MCP server', letter: 'M', token: '--lane-mcp' }
};
const SPEEDS = [{ ms: 900, label: 'Fast' }, { ms: 1800, label: 'Steady' }, { ms: 3200, label: 'Slow' }];

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}
const chip = (text, tone) => el('span', { class: `flow-chip flow-chip--${tone || 'plain'}`, text });
const lane = (h) => LANES[h.lane] || LANES.client;

export function mountFlow({ api, startSignIn, refreshTools, inputs }) {
  const chatEl = document.querySelector('#flowChat');
  const reelEl = document.querySelector('#reel');
  const runBtn = document.querySelector('#reelRun');
  const speedSel = document.querySelector('#reelSpeed');
  const countEl = document.querySelector('#reelCount');
  const stepEls = [...document.querySelectorAll('#stepper li')];

  let last = null;
  let selected = null; // hop number
  let playAt = null; // index of the frame playing, or null when showing the whole run
  let timer = null;
  let renderedKey = '';
  let speed = SPEEDS[1].ms;
  speedSel.replaceChildren(...SPEEDS.map((s) => el('option', { value: String(s.ms), text: s.label })));
  speedSel.value = String(speed);

  const hops = () => last?.flow || [];
  const authed = () => Boolean(last?.oauth?.authenticated);

  function bubble(h, i) {
    const l = lane(h);
    const faded = playAt !== null && i > playAt;
    const row = el('div', { class: `flow-msg${faded ? ' faded' : ''}${h.n === selected ? ' sel' : ''}`, 'data-n': String(h.n) });
    const av = el('div', { class: 'flow-av', 'aria-hidden': 'true', text: l.letter });
    av.style.setProperty('--c', `var(${l.token})`);
    const who = el('div', { class: 'flow-who' }, el('span', { class: 'flow-sn', text: String(h.step) }), el('span', { text: l.name }));
    who.style.setProperty('--c', `var(${l.token})`);
    const chips = el('div', { class: 'flow-row' }, chip(h.status, h.tone));
    row.append(av, el('div', { class: 'flow-bub' }, who, el('div', { text: h.say }), chips));
    return row;
  }

  function note(text, ...actions) {
    const row = el('div', { class: 'flow-msg' });
    const av = el('div', { class: 'flow-av', 'aria-hidden': 'true', text: 'C' });
    av.style.setProperty('--c', `var(${LANES.client.token})`);
    const who = el('div', { class: 'flow-who' }, el('span', { text: LANES.client.name }));
    who.style.setProperty('--c', `var(${LANES.client.token})`);
    const body = el('div', { class: 'flow-bub' }, who, el('div', { text }));
    if (actions.length) body.append(el('div', { class: 'flow-row' }, ...actions));
    row.append(av, body);
    return row;
  }

  function button(label, onClick, disabled) {
    const b = el('button', { type: 'button', class: 'flow-btn', text: label });
    b.disabled = Boolean(disabled);
    b.addEventListener('click', onClick);
    return b;
  }

  async function runRefusals(btn) {
    btn.disabled = true;
    try { await api('/api/cimd/refusals', { method: 'POST' }); } catch { /* the probe's own error shows as no frames */ }
    await reload();
  }

  function renderChat() {
    const list = hops();
    const parts = [];
    const needUrl = isPlaceholderMcpUrl(inputs.mcpUrl.value);
    if (!list.length) {
      parts.push(note(needUrl
        ? 'Hi. I am a demo client with no registration. Put the MCP address of a gateway door in the Connection panel, leave OAuth Client ID empty, then sign in.'
        : 'Ready. The MCP address is set and the Client ID is empty, so I will use my own document. Sign in when you are ready.',
      button('Sign in', () => startSignIn(), needUrl)));
    } else {
      list.forEach((h, i) => parts.push(bubble(h, i)));
      if (playAt === null) {
        if (!authed()) {
          parts.push(note('Waiting for the sign-in to finish.', button('Sign in again', () => startSignIn())));
        } else if (!list.some((h) => h.kind.startsWith('refuse-'))) {
          const b = button('Try the two refusals', (e) => runRefusals(e.currentTarget));
          parts.push(note('Signed in and listing tools. Next, two requests that must fail.', b));
        }
      }
    }
    chatEl.replaceChildren(...parts);
  }

  function renderReel() {
    const list = hops();
    countEl.textContent = `${list.length} ${list.length === 1 ? 'hop' : 'hops'}`;
    if (!list.length) {
      reelEl.replaceChildren(el('p', { class: 'flow-empty', text: 'The reel fills in as the run happens: one frame per hop.' }));
      return;
    }
    const kids = [];
    list.forEach((h, i) => {
      const l = lane(h);
      const faded = playAt !== null && i > playAt;
      const now = playAt === i;
      const frame = el('div', { class: `frm${h.n === selected ? ' sel' : ''}${now ? ' now' : ''}${faded ? ' next' : ''}`, role: 'button', tabindex: '0', 'data-n': String(h.n), 'aria-label': `Frame ${h.n}: ${h.title}` });
      frame.style.setProperty('--c', `var(${l.token})`);
      const top = el('div', { class: 'frm-top' }, el('span', { class: 'frm-no', text: String(h.n) }), el('span', { text: h.from === h.to ? h.from : `${h.from} → ${h.to}` }), chip(`step ${h.step}`), chip(h.status, h.tone));
      if (now) top.append(el('span', { class: 'frm-now', text: 'Now playing' }));
      frame.append(top, el('div', { class: 'frm-ttl', text: h.title }), el('div', { class: 'frm-fact', text: h.fact }));
      const pick = () => { selected = h.n; renderedKey = ''; render(); chatEl.querySelector(`[data-n="${h.n}"]`)?.scrollIntoView({ block: 'nearest' }); };
      frame.addEventListener('click', pick);
      frame.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      kids.push(frame);
      if (i < list.length - 1) kids.push(el('div', { class: 'frm-down', 'aria-hidden': 'true' }));
    });
    reelEl.replaceChildren(...kids);
  }

  function renderStepper() {
    const list = hops();
    const has = (k) => list.some((h) => h.kind === k || h.kind.startsWith(k));
    const done = [
      Boolean(last?.cimdDocumentUrl),
      !isPlaceholderMcpUrl(inputs.mcpUrl.value),
      authed(),
      has('accepted'),
      has('tools'),
      has('refuse-')
    ];
    const current = done.indexOf(false);
    stepEls.forEach((li, i) => {
      li.classList.toggle('done', done[i]);
      li.classList.toggle('cur', i === current);
      li.querySelector('.st-state').textContent = done[i] ? 'Done' : i === current ? 'Next' : '';
    });
    runBtn.textContent = timer ? 'Pause' : playAt === null && list.length ? 'Replay' : 'Run';
    runBtn.disabled = !list.length;
  }

  function render() {
    const list = hops();
    const key = JSON.stringify([list.map((h) => [h.n, h.kind, h.status, h.fact, h.say]), authed(), playAt, selected, Boolean(timer), isPlaceholderMcpUrl(inputs.mcpUrl.value), Boolean(last?.cimdDocumentUrl)]);
    if (key === renderedKey) return;
    const before = chatEl.parentElement?.scrollTop ?? 0;
    const grew = list.length !== Number(renderedKey ? JSON.parse(renderedKey)[0].length : -1);
    renderedKey = key;
    renderChat();
    renderReel();
    renderStepper();
    const scroller = chatEl.parentElement;
    if (scroller) scroller.scrollTop = grew && playAt === null && selected === null ? scroller.scrollHeight : before;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function togglePlay() {
    if (timer) { stop(); renderedKey = ''; render(); return; }
    const list = hops();
    if (!list.length) return;
    playAt = 0;
    selected = list[0].n;
    timer = setInterval(() => {
      playAt += 1;
      if (playAt >= hops().length) { stop(); playAt = null; selected = null; } else { selected = hops()[playAt].n; }
      renderedKey = '';
      render();
      chatEl.querySelector(`[data-n="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
    }, speed);
    renderedKey = '';
    render();
  }
  runBtn.addEventListener('click', togglePlay);
  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); if (timer) { stop(); togglePlay(); } });
  inputs.mcpUrl.addEventListener('input', () => render());
  inputs.clientId.addEventListener('input', () => render());

  async function reload() {
    last = await api('/api/state');
    render();
  }

  return {
    update(state) { last = state; render(); },
    reload
  };
}
