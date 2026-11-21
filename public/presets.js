// The doors this demo client knows. Each preset fills in the whole connection:
// the door address (MCP URL) and the scopes the door expects, so picking one
// and pressing Sign In is the whole setup. The first preset is the default the
// page starts on when nothing has been configured yet.
export const DEFAULT_PRESET_ID = 'banking-a2a';

export const MCP_PRESETS = [
  {
    id: 'banking-a2a',
    label: 'Banking agent tools (a2a-mcp-tools)',
    mcpUrl: 'https://mcpgw-pingid.ai-demo.ping-devops.com/a2a-mcp-tools/mcp/',
    scopes: 'openid profile email'
  },
  {
    id: 'banking-opensearch',
    label: 'Banking search and logs (opensearch-mcp-server)',
    mcpUrl: 'https://mcpgw-pingid.ai-demo.ping-devops.com/opensearch-mcp-server/mcp/',
    scopes: 'openid profile email'
  },
  {
    id: 'pingone-admin',
    label: 'PingOne admin (pingone-mcp-server-2)',
    mcpUrl: 'https://mcpgw-pingid.ai-demo.ping-devops.com/pingone-mcp-server-2/mcp/',
    scopes: 'openid profile email'
  },
  {
    id: 'banking-opensearch-mcpgw',
    label: 'Banking search via mcpgw (opensearch)',
    mcpUrl: 'https://mcpgw.ai-demo.ping-devops.com/opensearch/mcp/',
    scopes: 'openid profile email'
  }
];

export function findPreset(id) {
  return MCP_PRESETS.find(p => p.id === id) || null;
}

// Which preset, if any, a configured URL matches. Custom addresses match nothing.
export function presetForUrl(url) {
  const u = String(url ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return MCP_PRESETS.find(p => p.mcpUrl.replace(/\/+$/, '').toLowerCase() === u) || null;
}
