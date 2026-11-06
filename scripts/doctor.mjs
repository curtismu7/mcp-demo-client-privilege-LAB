// Preflight: node version, port free, and that the server answers /api/health with demo-health/1.
// Prints only pass/fail lines. Exit 1 on any failure. No outbound network.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 6884;
const MAJOR = Number(process.versions.node.split('.')[0]);
let failed = 0;
const report = (level, name, detail) => { if (level === 'fail') failed++; console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`); };

report(MAJOR >= 26 ? 'pass' : 'fail', 'node', `v${process.versions.node} (need >= 26)`);

await new Promise((resolve) => {
const s = net.createServer();
s.once('error', () => resolve());
s.listen(PORT, '127.0.0.1', () => s.close(() => { report('pass', 'port-free', `${PORT} is free`); resolve(); }));
});

await Promise.race([
  fetch(`http://127.0.0.1:${PORT}/api/health`)
    .then(async (r) => {
      const body = await r.json();
      if (body.schema === 'demo-health/1' && body.state) report('pass', 'health', `/api/health answers demo-health/1, state=${body.state}`);
      else report('fail', 'health', `/api/health answered but not demo-health/1: ${JSON.stringify(body).slice(0, 120)}`);
    })
    .catch((e) => { report('fail', 'health', `/api/health unreachable (${e.message}). Is the server running? npm start`); }),
  new Promise((resolve) => setTimeout(() => { report('fail', 'health', 'timed out'); resolve(); }, 3000))
]);

process.exit(failed ? 1 : 0);
