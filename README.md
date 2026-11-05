# MCP Demo Client for Privilege LAB

Tier: Demo

Repo: https://github.com/curtismu7/mcp-demo-client-privilege-LAB


Chat-first local MCP demo client for protected MCP demos behind a PingOne Privilege gateway.

## Run from a clone

Prerequisites: Node 26. Docker (OrbStack) only for the Docker form.

```
git clone https://github.com/curtismu7/mcp-demo-client-privilege-LAB.git
cd mcp-demo-client-privilege-LAB
npm ci
npm run build
npm run doctor
npm start
```

## Ports, and what to do if the port is taken

```
Ports: mcp-demo-client-privilege-LAB listens on 6884 (set with PORT, default 6884).
Port range for this app: 6880-6889.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:6884 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
```

Other variable: `None` (Docker host port). Keep both inside 6880-6889.

## Features

- Claude-style chat UI for protected MCP exploration
- OAuth 2.0 PKCE login with local callback
- Auto-discovers MCP tools in real time (5-second refresh)
- Local LLM tool routing via Ollama
- Raw MCP RPC and direct tool call inspector
- Clear 401/502/OAuth error messages for demos
- PingOne remote MCP OAuth auto-discovery fallback

## Run instantly

```bash
npm start
```

Then open: **http://127.0.0.1:6884**

## Register this OAuth callback

```
http://127.0.0.1:6884/auth/callback
```

## Requirements

- Node.js 18+
- Optional: Ollama at `http://127.0.0.1:11434` with model `llama3.2:1b`

## Setup

1. Set **MCP URL** = your Privilege gateway (e.g. `https://mcp-gateway.example.invalid/mcp`)
2. Set **OAuth Client ID** = your app's client ID
3. Click **Sign In**
4. Ask anything in chat — the LLM picks and explains the right tools

## LLM

| Setting | Default |
|---|---|
| LLM URL | `http://127.0.0.1:11434` |
| LLM Model | `llama3.2:1b` |

Falls back to showing all discovered tools if LLM is unavailable.

## PingOne remote MCP pattern

If protecting `https://api.pingone.com/v1/environments/<envId>/mcp`:
- Gateway backend → that URL
- Client MCP URL → `https://<gateway>/mcp`

## Files

| File | Purpose |
|---|---|
| `server.js` | OAuth, MCP relay, chat, LLM routing |
| `public/index.html` | UI layout |
| `public/app.js` | Chat, auto-refresh, tool rendering |
| `public/styles.css` | Dark chat-first theme |
| `SKILLS.md` | Fast deployment guide for AI tools |

## Routing the LLM through the PingOne Agent Privilege

By default the chat/router LLM is a local Ollama (`http://127.0.0.1:11434`, native `/api/chat`).
To govern it, set **LLM URL** in the UI to a Privilege lane, for example
`https://<gateway>/llm/custom/v1`, **LLM model** to a model the lane's key allows (`llama.cpp`),
and start the client with the lane's virtual key in the environment:

```bash
LLM_API_KEY=<virtual key> npm start
```

A `/llm/...` URL is called OpenAI-compatibly with `Authorization: Bearer $LLM_API_KEY`; the
`/api/llm/chat` response includes `path` (`PRIVILEGE` or `direct (NOT governed by Privilege)`).
The key is read from the environment only and is never returned by the config API.
