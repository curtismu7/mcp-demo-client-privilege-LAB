// floatingPanel: drag, 8-direction resize, keyboard move/resize, and a remembered position for the
// hop-detail box — the FloatingDialog behaviour (STANDALONE-UI-PATTERNS §8d) for this lab's plain-JS pages.
// The state machine is a port of shared/floating-dialog/useFloatingPanel.js (React) onto vanilla DOM;
// the pure maths come from the vendored geometry.js (byte-pinned, shared/floating-dialog). The markup and
// CSS classes follow FloatingDialog.jsx and floating-dialog.css: .fd-panel, .fd-titlebar, .fd-handle-*.
// At 600px and below floating-dialog.css turns the panel into a bottom sheet and drag/resize are off.
import { MARGIN, clampSize, clampToViewport, keyboardStep, resizeRect } from "./floating-dialog/geometry.js";

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

function readStored(storageKey) {
  if (!storageKey) return null;
  try {
    const s = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    return s && typeof s === "object" ? s : null;
  } catch { return null; }
}

/**
 * Wire a .fd-panel element up as a floating dialog.
 * @param panel the .fd-panel element (position: fixed; geometry applied as --fd-x/y/w/h custom properties)
 * @param opts { storageKey?, minW?, minH?, onClose? } — storageKey remembers position and size
 */
export function floatingPanel(panel, { storageKey = null, minW = 280, minH = 180, onClose = null } = {}) {
  const titlebar = panel.querySelector(".fd-titlebar");
  const narrow = () => window.matchMedia("(max-width: 600px)").matches;

  // A saved size is validated and clamped to min..viewport; a saved position is clamped so that size fits.
  const saved = readStored(storageKey);
  const initial = () => {
    const vp = viewport();
    const sz = clampSize(saved?.size, { w: minW, h: minH }, vp) || { w: Math.min(420, Math.max(minW, vp.w - 2 * MARGIN)), h: null };
    const p = saved?.pos && Number.isFinite(saved.pos.x) && Number.isFinite(saved.pos.y)
      ? clampToViewport(saved.pos, sz, vp)
      : { x: Math.max(MARGIN, Math.round((vp.w - sz.w) / 2)), y: Math.max(MARGIN, Math.round(vp.h * 0.12)) };
    return { sz, p };
  };
  const first = initial();
  let pos = first.p;
  let size = first.sz;
  if (saved?.size && size.h == null && panel.dataset.autoheight !== "false") size.h = null;

  const apply = () => {
    panel.dataset.placement = panel.dataset.placement || "center";
    panel.style.setProperty("--fd-x", `${pos.x}px`);
    panel.style.setProperty("--fd-y", `${pos.y}px`);
    panel.style.setProperty("--fd-w", `${size.w}px`);
    panel.style.setProperty("--fd-h", size.h == null ? "auto" : `${size.h}px`);
    panel.dataset.autoheight = size.h == null ? "true" : "false";
  };
  apply();

  const save = () => {
    if (!storageKey) return;
    try { window.localStorage.setItem(storageKey, JSON.stringify({ pos, size })); } catch { /* private window or blocked storage */ }
  };

  const measuredSize = () => (size.h != null ? size : { w: size.w, h: panel.getBoundingClientRect().height || minH });

  // In-flight pointer tracking, torn down on pointerup even if the panel closed mid-drag.
  let active = null;
  const stop = () => {
    if (!active) return;
    active.target.removeEventListener("pointermove", active.onMove);
    active.target.removeEventListener("pointerup", active.onUp);
    active.target.removeEventListener("pointercancel", active.onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    active = null;
  };
  const track = (target, onMove) => {
    stop();
    const onUp = () => { stop(); save(); };
    document.body.style.userSelect = "none";
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
    active = { target, onMove, onUp };
  };

  // Drag from the title bar; buttons inside it keep their own clicks.
  const onDragStart = (e) => {
    if (narrow() || e.button !== 0) return;
    if (e.target.closest("button, input, textarea, select, a")) return;
    e.preventDefault();
    const offX = e.clientX - pos.x;
    const offY = e.clientY - pos.y;
    if (e.currentTarget.setPointerCapture && e.pointerId != null) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic event */ } }
    track(e.currentTarget, (ev) => { pos = { x: ev.clientX - offX, y: ev.clientY - offY }; apply(); });
  };

  // 8-direction resize: n, ne, e, se, s, sw, w, nw.
  const onResizeStart = (e, dir = "se") => {
    if (narrow() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: pos.x, y: pos.y, w: size.w, h: measuredSize().h };
    const sx = e.clientX;
    const sy = e.clientY;
    document.body.style.cursor = `${dir}-resize`;
    track(document, (ev) => {
      const r = resizeRect(start, dir, ev.clientX - sx, ev.clientY - sy, { w: minW, h: minH });
      size = { w: r.w, h: r.h };
      pos = { x: r.x, y: r.y };
      apply();
    });
  };

  // Keyboard on the focused title bar: arrows move (Shift = farther), Alt+arrows resize.
  const onKey = (e) => {
    if (narrow() || e.target !== titlebar) return false;
    const step = keyboardStep(e.key, e);
    if (!step) return false;
    e.preventDefault();
    if (step.kind === "move") {
      pos = clampToViewport({ x: pos.x + step.dx, y: pos.y + step.dy }, measuredSize(), viewport());
    } else {
      const sz = measuredSize();
      const r = resizeRect({ x: pos.x, y: pos.y, w: sz.w, h: sz.h }, "se", step.dx, step.dy, { w: minW, h: minH });
      const vp = viewport();
      size = { w: Math.min(r.w, Math.max(minW, vp.w - pos.x - MARGIN)), h: Math.min(r.h, Math.max(minH, vp.h - pos.y - MARGIN)) };
    }
    apply();
    save();
    return true;
  };

  if (titlebar) {
    titlebar.addEventListener("pointerdown", onDragStart);
    titlebar.addEventListener("keydown", onKey);
    titlebar.tabIndex = 0;
    titlebar.setAttribute("aria-label", `Move ${panel.getAttribute("aria-label") || "dialog"}`);
  }
  for (const dir of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
    const handle = document.createElement("div");
    handle.className = `fd-handle fd-handle-${dir}`;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (e) => onResizeStart(e, dir));
    panel.append(handle);
  }
  panel.tabIndex = -1;
  // Focus comes in on the title bar; Escape closes.
  titlebar?.focus();
  const onPanelKey = (e) => {
    if (e.key === "Escape" && onClose) { e.stopPropagation(); onClose(); }
  };
  panel.addEventListener("keydown", onPanelKey);

  // The 600px breakpoint flips between sheet and floating panel; re-apply the geometry on the way back.
  const mq = window.matchMedia("(max-width: 600px)");
  const onMq = () => apply();
  mq.addEventListener?.("change", onMq);

  return {
    close() {
      mq.removeEventListener?.("change", onMq);
      stop();
    }
  };
}
