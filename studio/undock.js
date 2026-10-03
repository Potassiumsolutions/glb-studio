/* ==========================================================================
   Undock — move a panel (a tool's left menu, the Studio's top bar) into its OWN browser window, so it can be dragged onto
   another monitor and the main window keeps all its room for the 3D view. Closing that window docks the panel back.
   ------------------------------------------------------------------------------
   The panel's elements are MOVED (document.adoptNode), not copied, so every button, slider and handler keeps working.
   The page's own lookups (document.getElementById / querySelector / querySelectorAll) are widened to also search the
   undocked windows, so code that finds its controls by id still finds them while they live elsewhere.
     Undock.toggle(el, {key, title, width, height, onChange(isOut)})   Undock.isOut(key)   Undock.dock(key)
   LAYOUT MEMORY (Paul: 'hit a button and it returns the menu locations to the saved ones'): a page registers its undockable
   panels (Undock.register) and any other panel state (Undock.registerState); Undock.state() reports which are out and where
   their windows sit (screen position + size, across monitors), Undock.apply(state) puts them back. Opening a window on another
   monitor needs Chrome's one-time 'manage windows' permission (Undock.askScreens()); a browser may allow only ONE new window per
   click, so apply() returns the panels it could not open yet and the caller asks for another click.
   2026-10-02 (Paul: "dock and undockable … able to be moved to other monitors").
   ========================================================================== */
