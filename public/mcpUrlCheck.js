// The page ships with a placeholder MCP address on the reserved .invalid domain, which can never resolve.
// Nothing should be asked of it, so the page stays quiet until a real MCP URL is set.
export function isPlaceholderMcpUrl(raw) {
  try {
    const host = new URL(String(raw ?? '').trim()).hostname.toLowerCase();
    return host === 'invalid' || host.endsWith('.invalid');
  } catch {
    return true; // empty or not a URL: nothing to ask
  }
}
