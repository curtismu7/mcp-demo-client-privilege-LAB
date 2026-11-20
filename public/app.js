import { showJson } from './jsonPane.js';
import { mountFlow } from './flow.js';
import { isPlaceholderMcpUrl } from './mcpUrlCheck.js';

// Keys that matter in this client's payloads: they stand out in both views of every JSON pane (Rule 24).
const HOT = ['authenticated', 'warning', 'isError', 'suggested_tools'];

const els = {
  mcpUrl: document.querySelector('#mcpUrl'),
  clientId: document.querySelector('#clientId'),
  scopes: document.querySelector('#scopes'),
  llmUrl: document.querySelector('#llmUrl'),
  llmModel: document.querySelector('#llmModel'),
  saveConfigBtn: document.querySelector('#saveConfigBtn'),
  startAuthBtn: document.querySelector('#startAuthBtn'),
  restartBtn: document.querySelector('#restartBtn'),
  listToolsBtn: document.querySelector('#listToolsBtn'),
  statusBox: document.querySelector('#statusBox'),
  connectionPill: document.querySelector('#connectionPill'),
  toolsSummary: document.querySelector('#toolsSummary'),
  toolSelect: document.querySelector('#toolSelect'),
  toolArgs: document.querySelector('#toolArgs'),
  callToolBtn: document.querySelector('#callToolBtn'),
  toolResult: document.querySelector('#toolResult'),
  rawRpcBox: document.querySelector('#rawRpcBox'),
  sendRawRpcBtn: document.querySelector('#sendRawRpcBtn'),
  rawRpcResult: document.querySelector('#rawRpcResult'),
  llmPrompt: document.querySelector('#llmPrompt'),
  askLlmBtn: document.querySelector('#askLlmBtn'),
  llmResult: document.querySelector('#llmResult'),
  eventLog: document.querySelector('#eventLog'),
  chatMessages: document.querySelector('#chatMessages'),
  chatPrompt: document.querySelector('#chatPrompt'),
  sendChatBtn: document.querySelector('#sendChatBtn'),
  chatThinking: document.querySelector('#chatThinking')
};

const uiState = {
  tools: [],
  authenticated: false,
  lastRefreshError: null,
  autoRefresh: {
    inFlight: false,
    timer: null,
    intervalMs: 5000,
    lastRun: null
  }
};

// Every JSON pane goes through the shared Form | JSON pane (Rule 24); the label is the pane's accessible name.
function setJson(node, value, label) {
  showJson(node, value, { label, testId: node.id, hot: HOT });
}

