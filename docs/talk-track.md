# Talk track — MCP Demo Client (Privilege) LAB

Four minutes. Say first: "Mock mode simulates only the chat model. Sign-in, tokens and MCP calls go to whatever MCP URL you configure — and they are real when that is a real gateway. This is a demo of CIMD: the client signs in with a document URL, not a registration."

1. **The client's document.** Point at the OAuth Client ID field: "Not needed with CIMD. The ID is the address of the client's document — this page serves its own at `/client.json`. No Dynamic Client Registration anywhere."
2. **Point it at a gateway.** Set the MCP URL in the connection sidebar (presets dropdown has the usual doors). "This is the door on the gateway — the only address the client knows."
3. **Sign in.** Click **Sign In**. "Sign-in stays in this tab and comes straight back — no pop-up dance."
4. **What the gateway did.** Walk the movie reel, one frame per hop: the 401 from the door, both `.well-known` fetches, the token exchange. "Each frame names its actors and one fact. Click a frame and you get the real request and response — with the tokens redacted. The gateway's inner checks are only ever stated as what its answer implies; I am not claiming to see inside it."
5. **Token and tools.** "Tools from `tools/list` appear on the right. Ask the chat to list them — the pre-filled prompt does exactly that. Advanced: raw MCP JSON-RPC, a direct tool call, and a local LLM lane if Ollama is running."
6. **What it refuses.** Click the refusals action. "Two requests that must fail: a client document at the wrong return address, and one not on the gateway's allow-list. This is the payoff — what the gateway checks and what it refuses."
7. **Run-observability honesty.** Point at the run panel. "Every mock row says it was simulated by the lab's mock, not read from a product log. Real rows say which log line they came from. Missing layers say so instead of being guessed."

## When it breaks

- 401 at the door → wrong MCP URL or door; 502 → gateway down; no tools → scope on the door; LLM grayed → no Ollama / no lane key. Full table in `SKILLS.md`.
- The recorded demo video (`docs/demo-video/`) ends with the gateway refusing the agent's tools call — a Privilege authorization policy gap, unrelated to CIMD. Say that up front if you show the mp4.
