import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PRESETS, DEFAULT_PRESET_ID, findPreset, presetForUrl } from './presets.js';

test('the default preset exists and is first', () => {
  assert.equal(MCP_PRESETS[0].id, DEFAULT_PRESET_ID);
  assert.equal(findPreset(DEFAULT_PRESET_ID), MCP_PRESETS[0]);
});

test('every preset is a complete connection: https door and scopes', () => {
  for (const p of MCP_PRESETS) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    assert.ok(p.label);
    const u = new URL(p.mcpUrl);
    assert.equal(u.protocol, 'https:');
    assert.match(u.pathname, /\/mcp\/$/);
    assert.ok(p.scopes.includes('openid'));
  }
});

test('presetForUrl matches the preset address with or without the trailing slash', () => {
  for (const p of MCP_PRESETS) {
    assert.equal(presetForUrl(p.mcpUrl)?.id, p.id, p.mcpUrl);
    assert.equal(presetForUrl(p.mcpUrl.replace(/\/+$/, ''))?.id, p.id);
  }
});

test('a custom door matches no preset', () => {
  assert.equal(presetForUrl('https://other.example.invalid/mcp/'), null);
  assert.equal(presetForUrl(''), null);
  assert.equal(presetForUrl(undefined), null);
});

test('preset ids are unique', () => {
  assert.equal(new Set(MCP_PRESETS.map(p => p.id)).size, MCP_PRESETS.length);
});
