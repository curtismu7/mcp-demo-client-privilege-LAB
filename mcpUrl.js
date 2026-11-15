// A Privilege gateway (v1.261112 and later) answers 404 to a one-segment path
// without a trailing slash (/mcp, /<app>) and serves the same path with one.
// Users paste the bare form, so add the slash. Longer paths (/<app>/mcp, the
// PingOne /v1/environments/<id>/mcp) and anything that is not a URL pass through.
export function gatewayMcpUrl(raw) {
  if (typeof raw !== 'string') return raw;
  let u;
  try { u = new URL(raw.trim()); } catch { return raw; }
  if (!/^\/[A-Za-z0-9_-]+$/.test(u.pathname)) return raw;
  u.pathname += '/';
  return u.toString();
}
