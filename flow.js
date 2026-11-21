// The run as a list of hops, kept on the server so the page can draw it as a chat and a movie reel, and so it
// survives the sign-in redirect and a reload. One hop is one arrow between two actors. Everything here is what the
// client itself saw or can tell; the gateway's inner checks are only ever stated as what its answer implies.
export function createFlow(max = 40) {
  let hops = [];
  const renumber = () => hops.forEach((h, i) => { h.n = i + 1; });
  return {
    reset() { hops = []; },
    add(h) {
      hops.push({ at: new Date().toISOString(), ...h });
      if (hops.length > max) hops.shift();
      renumber();
      return hops.at(-1);
    },
    // Replace the hop of this kind if there is one, else add it. The tools list is polled every few seconds and must
    // not add a frame each time.
    upsert(kind, h) {
      const i = hops.findIndex((x) => x.kind === kind);
      if (i < 0) return this.add({ kind, ...h });
      hops[i] = { ...hops[i], ...h, kind };
      renumber();
      return hops[i];
    },
    removeKinds(kinds) { hops = hops.filter((h) => !kinds.includes(h.kind)); renumber(); },
    list() { return hops.map((h) => ({ ...h })); }
  };
}

// Tokens, codes, secrets and verifiers never go into a hop in full. A short value (test fixtures, short-lived
// codes) is fully redacted; a long one keeps a few characters at each end so a viewer can see it's a real,
// distinct value without the value itself being usable.
const SECRETISH = /(^|_)(token|code|secret|verifier|password|assertion)$/i;
export function redactValue(v) {
  const s = String(v);
  if (s.length <= 10) return '[redacted]';
  return `${s.slice(0, 6)}…${s.slice(-4)} [redacted]`;
}
export function redactBody(value) {
  if (Array.isArray(value)) return value.map(redactBody);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRETISH.test(k) && v ? redactValue(v) : redactBody(v)]));
  }
  return value;
}
