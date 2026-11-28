// Talk track: toggle the side panel; content loads once from /api/talk-track. Behaviour matches the
// ping-services-stub panel (family pattern): drag by the heading, pop out to a real window. Nothing
// here talks to a gateway.
import { floatingPanel } from './floatingPanel.js';

let loaded = false;
let panelApi = null;

function popOut(body) {
  const win = window.open('', 'mcpdcp-talk-track-' + Date.now(), 'width=520,height=640');
  if (!win) return;
  win.document.write('<!doctype html><html><head><title>Talk track</title><style>body{font-family:sans-serif;white-space:pre-wrap;padding:1rem}</style></head><body>' + body.innerHTML + '</body></html>');
  win.document.close();
}

export function initTalkTrack() {
  const btn = document.getElementById('talktrack-btn');
  const panel = document.getElementById('talktrack-panel');
  if (!btn || !panel) return;

  const show = () => {
    panel.hidden = false;
    btn.setAttribute('aria-pressed', 'true');
    if (!panelApi) panelApi = floatingPanel(panel, { storageKey: 'mcpdcp.talkTrack' });
    if (!loaded) {
      loaded = true;
      fetch('/api/talk-track')
        .then((r) => (r.ok ? r.text() : 'No talk track.'))
        .then((t) => { document.getElementById('talktrack-body').textContent = t; })
        .catch(() => { document.getElementById('talktrack-body').textContent = 'No talk track.'; });
    }
  };
  const hide = () => {
    panel.hidden = true;
    btn.setAttribute('aria-pressed', 'false');
  };

  btn.addEventListener('click', () => (panel.hidden ? show() : hide()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) hide(); });

  const pop = document.createElement('button');
  pop.type = 'button';
  pop.textContent = 'Pop out';
  pop.setAttribute('data-testid', 'talk-track-popout');
  pop.style.cssText = 'position:absolute;top:.5rem;right:.5rem;';
  panel.appendChild(pop);
  let popWin = null;
  pop.addEventListener('click', () => {
    if (popWin && !popWin.closed) { popWin.focus(); return; }
    popOut(document.getElementById('talktrack-body'));
  });
  window.addEventListener('beforeunload', () => { if (popWin && !popWin.closed) popWin.close(); });
}
