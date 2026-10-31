# MCP Demo Client for Privilege

Chat-first local MCP demo client for protected MCP demos behind a PingOne Privilege gateway.

## Run and test

```sh
npm install
npm test
```

## Rules that bite

- No real tenant ids, client ids, customer names or internal hostnames. Use `.example` or `.invalid` hosts only.
- Never commit `.env` files or keys. Copy `.env.example` and fill it in locally.
- Mock mode works fully offline. Live mode is optional.
