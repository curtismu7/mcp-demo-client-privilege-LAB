import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayMcpUrl } from './mcpUrl.js';

test('adds the slash to a one-segment gateway path', () => {
  assert.equal(gatewayMcpUrl('https://mcp-gateway.example.invalid/mcp'), 'https://mcp-gateway.example.invalid/mcp/');
  assert.equal(gatewayMcpUrl('https://mcp-gateway.example.invalid/opensearch-mcp-server'), 'https://mcp-gateway.example.invalid/opensearch-mcp-server/');
  assert.equal(gatewayMcpUrl('https://mcp-gateway.example.invalid/mcp?x=1'), 'https://mcp-gateway.example.invalid/mcp/?x=1');
});

test('leaves other URLs alone', () => {
  for (const u of [
    'https://mcp-gateway.example.invalid/mcp/',
    'https://mcp-gateway.example.invalid/orders/mcp',
    'https://api.example.invalid/v1/environments/00000000-0000-0000-0000-000000000000/mcp',
    'https://mcp-gateway.example.invalid/',
    'not a url',
    ''
  ]) assert.equal(gatewayMcpUrl(u), u);
  assert.equal(gatewayMcpUrl(undefined), undefined);
});