(function () {
  'use strict';
  if (window.Undock) return;
  const open = {};                                   // key → {win, el, holder, opt}
  const docs = () => Object.values(open).map(o => { try { return o.win.closed ? null : o.win.document; } catch (e) { return null; } }).filter(Boolean);
  // widen the page's element lookups to the undocked windows (patched once, only searches further when a panel is out)
  const D = document, gid = D.getElementById.bind(D), qs = D.querySelector.bind(D), qsa = D.querySelectorAll.bind(D);
  D.getElementById = id => gid(id) || (docs().map(d => d.getElementById(id)).find(Boolean) || null);
  D.querySelector = s => qs(s) || (docs().map(d => d.querySelector(s)).find(Boolean) || null);
  D.querySelectorAll = s => { const ds = docs(); if (!ds.length) return qsa(s); const a = [...qsa(s)]; for (const d of ds) a.push(...d.querySelectorAll(s)); return a; };
  // Drags and shortcuts: a panel's code often listens for pointermove / pointerup / keydown on the MAIN window (a node drag, a wire
  // drop). Events in an undocked window are re-sent to the main document, and elementFromPoint answers from the window the
  // pointer is in, so those handlers keep working.
  let ptrDoc = D; const efp = D.elementFromPoint.bind(D);
  D.elementFromPoint = (x, y) => (ptrDoc !== D && docs().includes(ptrDoc)) ? ptrDoc.elementFromPoint(x, y) : efp(x, y);
  D.addEventListener('pointermove', () => { ptrDoc = D; }, true); D.addEventListener('pointerdown', () => { ptrDoc = D; }, true);
  const FWD = ['pointermove', 'pointerup', 'pointercancel', 'mousemove', 'mouseup'];
  const editable = t => t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  function forward(win) { const d = win.document;
    for (const ty of FWD) win.addEventListener(ty, e => { ptrDoc = d; try { D.dispatchEvent(new e.constructor(ty, e)); } catch (_) {} });
    win.addEventListener('pointerdown', () => { ptrDoc = d; }, true);
    for (const ty of ['keydown', 'keyup']) win.addEventListener(ty, e => { if (editable(e.target)) return; try { D.dispatchEvent(new KeyboardEvent(ty, e)); } catch (_) {} });
  }
  const nudge = () => { try { window.dispatchEvent(new Event('resize')); } catch (e) {} };
  function dock(key) {
    const o = open[key]; if (!o) return; delete open[key]; clearInterval(o.poll);
    try { o.holder.parentNode.insertBefore(D.adoptNode(o.el), o.holder); } catch (e) { console.warn('[undock] dock', e); }
    o.holder.remove(); o.el.classList.remove('undocked');
    try { if (!o.win.closed) o.win.close(); } catch (e) {}
    o.opt.onChange && o.opt.onChange(false); nudge();
  }
  function undock(el, opt) {
    const key = opt.key; if (open[key]) return open[key].win;
    const pl = opt.place || null;   // {x, y, w, h} from a saved layout (screen coordinates, any monitor)
    const W = Math.round(pl ? pl.w : (opt.width || 420)), H = Math.round(pl ? pl.h : (opt.height || Math.min(screen.availHeight || 900, 1000)));
    const L = Math.round(pl ? pl.x : (screen.availLeft || 0) + 40), T = Math.round(pl ? pl.y : (screen.availTop || 0) + 40);
    const win = window.open('', 'ksol_undock_' + key, `popup=yes,width=${W},height=${H},left=${L},top=${T}`);
    if (!win) { if (!opt.quiet) alert('Your browser blocked the new window. Allow pop-ups for this site to undock panels.'); return null; }
    if (pl) { try { win.moveTo(L, T); win.resizeTo(Math.round(pl.ow || W), Math.round(pl.oh || H)); } catch (e) {} }
    const d = win.document; d.open();
    d.write('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>'); d.close();
    d.title = opt.title || 'GLB Studio panel';
    // bring the page's look along: every stylesheet + the root's attributes (theme), and a body that scrolls
    for (const n of D.querySelectorAll('style, link[rel="stylesheet"]')) d.head.appendChild(d.importNode(n, true));
    for (const a of D.documentElement.attributes) d.documentElement.setAttribute(a.name, a.value);
    d.body.className = D.body.className;
    const st = d.createElement('style');
    st.textContent = 'html,body{height:100%;margin:0;overflow:auto;background:' + getComputedStyle(D.body).backgroundColor + '}' +
      '.undocked{width:auto!important;min-width:0!important;max-width:none!important;height:auto!important;min-height:100%;border:0!important;box-sizing:border-box}' +
      '.undock-btn .ud-out{display:none}.undock-btn .ud-in{display:inline}';
    d.head.appendChild(st);
    const holder = D.createComment('undocked: ' + key); el.parentNode.insertBefore(holder, el);
    el.classList.add('undocked'); d.body.appendChild(d.adoptNode(el));
    const o = open[key] = { win, el, holder, opt }; forward(win);
    win.addEventListener('pagehide', () => dock(key));
    o.poll = setInterval(() => { if (win.closed) dock(key); }, 700);   // belt and braces: some closes skip pagehide
    opt.onChange && opt.onChange(true); nudge(); win.focus();
    return win;
  }
  window.addEventListener('pagehide', () => { for (const k of Object.keys(open)) { try { open[k].win.close(); } catch (e) {} } });
  // ---- layout memory ----
  const reg = {}, regState = {};
  function state() { const panels = {}, extra = {};
    for (const k of Object.keys(reg)) { const o = open[k]; if (!o) { panels[k] = { out: false }; continue; }
      let g = {}; try { const w = o.win; g = { x: w.screenX, y: w.screenY, w: w.innerWidth, h: w.innerHeight, ow: w.outerWidth, oh: w.outerHeight }; } catch (e) {}
      panels[k] = Object.assign({ out: true }, g); }
    for (const k of Object.keys(regState)) { try { extra[k] = regState[k].get(); } catch (e) {} }
    return { panels, extra }; }
  function apply(st) { const blocked = []; if (!st) return blocked;
    for (const [k, v] of Object.entries(st.extra || {})) { try { regState[k] && regState[k].set(v); } catch (e) {} }
    for (const [k, p] of Object.entries(st.panels || {})) { const r = reg[k]; if (!r) continue;
      if (!p.out) { if (open[k]) dock(k); continue; }
      if (open[k]) { try { open[k].win.moveTo(p.x, p.y); open[k].win.resizeTo(p.ow || p.w, p.oh || p.h); } catch (e) {} continue; }
      const el = typeof r.el === 'function' ? r.el() : r.el; if (!el) continue;
      if (!undock(el, Object.assign({}, r.opt, { place: p, quiet: true }))) blocked.push(k); }
    return blocked; }
  // Chrome: placing windows on OTHER monitors needs the Window Management permission (asked once, on a click)
  async function askScreens() { try { if (window.getScreenDetails) await window.getScreenDetails(); return true; } catch (e) { return false; } }
  window.Undock = {
    toggle: (el, opt) => open[opt.key] ? (dock(opt.key), false) : !!undock(el, opt),
    undock, dock, isOut: key => !!open[key],
    register: (key, el, opt) => { reg[key] = { el, opt: Object.assign({ key }, opt) }; },
    registerState: (key, get, set) => { regState[key] = { get, set }; },
    state, apply, askScreens,
  };
})();
