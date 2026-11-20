// The one-page CIMD walkthrough: six numbered steps above the working panels. It only reads state the server
// already keeps (/api/state), the client's own document (/client.json) and one probe endpoint, so a page
// reload after sign-in still shows how the client identified itself. All text from servers goes in as text.

const IDENTITY_TEXT = {
  cimd: 'CIMD: the client_id is this app\'s own document URL. Nothing was registered.',
  dcr: 'Dynamic registration: the server did not accept a document URL, so the client registered and got an ID.',
  manual: 'The Client ID you typed was used. No document and no registration.'
};

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

function chip(text, tone) {
  return el('span', { class: `walk-chip walk-chip--${tone}`, text });
}

export function mountWalkthrough({ api, startSignIn, refreshTools, inputs }) {
  const body = (n) => document.querySelector(`#walk${n}Body`);
  let documentLoaded = false;
  let last = null;

  async function renderDocument() {
    const target = body(1);
    try {
      const r = await fetch('/client.json', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('none');
      const doc = await r.json();
      documentLoaded = true;
      target.replaceChildren(
        el('div', { class: 'walk-kv' }, el('span', { text: 'client_id' }), el('code', { class: 'walk-hot', text: doc.client_id })),
        el('div', { class: 'walk-kv' }, el('span', { text: 'redirect_uris' }), el('code', { text: (doc.redirect_uris || []).join(', ') })),
        el('div', { class: 'walk-kv' }, el('span', { text: 'auth method' }), el('code', { text: `${doc.token_endpoint_auth_method} (no secret)` }))
      );
    } catch {
      target.replaceChildren(el('p', { class: 'walk-note', text: 'This copy has no public address, so it has no document and cannot use CIMD. It registers instead.' }));
    }
  }

  // Step 2: a mirror of the MCP URL field, so the first steps fit on one screen.
  const mcp = el('input', { id: 'walkMcpUrl', 'aria-label': 'MCP URL', placeholder: 'https://<gateway>/<door>/mcp/' });
  let idChip = el('span');
  const clearBtn = el('button', { type: 'button', text: 'Clear Client ID' });
  clearBtn.addEventListener('click', () => { inputs.clientId.value = ''; inputs.clientId.dispatchEvent(new Event('input', { bubbles: true })); render(); });
  mcp.addEventListener('input', () => { inputs.mcpUrl.value = mcp.value; });
  inputs.mcpUrl.addEventListener('input', () => { mcp.value = inputs.mcpUrl.value; });
  inputs.clientId.addEventListener('input', () => render());
  body(2).replaceChildren(el('label', {}, 'MCP URL', mcp), el('div', { class: 'walk-row' }, idChip, clearBtn));

  // Step 3
  const signInBtn = el('button', { type: 'button', text: 'Sign in' });
  signInBtn.addEventListener('click', () => startSignIn());
  const identity = el('p', { class: 'walk-note' });
  body(3).replaceChildren(el('div', { class: 'walk-row' }, signInBtn), identity);

  // Step 4
  const checklist = el('ul', { class: 'walk-checks' });
  body(4).replaceChildren(checklist);

  // Step 5
  let authChip = el('span');
  const toolList = el('div', { class: 'walk-tools' });
  const refreshBtn = el('button', { type: 'button', text: 'Refresh tools' });
  refreshBtn.addEventListener('click', () => refreshTools());
  body(5).replaceChildren(el('div', { class: 'walk-row' }, authChip, refreshBtn), toolList);

  // Step 6
  const refuseBtn = el('button', { type: 'button', text: 'Try the two refusals' });
  const refuseOut = el('div', { class: 'walk-refusals', 'aria-live': 'polite' });
  refuseBtn.addEventListener('click', async () => {
    refuseBtn.disabled = true;
    refuseOut.replaceChildren(el('p', { class: 'walk-note', text: 'Asking the gateway…' }));
    try {
      const data = await api('/api/cimd/refusals', { method: 'POST' });
      refuseOut.replaceChildren(...data.results.map((r) => el('div', { class: 'walk-refusal' },
        el('div', { class: 'walk-row' }, chip(r.refused ? `Refused: HTTP ${r.status}` : `NOT refused: HTTP ${r.status}`, r.refused ? 'ok' : 'bad'), el('strong', { text: r.label })),
        el('code', { text: `client_id ${r.clientId}` }),
        el('code', { text: `redirect_uri ${r.redirectUri}` }),
        el('p', { class: 'walk-note', text: r.message || '(no message)' })
      )));
    } catch (error) {
      refuseOut.replaceChildren(el('p', { class: 'walk-note', text: `Could not run the checks: ${error.message}` }));
    } finally {
      refuseBtn.disabled = false;
    }
  });
  body(6).replaceChildren(el('div', { class: 'walk-row' }, refuseBtn), refuseOut);

  function check(text, done) {
    return el('li', {}, chip(done ? 'Done' : 'Waiting', done ? 'ok' : 'wait'), el('span', { text }));
  }

  function render() {
    const s = last;
    if (!s) return;
    if (document.activeElement !== mcp) mcp.value = inputs.mcpUrl.value;
    const typed = inputs.clientId.value.trim() !== '' && inputs.clientId.value.trim() !== (s.cimdDocumentUrl || '');
    idChip.replaceWith(idChip = typed
      ? chip('Client ID is filled in, so it is used instead', 'warn')
      : chip('Client ID is empty: uses its own document', 'ok'));
    clearBtn.hidden = !typed;

    const w = s.walk || {};
    identity.textContent = w.identity ? IDENTITY_TEXT[w.identity] || '' : 'Not signed in yet.';
    checklist.replaceChildren(
      check('The door answered 401 and pointed at its sign-in metadata', Boolean(w.discovered)),
      check('The gateway said it accepts a document URL as client ID', w.serverCimd === true),
      check('The client used its own document URL, and registered nothing', w.identity === 'cimd'),
      check('The gateway accepted the document, signed the user in and issued a token', Boolean(s.oauth?.authenticated) && w.identity === 'cimd')
    );

    authChip.replaceWith(authChip = s.oauth?.authenticated ? chip('Signed in: has a token', 'ok') : chip('Not signed in', 'wait'));
    toolList.replaceChildren(...(s.tools || []).map((t) => el('span', { class: 'walk-tool', text: t.name })));
    if (!(s.tools || []).length) toolList.replaceChildren(el('p', { class: 'walk-note', text: 'No tools yet.' }));
  }

  return {
    // Tools are listed after the page loads (and after sign-in), so follow every refresh.
    setTools(tools) {
      if (last) { last = { ...last, tools }; render(); }
    },
    async update(state) {
      last = state;
      if (!documentLoaded) await renderDocument();
      render();
    }
  };
}
