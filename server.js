import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { URL } from 'url';
import { buildLlmRequest, readLlmReply, llmPath } from './llm.js';
import { shelfInfo } from './shelfLink.js';
import { hostAllowed, isLoopbackName, labAllowedHosts, parseHost, writeAllowed } from './safety.js';
import { gatewayMcpUrl } from './mcpUrl.js';
import { cimdClientIdUrl, clientDocument, serverSupportsCimd, setupGuideUrl } from './cimd.js';
import { createFlow, redactBody } from './flow.js';

// Privilege LLM-lane virtual key (when llmUrl points at <gateway>/llm/...). Env only.
// LLM_API_KEY wins; HOSTED_LLM_VIRTUAL_KEY (the shared settings file's name for the hosted
// gateway's key) is the fallback, and HOSTED_LLM_GATEWAY_URL gives the matching lane base URL.
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.HOSTED_LLM_VIRTUAL_KEY || '';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 6884;
const STATIC_DIR = path.resolve('public');
// The lab-proxy's Host name(s) for this lab (compose sets it); loopback always works.
const LAB_HOSTS = labAllowedHosts(process.env.LAB_ALLOWED_HOSTS);

const flow = createFlow();

const state = {
  config: {
    mcpUrl: 'https://mcp-gateway.example.invalid/mcp/',
    clientId: '',
    scopes: 'openid profile email',
    // The hosted Privilege LLM lane when the shared settings file provides it; local Ollama otherwise.
    llmUrl: process.env.HOSTED_LLM_GATEWAY_URL ? `${process.env.HOSTED_LLM_GATEWAY_URL.replace(/\/+$/, '')}/llm/custom/v1` : 'http://127.0.0.1:11434',
    llmModel: 'llama3.2:1b'
  },
  oauth: {
    accessToken: null,
    refreshToken: null,
    expiresAt: null
  },
  tools: [],
  // What the walkthrough page shows about the last sign-in: how the client identified itself and what the door said.
  walk: { discovered: false, serverCimd: null, identity: null, redirectUri: null },
  mcpSession: {
    initialized: false,
    protocolVersion: null,
    sessionId: null
  },
  pendingAuth: null,
  eventClients: new Set(),
  // Rule 19 mode: 'mock' sends the LLM call straight to the configured URL (ungoverned),
  // 'real' routes it through the Privilege LLM lane (LLM_API_KEY + a lane URL required).
  mode: 'mock'
};

function nowIso() {
  return new Date().toISOString();
}

function emitEvent(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify({ ts: nowIso(), ...payload })}\n\n`;
  for (const client of state.eventClients) {
    client.write(msg);
  }
}

function json(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function getMime(fileName) {
  if (fileName.endsWith('.html')) return 'text/html; charset=utf-8';
  if (fileName.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

function sanitizeFilePath(urlPath) {
  const cleanPath = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, '');
  return path.join(STATIC_DIR, resolved);
}

function randomString(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

async function fetchMcp(pathname, body, withAuth = true) {
  if (!state.config.mcpUrl) {
    throw new Error('MCP URL is required');
  }
  const targetUrl = new URL(state.config.mcpUrl);
  targetUrl.pathname = pathname || targetUrl.pathname;
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth && state.oauth.accessToken) {
    headers.Authorization = `Bearer ${state.oauth.accessToken}`;
  }
  if (state.mcpSession.sessionId) {
    headers['MCP-Session-Id'] = state.mcpSession.sessionId;
  }

  emitEvent('relay', {
    direction: 'client->mcp',
    method: 'POST',
    url: targetUrl.toString(),
    body
  });

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const parsed = decodeMcpBody(text);

  const responseSessionId =
    response.headers.get('mcp-session-id') || response.headers.get('MCP-Session-Id');
  if (responseSessionId && responseSessionId !== state.mcpSession.sessionId) {
    state.mcpSession.sessionId = responseSessionId;
    emitEvent('mcp', {
      phase: 'session_attached',
      sessionId: responseSessionId
    });
  }

  emitEvent('relay', {
    direction: 'mcp->client',
    status: response.status,
    headers: {
      'www-authenticate': response.headers.get('www-authenticate'),
      'mcp-session-id': responseSessionId
    },
    body: parsed
  });

  if (!response.ok) {
    const normalized = normalizeMcpFailure(response, text);
    throw new Error(normalized);
  }

  if (parsed?.error) {
    throw new Error(`MCP RPC error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }

  return parsed;
}

function decodeMcpBody(text) {
  if (!text || !text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    // Keep parsing below.
  }

  // Handle event-stream style response payloads:
  // event: message
  // data: {"jsonrpc":"2.0",...}
  const lines = text.split('\n').map((line) => line.trim());
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(dataLines[i]);
    } catch {
      // Continue searching.
    }
  }

  return { raw: text };
}

function resetMcpRuntimeState() {
  state.tools = [];
  state.mcpSession.initialized = false;
  state.mcpSession.protocolVersion = null;
  state.mcpSession.sessionId = null;
}

