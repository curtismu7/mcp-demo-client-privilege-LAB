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

---

## If the Privilege desktop agent shows "unregistered"

The PingOne Privilege **desktop app** (the one serving the local console at
`https://local.procyon.ai:8643`) stays registered with the Ping cloud through a background
agent (`ping-helper`). When that agent's device record is deleted or unapproved on the cloud
side, every Privilege app on this machine loses Real mode: the local console stops serving,
connections time out, and the desktop app shows the agent as **unregistered**.

### How to tell this is what happened

1. **The desktop app says the agent is unregistered** (banner or the agent status panel), or its
   diagnostics print `✖ Found N errors` with `Device … not found`.
2. **The local console is down with it**: `https://local.procyon.ai:8643` does not answer
   (connection refused / timeout) even though the PingOne Privilege app is running.
3. **The agent log loops on one error.** Check `/Library/Logs/Procyon/procyon-agent.log`:

   ```
   Error getting the device: HTTP error: 500 Internal Server Error
   Body: { "error": "Device <base64-id> not found", "code": 2, ... }
   ```

   repeated every ~2 seconds. That single line is the tell: the agent is asking the cloud
   about a device record the cloud no longer has. (A one-off is harmless — it is the endless
   repetition that means unregistered.)

### Why it happens

- The cloud side **deletes or disables the device record** (an admin action in the console, a
  tenant sync, or a guard tripping after network churn). The agent cannot re-create it by
  itself: it re-registers only on an enable/disable cycle, and re-registration **waits for a
  human to approve the new device** in the console.
- Network/VPN blips to `privilege.pingone.com` (`lookup … no such host` in the same log) force
  re-registrations and can churn the device identity, making the window for this bigger.

### How to fix it

1. Open the **PingOne Privilege** desktop app and make sure it is running.
2. Sign in to the **cloud console**: `https://console.pingone.com/?env=<your-privilege-env-id>`
   → launch **PingOne Privilege** → open the **Devices** page.
3. Find this machine's device (`DeviceName: mac-…`, type MAC). It is either:
   - **pending approval** — click **Approve** (the agent's certificate request is waiting;
     this is the usual state after a delete), or
   - **missing entirely** — in the desktop app toggle the agent **off and on** (or quit and
     reopen the app) so it mints a fresh certificate request, then approve it in the console.
4. The agent picks up the approval within seconds (watch
   `/Library/Logs/Procyon/procyon-agent.log` for `Device registered with controller`), and the
   local console at `local.procyon.ai:8643` starts serving again. Real mode in this app works
   immediately after — no restart of the app needed.

### If it comes back

The device being deleted repeatedly is a **console-side action** (admin, sync sweep, or a
server-side guard after repeated network drops). Note the times from
`grep "Delete request recieved" /Library/Logs/Procyon/procyon-agent*.log` and raise it with
 whoever administers the Privilege tenant — re-approving treats the symptom; the deletes have
 to stop for it to stay fixed.