function truncate(value, max = 240) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... (+${value.length - max} chars)`;
}

function summarizeEvent(entry) {
  const out = { ...entry };
  if (out.direction === 'mcp->client' && out.body?.result?.tools) {
    out.body = {
      summary: 'tools/list response',
      toolCount: out.body.result.tools.length,
      toolNames: out.body.result.tools.map((t) => t.name)
    };
  } else if (out.direction === 'mcp->client' && out.body?.raw) {
    out.body = { raw: truncate(out.body.raw, 280) };
  }
  if (out.message) out.message = truncate(out.message, 280);
  return out;
}

function appendEvent(entry) {
  const line = `[${entry.ts || new Date().toISOString()}] ${JSON.stringify(summarizeEvent(entry))}`;
  els.eventLog.textContent = `${line}\n${els.eventLog.textContent}`.slice(0, 50000);
}

function appendChat(role, content, extra = null) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  bubble.textContent = content;
  if (extra) {
    const meta = document.createElement('div');
    meta.style.marginTop = '8px';
    showJson(meta, extra, { label: 'Message details', hot: HOT });
    bubble.appendChild(meta);
  }
  els.chatMessages.appendChild(bubble);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function setThinking(active) {
  els.chatThinking.classList.toggle('hidden', !active);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error || text || `HTTP ${response.status}`);
  }
  return data;
}

function toolNames(tools) {
  return (tools || []).map((t) => t.name).sort();
}

function sameTools(a, b) {
  const aa = toolNames(a);
  const bb = toolNames(b);
  return aa.length === bb.length && aa.every((name, i) => name === bb[i]);
}

function renderTools(tools) {
  uiState.tools = tools || [];
  flowUi.reload().catch(() => {});
  els.toolSelect.innerHTML = '';
  for (const tool of uiState.tools) {
    const option = document.createElement('option');
    option.value = tool.name;
    option.textContent = `${tool.name} — ${tool.description || 'No description'}`;
    els.toolSelect.appendChild(option);
  }
  setJson(els.toolsSummary, {
    discoveredTools: uiState.tools.length,
    names: uiState.tools.map((t) => t.name)
  }, 'Available tools');
}

function renderStatus(extra = {}) {
  const payload = {
    authenticated: uiState.authenticated,
    discoveredTools: uiState.tools.length,
    lastAutoRefresh: uiState.autoRefresh.lastRun,
    ...extra
  };
  setJson(els.statusBox, payload, 'Status');
  els.connectionPill.textContent = uiState.authenticated ? 'Connected' : 'Not Authenticated';
  els.connectionPill.classList.toggle('pill-ok', uiState.authenticated);
  els.connectionPill.classList.toggle('pill-bad', !uiState.authenticated);
}

const flowUi = mountFlow({
  api,
  inputs: { mcpUrl: els.mcpUrl, clientId: els.clientId },
  startSignIn: () => startAuth(true),
  refreshTools: () => els.listToolsBtn.click()
});

async function refreshState() {
  const state = await api('/api/state');
  // The shipped placeholder address is not something to show: leave the box empty so the hint reads.
  els.mcpUrl.value = isPlaceholderMcpUrl(state.config.mcpUrl) ? '' : (state.config.mcpUrl || '');
  els.clientId.value = state.config.clientId || '';
  els.scopes.value = state.config.scopes || '';
  els.llmUrl.value = state.config.llmUrl || '';
  els.llmModel.value = state.config.llmModel || '';
  uiState.authenticated = Boolean(state.oauth?.authenticated);
  renderTools(state.tools || []);
  renderStatus({ tokenExpiresAt: state.oauth?.expiresAt || null });
  await flowUi.update(state);
}

async function saveConfigFromInputs() {
  const config = {
    mcpUrl: els.mcpUrl.value.trim(),
    clientId: els.clientId.value.trim(),
    scopes: els.scopes.value.trim(),
    llmUrl: els.llmUrl.value.trim(),
    llmModel: els.llmModel.value.trim()
  };
  await api('/api/config', { method: 'POST', body: config });
}

async function refreshToolsAuto() {
  // The shipped MCP address is a placeholder that can never resolve: ask nothing of it, and show no error.
  if (!els.mcpUrl.value.trim() || isPlaceholderMcpUrl(els.mcpUrl.value)) return;
  // Listing tools needs a token, so there is nothing to poll for before sign-in (and a half-typed address must never be tried).
  if (!uiState.authenticated) return;
  if (uiState.autoRefresh.inFlight) return;
  uiState.autoRefresh.inFlight = true;
  try {
    const before = uiState.tools;
    const data = await api('/api/tools/list', { method: 'POST' });
    const nextTools = data.tools || [];
    uiState.authenticated = true;
    uiState.autoRefresh.lastRun = new Date().toISOString();
    if (!sameTools(before, nextTools)) {
      renderTools(nextTools);
      appendChat('system', `Tools updated (${nextTools.length}).`, {
        names: nextTools.map((t) => t.name)
      });
    } else {
      renderTools(nextTools);
    }
    if (uiState.lastRefreshError) {
      appendChat('system', 'Connection recovered.');
      uiState.lastRefreshError = null;
    }
    renderStatus({ mode: 'auto-refresh' });
  } catch (error) {
    const message = error.message;
    uiState.authenticated = false;
    uiState.autoRefresh.lastRun = new Date().toISOString();
    // Before sign-in a real gateway answers 401: that is the expected state, not a failure to report.
    const notSignedIn = /\b401\b|unauthor|bearer token/i.test(message);
    if (!notSignedIn && (!uiState.lastRefreshError || uiState.lastRefreshError !== message)) {
      appendChat('system', 'Auto-refresh failed.', { error: message });
      uiState.lastRefreshError = message;
    }
    renderTools([]);
    renderStatus({ mode: 'auto-refresh', warning: message });
  } finally {
    uiState.autoRefresh.inFlight = false;
  }
}

function scheduleAutoRefresh() {
  if (uiState.autoRefresh.timer) {
    clearTimeout(uiState.autoRefresh.timer);
  }
  uiState.autoRefresh.timer = setTimeout(async () => {
    await refreshToolsAuto();
    scheduleAutoRefresh();
  }, uiState.autoRefresh.intervalMs);
}

async function sendDemoChat() {
  const prompt = els.chatPrompt.value.trim();
  if (!prompt) return;

  appendChat('user', prompt);
  setThinking(true);
  try {
    await saveConfigFromInputs();
    const data = await api('/api/demo/chat', { method: 'POST', body: { prompt } });
    if (data.authUrl) {
      window.open(data.authUrl, '_blank', 'noopener,noreferrer');
      appendChat('assistant', `${data.reply} (Opened OAuth in new tab)`, data.steps || null);
    } else {
      const availableTools = Array.isArray(data.tools) ? data.tools.map((t) => t.name) : [];
      appendChat('assistant', data.reply || 'Done.', {
        available_tools: availableTools,
        suggested_tools: data.suggested_tools || [],
        steps: data.steps || []
      });
      if (Array.isArray(data.tools)) {
        renderTools(data.tools);
        uiState.authenticated = true;
        renderStatus({ mode: 'chat-assisted' });
      }
    }
  } catch (error) {
    appendChat('assistant', `Error: ${error.message}`);
  } finally {
    setThinking(false);
  }
}

els.saveConfigBtn.addEventListener('click', async () => {
  try {
    await saveConfigFromInputs();
    await refreshState();
    appendChat('system', 'Config saved.');
  } catch (error) {
    appendEvent({ level: 'error', action: 'save_config', message: error.message });
  }
});

// sameTab: the walkthrough signs in in this tab and comes back to it; the Sign In button keeps opening a new tab.
let signInRedirect = null; // the pending same-tab hop to PingOne; Reset cancels it
async function startAuth(sameTab) {
  try {
    if (!els.mcpUrl.value.trim() || isPlaceholderMcpUrl(els.mcpUrl.value)) {
      appendChat('system', 'Paste the MCP door address from your gateway into the MCP URL box first.');
      return;
    }
    await saveConfigFromInputs();
    const data = await api('/api/auth/start', { method: 'POST' });
    await refreshState();
    if (sameTab) {
      // Leave a moment so the chat line and step 3 can be read before the page changes.
      signInRedirect = setTimeout(() => window.location.assign(data.authUrl), 2500);
    } else {
      window.open(data.authUrl, '_blank', 'noopener,noreferrer');
    }
  } catch (error) {
    appendChat('system', `OAuth start failed: ${error.message}`);
  }
}

els.startAuthBtn.addEventListener('click', () => startAuth(false));

// Reset: clear the run and the sign-in on the server, then repaint from a clean state. Settings are kept.
document.querySelector('#reelReset').addEventListener('click', async () => {
  clearTimeout(signInRedirect);
  els.chatMessages.textContent = '';
  els.eventLog.textContent = '';
  for (const pane of [els.rawRpcResult, els.toolResult, els.llmResult]) pane.textContent = '';
  try {
    await api('/api/reset', { method: 'POST', body: {} });
    flowUi.closeDetail();
    await refreshState();
  } catch (error) {
    appendChat('system', `Reset failed: ${error.message}`);
  }
});

// Restart: clear every message pane and start a fresh MCP session. Sign-in and settings are kept.
els.restartBtn.addEventListener('click', async () => {
  els.chatMessages.textContent = '';
  els.eventLog.textContent = '';
  for (const pane of [els.rawRpcResult, els.toolResult, els.llmResult]) pane.textContent = '';
  try {
    // An empty config update resets the server-side MCP session (initialize runs again) and keeps oauth.
    await api('/api/config', { method: 'POST', body: {} });
    appendChat('system', 'Restarted: messages cleared, new MCP session. Sign-in and settings kept.');
  } catch (error) {
    appendChat('system', `Restart failed: ${error.message}`);
  }
});

els.listToolsBtn.addEventListener('click', async () => {
  await refreshToolsAuto();
});

els.sendChatBtn.addEventListener('click', async () => {
  await sendDemoChat();
});

els.chatPrompt.addEventListener('keydown', async (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    await sendDemoChat();
  }
});

els.callToolBtn.addEventListener('click', async () => {
  try {
    const args = JSON.parse(els.toolArgs.value || '{}');
    const data = await api('/api/tools/call', {
      method: 'POST',
      body: { name: els.toolSelect.value, arguments: args }
    });
    setJson(els.toolResult, data, 'Tool result');
  } catch (error) {
    setJson(els.toolResult, { error: error.message }, 'Tool result');
  }
});

els.sendRawRpcBtn.addEventListener('click', async () => {
  try {
    const rpc = JSON.parse(els.rawRpcBox.value);
    const data = await api('/api/mcp/rpc', { method: 'POST', body: rpc });
    setJson(els.rawRpcResult, data, 'Raw RPC result');
  } catch (error) {
    setJson(els.rawRpcResult, { error: error.message }, 'Raw RPC result');
  }
});

els.askLlmBtn.addEventListener('click', async () => {
  try {
    await saveConfigFromInputs();
    const data = await api('/api/llm/chat', {
      method: 'POST',
      body: { message: els.llmPrompt.value }
    });
    setJson(els.llmResult, data.response, 'LLM result');
  } catch (error) {
    setJson(els.llmResult, { error: error.message }, 'LLM result');
  }
});

const events = new EventSource('/api/events');
events.addEventListener('relay', (event) => appendEvent(JSON.parse(event.data)));
events.addEventListener('oauth', (event) => appendEvent(JSON.parse(event.data)));
events.addEventListener('config', (event) => appendEvent(JSON.parse(event.data)));
events.addEventListener('mcp', (event) => appendEvent(JSON.parse(event.data)));
events.addEventListener('error', (event) => appendEvent(JSON.parse(event.data)));

await refreshState();
await refreshToolsAuto();
scheduleAutoRefresh();
window.addEventListener('focus', () => {
  refreshToolsAuto();
});

const authResult = new URLSearchParams(window.location.search).get('auth');
const authErrorReason = new URLSearchParams(window.location.search).get('reason');
if (authResult === 'success') {
  appendChat('system', 'OAuth callback completed. Refreshing tools...');
  refreshToolsAuto();
}
if (authResult === 'error') {
  appendChat('system', 'OAuth callback failed.', {
    reason: authErrorReason ? decodeURIComponent(authErrorReason) : 'Unknown error'
  });
}

// Shelf button (owner rule 2026-11-08): the header link back to the launcher. Shown only when /api/shelf has a URL.
fetch('/api/shelf', { credentials: 'omit', headers: { Accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    if (!d || !d.shelfUrl) return;
    const a = document.createElement('a');
    a.className = 'shelf-link';
    a.href = d.shelfUrl;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.title = 'Open the demo shelf (launcher)';
    a.textContent = 'Shelf';
    a.className = 'top-menu__shelf top-menu__shelf--accent';
    a.style.display = 'inline-flex';
    const existing = document.getElementById('shelf-link');
    if (existing) existing.replaceWith(a); else { const row = document.querySelector('.top-menu__row'); if (row) row.appendChild(a); }
  })
  .catch(() => { /* stay hidden: no shelf, no button */ });