function normalizeMcpFailure(response, text) {
  const snippet = text.slice(0, 300);
  if (response.status === 502) {
    const lower = text.toLowerCase();
    if (lower.includes('<html') || lower.includes('bad gateway') || lower.includes('nginx')) {
      return (
        'MCP gateway returned 502 Bad Gateway from upstream. ' +
        'This usually means your authenticated user is not authorized for the target MCP tools ' +
        'or the upstream MCP service is unavailable.'
      );
    }
  }
  return `MCP request failed: ${response.status} ${snippet}`;
}

function parseLlmRouterJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('LLM returned empty response');
  }

  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with extraction.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // Continue with extraction.
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to final error.
    }
  }

  throw new Error('LLM response did not contain valid JSON payload');
}

async function ensureMcpSessionInitialized() {
  if (state.mcpSession.initialized) {
    return;
  }

  const initializeRpc = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: {
        name: 'MCP Privilege Demo Client',
        version: '1.0.0'
      }
    }
  };

  const initResponse = await fetchMcp(null, initializeRpc, true);
  const serverProtocol = initResponse?.result?.protocolVersion || '2025-11-25';

  await fetchMcp(
    null,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    },
    true
  );

  state.mcpSession.initialized = true;
  state.mcpSession.protocolVersion = serverProtocol;
  emitEvent('mcp', {
    phase: 'initialized',
    protocolVersion: serverProtocol
  });
}

// RFC 9728: from a 401's WWW-Authenticate resource_metadata URL (or the well-known
// path derived from the MCP URL), read the protected-resource document, then the
// authorization-server metadata. Returns { authorizationUri, tokenUri, registrationUri }.
async function discoverResourceMetadata(response, mcpUrl) {
  const authHeader = response.headers.get('www-authenticate') || '';
  const rmMatch = authHeader.match(/resource_metadata="([^"]+)"/);
  let rmUrl = rmMatch ? rmMatch[1] : null;
  if (!rmUrl) {
    // The MCP URL may carry a path prefix (e.g. https://host:8443/<lab>/mcp behind a
    // routing proxy); the resource document sits at <origin>/<prefix>/.well-known/...
    // with the prefix kept ahead of the well-known segment.
    const u = new URL(mcpUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const prefix = parts.slice(0, -1).join('/');
    rmUrl = prefix
      ? `${u.origin}/${prefix}/.well-known/oauth-protected-resource/${parts.at(-1)}`
      : `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  }
  const rmResponse = await fetch(rmUrl, { method: 'GET' });
  if (!rmResponse.ok) return null;
  const rm = await rmResponse.json();
  const asUrl = Array.isArray(rm.authorization_servers) && rm.authorization_servers.length
    ? rm.authorization_servers[0]
    : null;
  if (!asUrl) return null;
  const asMetaUrl = `${asUrl}/.well-known/oauth-authorization-server`;
  const asResponse = await fetch(asMetaUrl, { method: 'GET' });
  if (!asResponse.ok) return null;
  const asMeta = await asResponse.json();
  if (!asMeta.authorization_endpoint || !asMeta.token_endpoint) return null;
  return {
    authorizationUri: asMeta.authorization_endpoint,
    tokenUri: asMeta.token_endpoint,
    registrationUri: asMeta.registration_endpoint || null,
    cimdSupported: serverSupportsCimd(asMeta),
    scopes: Array.isArray(rm.scopes_supported) ? rm.scopes_supported : null,
    // The two calls as they happened, for the page's detail box. Public metadata, nothing secret.
    trace: {
      resource: { method: 'GET', url: rmUrl, status: rmResponse.status, body: rm },
      authorizationServer: { method: 'GET', url: asMetaUrl, status: asResponse.status, body: asMeta }
    }
  };
}

// RFC 7591 dynamic client registration. The redirect URI is this app's own /auth/callback.
async function dynamicallyRegister(registrationUri, redirectUri) {
  const response = await fetch(registrationUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MCP Demo Client for Privilege',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dynamic client registration failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const registered = await response.json();
  if (!registered.client_id) throw new Error('Dynamic client registration returned no client_id.');
  return registered;
}

async function discoverAuth() {
  const response = await fetch(state.config.mcpUrl, { method: 'GET' });
  const doorStatus = response.status;
  const bodyText = await response.text();
  let doorBody;
  try { doorBody = JSON.parse(bodyText); } catch { doorBody = bodyText.slice(0, 400); }
  const doorTrace = { method: 'GET', url: state.config.mcpUrl, status: response.status, headers: { 'www-authenticate': response.headers.get('www-authenticate') || undefined }, body: doorBody };
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = {};
  }

  const authHeader = response.headers.get('www-authenticate') || '';
  const authUriMatch = authHeader.match(/authorization_uri="([^"]+)"/);

  const authorizationUri = body.authorization_uri || (authUriMatch ? authUriMatch[1] : null);
  const tokenUri = body.token_uri || null;

  if (authorizationUri && tokenUri) {
    // The 401 body names the sign-in endpoints, but CIMD support (and dynamic registration) are advertised in the
    // authorization server metadata the same 401 points at, so read that first. If it cannot be read, the endpoints
    // from the body are still enough to sign in with a Client ID you typed.
    try {
      const viaResource = await discoverResourceMetadata(response, state.config.mcpUrl);
      if (viaResource) return { ...viaResource, doorStatus, doorTrace };
    } catch {
      // Fall back to the endpoints in the body.
    }
    return { authorizationUri, tokenUri, doorStatus, doorTrace };
  }

  // RFC 9728 resource-metadata discovery: from the 401's WWW-Authenticate when present,
  // otherwise straight from the well-known paths derived from the MCP URL (some servers
  // answer a GET on the MCP endpoint with a bare 405 instead of a discovery-capable 401).
  try {
    let viaResource = null;
    if (response.status === 401 || response.headers.get('www-authenticate')) {
      viaResource = await discoverResourceMetadata(response, state.config.mcpUrl);
    }
    if (!viaResource) {
      const probe = { headers: response.headers, status: 401 };
      viaResource = await discoverResourceMetadata(probe, state.config.mcpUrl);
    }
    if (viaResource) return { ...viaResource, doorStatus, doorTrace };
  } catch {
    // Fall through to the PingOne hosted pattern below.
  }

  // PingOne hosted remote MCP currently responds with plain 401 JSON
  // (no authorization_uri/token_uri), so infer endpoints from env OIDC metadata.
  try {
    const mcpUrl = new URL(state.config.mcpUrl);
    const envMatch = mcpUrl.pathname.match(/\/v1\/environments\/([0-9a-fA-F-]{36})\/mcp\/?$/);
    const envId = envMatch?.[1];
    const authHost = mcpUrl.host.startsWith('api.') ? mcpUrl.host.replace(/^api\./, 'auth.') : 'auth.pingone.com';
    if (envId) {
      const wellKnownUrl = `https://${authHost}/${envId}/as/.well-known/openid-configuration`;
      const metaResponse = await fetch(wellKnownUrl, { method: 'GET' });
      if (metaResponse.ok) {
        const meta = await metaResponse.json();
        if (meta.authorization_endpoint && meta.token_endpoint) {
          return {
            authorizationUri: meta.authorization_endpoint,
            tokenUri: meta.token_endpoint,
            doorStatus,
            doorTrace
          };
        }
      }
    }
  } catch {
    // Keep primary discovery error below.
  }

  throw new Error(
    `Failed to discover OAuth metadata from MCP URL. status=${response.status}, body=${bodyText.slice(0, 200)}`
  );
}

