// CIMD (OAuth Client ID Metadata Document): instead of registering with a server, a client
// uses the https URL of a JSON document it hosts as its client_id. The server fetches the
// document, so the URL has to be reachable from the server: only the hosted build (which has a
// public lab Host name) can do this; the loopback build cannot, and keeps using registration.
import { isLoopbackName } from './safety.js';

export const CLIENT_NAME = 'MCP Demo Client for Privilege';

// The public name this lab answers to (the first LAB_ALLOWED_HOSTS entry), or null on loopback.
export function labPublicHost(labHosts) {
  const first = [...labHosts][0];
  return first && !isLoopbackName(first) ? first : null;
}

// The document's own URL, which is also the client_id. Null when this build has no public name.
export function cimdClientIdUrl(labHosts) {
  const host = labPublicHost(labHosts);
  return host ? `https://${host}/client.json` : null;
}

// The document a server reads. client_id must equal the URL it was fetched from, and a public
// document can hold no secret, so the auth method is 'none' (PKCE protects the code).
export function clientDocument(labHosts) {
  const host = labPublicHost(labHosts);
  if (!host) return null;
  return {
    client_id: `https://${host}/client.json`,
    client_name: CLIENT_NAME,
    client_uri: `https://${host}/`,
    redirect_uris: [`https://${host}/auth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
}

// Does this authorization server accept a document URL as client_id for a public client?
// Same test a connector applies: the flag is true and 'none' is an allowed token auth method.
export function serverSupportsCimd(asMeta) {
  return asMeta?.client_id_metadata_document_supported === true
    && Array.isArray(asMeta.token_endpoint_auth_methods_supported)
    && asMeta.token_endpoint_auth_methods_supported.includes('none');
}