// The hops of one sign-in attempt, as far as the client can tell. One hop is one real API call or one decision, with
// the request and response as they happened for the page's detail box.
function recordSignInStart({ documentUrl, doorStatus, doorTrace, trace, cimdSupported, clientIdentity, redirectUri, authorizationUri }) {
  flow.reset();
  const door = new URL(state.config.mcpUrl);
  const path = (u) => { try { const x = new URL(u); return x.pathname; } catch { return u; } };
  const ident = {
    cimd: ['Uses its own document as client_id', 'nothing registered', `I will identify myself with my own document: ${state.config.clientId}. Nothing to register.`],
    dcr: ['Registers with the server', 'a new client record was created', `The server did not accept a document URL, so I registered and got the ID ${state.config.clientId}.`],
    manual: ['Uses the Client ID it was given', 'no document, no registration', `Using the Client ID you entered: ${state.config.clientId}.`]
  }[clientIdentity] || ['Identifies itself', '', ''];
  if (documentUrl) {
    flow.add({ kind: 'doc', lane: 'client', from: 'Client', to: 'Client', step: 1, title: 'Publishes its ID card', fact: `client_id is ${documentUrl}`, status: 'OK', tone: 'ok', say: 'My client ID is the address of this file. I register nothing.',
      detail: { request: { method: 'GET', url: documentUrl }, response: { status: 200, body: clientDocument(LAB_HOSTS) } } });
  }
  flow.add({ kind: 'door', lane: 'client', from: 'Client', to: 'Gateway', step: 3, title: 'Calls the door with no token', fact: `GET ${door.host}${door.pathname}  →  ${doorStatus || 401}`, status: String(doorStatus || 401), tone: 'warn', say: 'Calling the door with no token. It answers 401 and points at its sign-in metadata.',
    detail: doorTrace && { request: { method: doorTrace.method, url: doorTrace.url }, response: { status: doorTrace.status, headers: doorTrace.headers, body: doorTrace.body } } });
  if (trace?.resource) {
    const as = trace.resource.body?.authorization_servers?.[0] || '';
    flow.add({ kind: 'resource-metadata', lane: 'gateway', from: 'Client', to: 'Gateway', step: 3, title: 'Reads the resource metadata', fact: `GET ${path(trace.resource.url)}  →  ${trace.resource.status}`, status: 'OK', tone: 'ok', say: `Reading the metadata the 401 pointed at. It names the authorization server: ${as}.`,
      detail: { request: { method: trace.resource.method, url: trace.resource.url }, response: { status: trace.resource.status, body: trace.resource.body } } });
  }
  if (trace?.authorizationServer) {
    flow.add({ kind: 'as-metadata', lane: 'gateway', from: 'Client', to: 'Gateway', step: 3, title: 'Reads the authorization server metadata', fact: `GET ${path(trace.authorizationServer.url)}  →  ${trace.authorizationServer.status}`, status: cimdSupported ? 'CIMD yes' : 'CIMD no', tone: cimdSupported ? 'ok' : 'warn',
      say: cimdSupported ? 'The authorization server says it accepts a document URL as client ID: client_id_metadata_document_supported is true.' : 'The authorization server does not say it accepts document URLs.',
      detail: { request: { method: trace.authorizationServer.method, url: trace.authorizationServer.url }, response: { status: trace.authorizationServer.status, body: trace.authorizationServer.body } } });
  }
  flow.add({ kind: 'identity', lane: 'client', from: 'Client', to: 'Gateway', step: 3, title: ident[0], fact: ident[1], status: 'OK', tone: 'ok', say: ident[2] });
}

// The sign-in link as built: the browser follows it, so only the request is shown.
function recordSignInLink(authUrl) {
  const u = new URL(authUrl);
  flow.add({ kind: 'signin-start', lane: 'idp', from: 'Client', to: 'PingOne', step: 3, title: 'Sent to sign in', fact: `GET ${u.pathname} (the browser follows it)`, status: 'OK', tone: 'ok', say: 'Sending you to sign in. The gateway checks my document first, then PingOne asks for demouser and an MFA approval.',
    detail: { request: { method: 'GET', url: authUrl, body: Object.fromEntries(u.searchParams) }, note: 'The browser follows this link. The client cannot see the gateway fetching the document or the redirect to PingOne.' } });
}

async function handleStartAuth(req, res) {
  try {
    // Behind an ingress or the lab-proxy, the browser's own address is the right redirect (https on the
    // lab Host); the loopback build registers its own local address.
    const incoming = parseHost(req.headers.host);
    const redirectUri = incoming && !isLoopbackName(incoming.name) && incoming.name === [...LAB_HOSTS][0]
      ? `https://${incoming.name}/auth/callback`
      : `http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}/auth/callback`;
    const { authorizationUri, tokenUri, registrationUri, cimdSupported, scopes, doorStatus, doorTrace, trace } = await discoverAuth();
    // No client id set? Prefer CIMD: when the server accepts a client metadata document and this build
    // has a public address, the client_id is the URL of our own /client.json and nothing is registered.
    // Otherwise register with the server's RFC 7591 endpoint when it offers one (the SkyHigh Airline
    // Connector does; PingOne hosted MCP does not, so the manual id stays).
    let clientIdentity = 'manual';
    const documentUrl = cimdClientIdUrl(LAB_HOSTS);
    if (!state.config.clientId) {
      if (cimdSupported && documentUrl) {
        state.config.clientId = documentUrl;
        clientIdentity = 'cimd';
        emitEvent('oauth', { phase: 'cimd', clientId: documentUrl, registered: false });
      } else if (!registrationUri) {
        json(res, 400, { error: 'Client ID is required before auth start (the server offers no dynamic registration).' });
        return;
      } else {
        const registered = await dynamicallyRegister(registrationUri, redirectUri);
        state.config.clientId = registered.client_id;
        clientIdentity = 'dcr';
        if (Array.isArray(registered.redirect_uris) && registered.redirect_uris[0]) {
          state.config.registeredRedirectUri = registered.redirect_uris[0];
        }
        emitEvent('oauth', { phase: 'dcr', clientId: registered.client_id, clientName: registered.client_name || null });
      }
    } else if (documentUrl && state.config.clientId === documentUrl) {
      clientIdentity = 'cimd';
    }
    state.walk = { discovered: true, serverCimd: Boolean(cimdSupported), identity: clientIdentity, redirectUri };
    recordSignInStart({ documentUrl, doorStatus, doorTrace, trace, cimdSupported, clientIdentity, redirectUri, authorizationUri });
    const verifier = randomString(48);
    const challenge = sha256Base64Url(verifier);
    const oauthState = randomString(24);
    const authUrl = new URL(authorizationUri);
    authUrl.searchParams.set('client_id', state.config.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    // The resource document's scopes win when it names them (the connector wants mcp, not openid profile email).
    const effectiveScopes = scopes?.length ? scopes.join(' ') : state.config.scopes;
    authUrl.searchParams.set('scope', effectiveScopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', oauthState);

    state.pendingAuth = {
      oauthState,
      verifier,
      tokenUri,
      redirectUri,
      scope: effectiveScopes
    };

    recordSignInLink(authUrl.toString());

    emitEvent('oauth', {
      phase: 'start',
      authorizationUri,
      tokenUri,
      authUrl: authUrl.toString()
    });

    json(res, 200, { authUrl: authUrl.toString(), clientId: state.config.clientId, clientIdentity, scope: effectiveScopes });
  } catch (error) {
    emitEvent('error', { scope: 'oauth_start', message: error.message });
    json(res, 500, { error: error.message });
  }
}

// The two requests a CIMD server must refuse, sent to the configured door's authorize endpoint and shown on the
// page: a return address that is not in the client's document, and a document the admin has not listed.
// Never signs in; redirects are not followed.
async function handleCimdRefusals(req, res) {
  const documentUrl = cimdClientIdUrl(LAB_HOSTS);
  if (!documentUrl) {
    json(res, 409, { error: 'This copy has no public address, so it has no client document to test.' });
    return;
  }
  try {
    const { authorizationUri } = await discoverAuth();
    const probes = [
      { id: 'wrong-redirect', label: 'A return address that is not in the document', clientId: documentUrl, redirectUri: 'https://evil.example.com/cb' },
      { id: 'not-listed', label: 'A document the admin has not listed', clientId: 'https://example.com/not-listed.json', redirectUri: 'https://example.com/cb' }
    ];
    const results = [];
    for (const probe of probes) {
      const u = new URL(authorizationUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', probe.clientId);
      u.searchParams.set('redirect_uri', probe.redirectUri);
      u.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('state', 'cimd-refusal-check');
      const r = await fetch(u, { redirect: 'manual' });
      const text = (await r.text()).replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
      results.push({ id: probe.id, label: probe.label, clientId: probe.clientId, redirectUri: probe.redirectUri, requestUrl: u.toString(), status: r.status, refused: r.status >= 400, message: text });
    }
    flow.removeKinds(['refuse-wrong-redirect', 'refuse-not-listed']);
    for (const r of results) {
      flow.add({ kind: `refuse-${r.id}`, lane: 'gateway', from: 'Gateway', to: 'Client', step: 6, title: r.id === 'wrong-redirect' ? 'Refuses a wrong return address' : 'Refuses a document that is not listed', fact: `GET ${new URL(authorizationUri).pathname}  →  ${r.status}`, status: r.refused ? `Refused ${r.status}` : `NOT refused ${r.status}`, tone: r.refused ? 'ok' : 'bad', detail: { request: { method: 'GET', url: r.requestUrl, body: { client_id: r.clientId, redirect_uri: r.redirectUri } }, response: { status: r.status, body: r.message } }, say: r.refused ? `Refused (HTTP ${r.status}): ${r.label.toLowerCase()}. ${r.message}` : `NOT refused (HTTP ${r.status}): ${r.label.toLowerCase()}.` });
    }
    json(res, 200, { results });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleAuthCallback(req, res, parsedUrl) {
  const redirectWithError = (reason) => {
    const safeReason = encodeURIComponent((reason || 'OAuth callback failed').slice(0, 300));
    res.writeHead(302, { Location: `/?auth=error&reason=${safeReason}` });
    res.end();
  };

  try {
    const code = parsedUrl.searchParams.get('code');
    const incomingState = parsedUrl.searchParams.get('state');
    const error = parsedUrl.searchParams.get('error');
    const errorDescription = parsedUrl.searchParams.get('error_description');

    if (error) {
      const reason = errorDescription ? `${error}: ${errorDescription}` : error;
      emitEvent('oauth', { phase: 'callback_error', error: reason });
      redirectWithError(reason);
      return;
    }

    if (!state.pendingAuth || incomingState !== state.pendingAuth.oauthState) {
      throw new Error('OAuth state mismatch.');
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: state.pendingAuth.redirectUri,
      client_id: state.config.clientId,
      code_verifier: state.pendingAuth.verifier
    });
    if (state.pendingAuth.scope) tokenBody.set('scope', state.pendingAuth.scope);

    const tokenResponse = await fetch(state.pendingAuth.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody
    });
    const tokenText = await tokenResponse.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      throw new Error(`Token exchange returned non-JSON response: ${tokenText.slice(0, 300)}`);
    }
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${tokenText.slice(0, 300)}`);
    }

    state.oauth.accessToken = tokenData.access_token;
    state.oauth.refreshToken = tokenData.refresh_token || null;
    state.oauth.expiresAt = tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : null;
    state.pendingAuth = null;
    state.tools = [];
    state.mcpSession.initialized = false;
    state.mcpSession.protocolVersion = null;
    state.mcpSession.sessionId = null;

    emitEvent('oauth', {
      phase: 'token_success',
      expiresIn: tokenData.expires_in || null
    });

    flow.upsert('accepted', { lane: 'gateway', from: 'Gateway', to: 'Client', step: 4, title: 'Accepts the document and signs the user in', fact: 'it issued a code, so the document passed its checks', status: 'OK', tone: 'ok', say: 'Signed in. I issued a code, so the document passed my checks: it is on the approved list and the return address matches.' });
    flow.upsert('token', { lane: 'client', from: 'Client', to: 'Gateway', step: 5, title: 'Swaps the code for a token', fact: `POST ${new URL(tokenResponse.url).pathname}  →  ${tokenResponse.status} (PKCE, no secret)`, status: 'OK', tone: 'ok', say: 'Swapped the code for a token with PKCE. No client secret was involved.',
      detail: { request: { method: 'POST', url: tokenResponse.url, body: redactBody(Object.fromEntries(tokenBody)) }, response: { status: tokenResponse.status, body: redactBody(tokenData) } } });

    res.writeHead(302, { Location: '/?auth=success' });
    res.end();
  } catch (error) {
    emitEvent('error', { scope: 'oauth_callback', message: error.message });
    redirectWithError(error.message);
  }
}

async function handleListTools(req, res) {
  try {
    await ensureMcpSessionInitialized();
    const rpc = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/list',
      params: {}
    };
    let data;
    try {
      data = await fetchMcp(null, rpc, true);
    } catch (error) {
      if (error.message.includes('invalid during session initialization')) {
        state.mcpSession.initialized = false;
        await ensureMcpSessionInitialized();
        data = await fetchMcp(null, rpc, true);
      } else {
        throw error;
      }
    }
    state.tools = data.result?.tools || [];
    flow.upsert('tools', { lane: 'mcp', from: 'Client', to: 'MCP server', step: 5, title: 'Lists the tools', fact: `POST ${new URL(state.config.mcpUrl).pathname}  tools/list  →  ${state.tools.length} ${state.tools.length === 1 ? 'tool' : 'tools'}`, status: 'OK', tone: 'ok', say: state.tools.length ? `Tools: ${state.tools.map((t) => t.name).join(', ')}.` : 'The server returned no tools.',
      detail: { request: { method: 'POST', url: state.config.mcpUrl, headers: { authorization: 'Bearer [redacted]' }, body: { jsonrpc: '2.0', method: 'tools/list', params: {} } }, response: { status: 200, body: { result: { tools: state.tools.map((t) => ({ name: t.name, description: t.description })) } } } } });
    json(res, 200, { tools: state.tools });
  } catch (error) {
    // Signed in but refused: that is a result worth showing, once, on the run. Before sign-in there is nothing to report.
    if (state.oauth.accessToken) {
      const status = (error.message.match(/\b(\d{3})\b/) || [])[1] || 'error';
      flow.upsert('tools', { lane: 'mcp', from: 'Client', to: 'MCP server', step: 5, title: 'Tool list refused', fact: `POST ${new URL(state.config.mcpUrl).pathname}  tools/list  →  ${status}`, status: `Refused ${status}`, tone: 'bad', say: `The gateway refused the tools call (${error.message.trim()}). The client was accepted and the user signed in, but this call was not allowed.`,
        detail: { request: { method: 'POST', url: state.config.mcpUrl, headers: { authorization: 'Bearer [redacted]' }, body: { jsonrpc: '2.0', method: 'tools/list', params: {} } }, response: { status: Number(status) || undefined, body: error.message.trim() } } });
    }
    resetMcpRuntimeState();
    emitEvent('error', { scope: 'tools_list', message: error.message });
    json(res, 500, { error: error.message });
  }
}

async function handleCallTool(req, res) {
  try {
    await ensureMcpSessionInitialized();
    const body = await parseBody(req);
    const rpc = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: body.name,
        arguments: body.arguments || {}
      }
    };
    const data = await fetchMcp(null, rpc, true);
    json(res, 200, data);
  } catch (error) {
    emitEvent('error', { scope: 'tools_call', message: error.message });
    json(res, 500, { error: error.message });
  }
}

async function handleRawRpc(req, res) {
  try {
    const body = await parseBody(req);
    const method = body?.method || '';
    if (method && method !== 'initialize' && method !== 'notifications/initialized') {
      await ensureMcpSessionInitialized();
    }
    const data = await fetchMcp(null, body, true);
    json(res, 200, data);
  } catch (error) {
    if (error.message.includes('401') || error.message.includes('502')) {
      resetMcpRuntimeState();
    }
    emitEvent('error', { scope: 'raw_rpc', message: error.message });
    json(res, 500, { error: error.message });
  }
}

async function handleLlmChat(req, res) {
  try {
    const body = await parseBody(req);
    if (!state.config.llmUrl || !state.config.llmModel) {
      json(res, 400, { error: 'LLM URL and model are required.' });
      return;
    }

    const parsed = await callLocalLlm([
      {
        role: 'system',
        content:
          'You are assisting an MCP operator. Use provided tools metadata to suggest exact tool calls when possible.'
      },
      {
        role: 'user',
        content: `${body.message}\n\nAvailable tools:\n${JSON.stringify(state.tools, null, 2)}`
      }
    ]);
    json(res, 200, {
      response: readLlmReply(parsed),
      path: state.mode === 'real' ? 'PRIVILEGE (governed lane)' : llmPath(state.config.llmUrl)
    });
  } catch (error) {
    emitEvent('error', { scope: 'llm_chat', message: error.message });
    json(res, 500, { error: error.message });
  }
}

async function callLocalLlm(messages) {
  if (!state.config.llmUrl || !state.config.llmModel) {
    throw new Error('LLM URL and model are required.');
  }

  const { url, init } = buildLlmRequest(state.config, messages, LLM_API_KEY);
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = JSON.parse(text);
  if (!response.ok) {
    throw new Error(`LLM call failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return parsed;
}

async function handleDemoChat(req, res) {
  try {
    const body = await parseBody(req);
    const prompt = body.prompt || '';
    const steps = [];

    if (!state.config.mcpUrl) {
      json(res, 400, { error: 'Set MCP URL first.', steps });
      return;
    }

    if (!state.config.clientId) {
      json(res, 200, {
        reply:
          'I can connect, but OAuth Client ID is missing. Set Client ID and click Start OAuth to continue.',
        steps: [...steps, 'missing_client_id']
      });
      return;
    }

    if (!state.oauth.accessToken) {
      const { authorizationUri, tokenUri, registrationUri, scopes } = await discoverAuth();
      if (!state.config.clientId) {
        if (!registrationUri) {
          json(res, 200, {
            reply: 'I can connect, but OAuth Client ID is missing and the server offers no dynamic registration. Set Client ID and try again.',
            steps: [...steps, 'missing_client_id']
          });
          return;
        }
        const registered = await dynamicallyRegister(registrationUri, `http://127.0.0.1:${PORT}/auth/callback`);
        state.config.clientId = registered.client_id;
        emitEvent('oauth', { phase: 'dcr', clientId: registered.client_id, clientName: registered.client_name || null });
      }
      const verifier = randomString(48);
      const challenge = sha256Base64Url(verifier);
      const oauthState = randomString(24);
      // Behind an ingress or the lab-proxy, the browser's own address is the right redirect (https on the
    // lab Host); the loopback build registers its own local address.
    const incoming = parseHost(req.headers.host);
    const redirectUri = incoming && !isLoopbackName(incoming.name) && incoming.name === [...LAB_HOSTS][0]
      ? `https://${incoming.name}/auth/callback`
      : `http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}/auth/callback`;
      const effectiveScopes = scopes?.length ? scopes.join(' ') : state.config.scopes;
      const authUrl = new URL(authorizationUri);
      authUrl.searchParams.set('client_id', state.config.clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('scope', effectiveScopes);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', oauthState);

      state.pendingAuth = { oauthState, verifier, tokenUri, redirectUri, scope: effectiveScopes };
      json(res, 200, {
        reply: 'Please complete OAuth login first. I prepared the auth URL.',
        authUrl: authUrl.toString(),
        steps: [...steps, 'oauth_required']
      });
      return;
    }

    await ensureMcpSessionInitialized();
    steps.push('mcp_initialized');

    const toolsResponse = await fetchMcp(
      null,
      {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/list',
        params: {}
      },
      true
    );
    state.tools = toolsResponse.result?.tools || [];
    steps.push(`tools_discovered:${state.tools.length}`);

    let reply = `Connected. I found ${state.tools.length} tools.`;
    let suggestions = [];
    try {
      const llm = await callLocalLlm([
        {
          role: 'system',
          content:
            'You are an MCP tool router for demos. Given a user prompt and available tools, return JSON only with shape: {"reply":"...","suggested_tools":[{"name":"tool_name","why":"...","arguments":{}}]}. Use only tool names from the list.'
        },
        {
          role: 'user',
          content: `User prompt:\n${prompt}\n\nAvailable tools:\n${JSON.stringify(
            state.tools.map((t) => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.inputSchema || {}
            })),
            null,
            2
          )}`
        }
      ]);
      const raw = readLlmReply(llm);
      const parsed = parseLlmRouterJson(raw);
      reply = parsed.reply || reply;
      suggestions = Array.isArray(parsed.suggested_tools) ? parsed.suggested_tools : [];
      steps.push('llm_routed');
    } catch (llmError) {
      suggestions = state.tools.map((tool) => ({
        name: tool.name,
        why: 'Fallback: showing discovered tools because LLM router output was not valid JSON.',
        arguments: {}
      }));
      steps.push(`llm_fallback:${llmError.message}`);
    }

    json(res, 200, {
      reply,
      tools: state.tools.map((t) => ({ name: t.name, description: t.description || '' })),
      suggested_tools: suggestions,
      steps
    });
  } catch (error) {
    if (error.message.includes('401') || error.message.includes('502')) {
      resetMcpRuntimeState();
    }
    emitEvent('error', { scope: 'demo_chat', message: error.message });
    json(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  // First, before any route: a Host outside the set (DNS rebinding) and a cross-origin write are refused (safety.js).
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // Health is public and read-only. Cluster probes call it with a pod-IP Host, so it sits before the host check.
  if (req.method === 'GET' && parsedUrl.pathname === '/api/health') {
    json(res, 200, {
      schema: 'demo-health/1',
      at: nowIso(),
      state: 'ready',
      runtime: process.env.LLM_API_KEY ? 'live' : 'offline',
      demo: { id: 'mcp-demo-client-privilege', name: 'MCP Demo Client for Privilege', version: '1.0.0' }
    }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (!hostAllowed(req.headers.host, LAB_HOSTS, PORT)) {
    json(res, 421, { error: 'bad_host', message: 'this server answers loopback Host headers and its lab-proxy name only' });
    return;
  }
  if (!writeAllowed(req.method, req.headers, LAB_HOSTS, PORT)) {
    json(res, 403, { error: 'bad_origin', message: 'this server accepts same-origin writes only' });
    return;
  }

  // The CIMD document a server fetches to learn who this client is. Only the hosted build (public
  // lab Host name) has one; on loopback it falls through to the static files and answers 404.
  if (req.method === 'GET' && parsedUrl.pathname === '/client.json') {
    const doc = clientDocument(LAB_HOSTS);
    if (doc) {
      json(res, 200, doc, { 'Cache-Control': 'public, max-age=300' });
      return;
    }
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/shelf') {
    json(res, 200, shelfInfo(process.env), { 'Cache-Control': 'no-store' });
    return;
  }

  // Rule 19 (mode toggle): what the UI asks before offering Real. Real (the governed
  // Privilege LLM lane) is available only when the virtual key is set and the configured
  // LLM URL is a lane URL.
  if (req.method === 'GET' && parsedUrl.pathname === '/api/info') {
    const realAvailable = Boolean(LLM_API_KEY) && /\/llm\//.test(state.config.llmUrl || '');
    json(res, 200, {
      mode: state.mode,
      source: state.mode === 'real' ? 'real' : 'mock',
      realAvailable,
      setupGuideUrl: setupGuideUrl(process.env),
      realReason: realAvailable
        ? undefined
        : 'Real needs the Privilege LLM lane: set LLM_API_KEY and point the LLM URL at <gateway>/llm/<provider>.'
    }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/mode') {
    const body = await parseBody(req);
    const wanted = body.source || body.mode;
    if (wanted !== 'mock' && wanted !== 'real') {
      json(res, 400, { error: 'the only accepted body is { "source": "mock" | "real" }' });
      return;
    }
    const realAvailable = Boolean(LLM_API_KEY) && /\/llm\//.test(state.config.llmUrl || '');
    if (wanted === 'real' && !realAvailable) {
      json(res, 409, {
        error: 'real_not_available',
        message: 'Real needs the Privilege LLM lane: set LLM_API_KEY and point the LLM URL at <gateway>/llm/<provider>.'
      });
      return;
    }
    state.mode = wanted;
    emitEvent('mode', { mode: state.mode });
    json(res, 200, { ok: true, mode: state.mode });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache'
    });
    res.write('\n');
    state.eventClients.add(res);
    req.on('close', () => state.eventClients.delete(res));
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/state') {
    json(res, 200, {
      config: state.config,
      oauth: {
        authenticated: Boolean(state.oauth.accessToken),
        expiresAt: state.oauth.expiresAt
      },
      tools: state.tools,
      walk: state.walk,
      flow: flow.list(),
      cimdDocumentUrl: cimdClientIdUrl(LAB_HOSTS)
    });
    return;
  }

  // Reset: back to a clean "start the demo" state without restarting the pod. Clears the run (hops), the sign-in,
  // the tools and the MCP session. Keeps the settings (MCP URL, model) and the Mock/Real choice.
  if (req.method === 'POST' && parsedUrl.pathname === '/api/reset') {
    Object.assign(state.oauth, { accessToken: null, refreshToken: null, expiresAt: null });
    state.pendingAuth = null;
    resetMcpRuntimeState();
    state.walk = { discovered: false, serverCimd: null, identity: null, redirectUri: null };
    if (state.config.clientId && state.config.clientId === cimdClientIdUrl(LAB_HOSTS)) state.config.clientId = '';
    flow.reset();
    emitEvent('reset', {});
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/config') {
    try {
      const body = await parseBody(req);
      state.config = {
        ...state.config,
        ...body
      };
      state.config.mcpUrl = gatewayMcpUrl(state.config.mcpUrl);
      state.tools = [];
      state.mcpSession.initialized = false;
      state.mcpSession.protocolVersion = null;
      state.mcpSession.sessionId = null;
      emitEvent('config', { config: state.config });
      json(res, 200, { ok: true, config: state.config });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/start') {
    await handleStartAuth(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/cimd/refusals') {
    await handleCimdRefusals(req, res);
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/auth/callback') {
    await handleAuthCallback(req, res, parsedUrl);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/tools/list') {
    await handleListTools(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/tools/call') {
    await handleCallTool(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/mcp/rpc') {
    await handleRawRpc(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/llm/chat') {
    await handleLlmChat(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/demo/chat') {
    await handleDemoChat(req, res);
    return;
  }

  if (req.method === 'GET') {
    const filePath = sanitizeFilePath(parsedUrl.pathname);
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': getMime(filePath) });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`MCP Demo Client running on http://${HOST}:${PORT}`);
  console.log('Open this URL in your browser and configure your MCP gateway.');
});
