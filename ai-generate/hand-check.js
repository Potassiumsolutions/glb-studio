/* ==========================================================================
   Hand check — counts the fingers on each hand of a freshly generated character.
   ------------------------------------------------------------------------------
   Picture-to-3D AI sometimes returns a hand with an extra or a missing finger, and
   the person has already paid fal.ai for that model. This runs right after the
   model arrives (in the browser, no cost) so they find out before rigging it.
   For a character with the arms held away from the body (T- / A-pose — what the
   Generate tab asks for):
     1) the WRIST = the narrowest cross-section near the end of each arm;
     2) the HAND = the surface past the wrist (flood-filled from the wrist ring);
     3) digit TIPS = the Character Rigger's own rules (character-rigger/index.html,
        fitHandsFromMesh): local maxima of the walking distance from the wrist, merged
        when they belong to one digit, kept only where the skin around them forms a
        narrow tube (a finger) rather than a broad patch (a knuckle, a cuff).
   Returns { ok, hands:[{side, digits, extra}], note }: ok:false ONLY when two independent readings both
   see extra fingers on a hand (false alarms on good models are worse than none); ok:null = unreadable.
   Pure geometry: positions (Float32Array xyz) + triangle indices (Uint32Array or null).
   ========================================================================== */
(function (root) {
  'use strict';
  function graph(P, I) {                                   // welded vertex graph (CSR) with edge lengths
    const n = P.length / 3, key = new Map(), rep = new Int32Array(n), reps = [];
    for (let v = 0; v < n; v++) { const k = P[v*3].toFixed(5) + ',' + P[v*3+1].toFixed(5) + ',' + P[v*3+2].toFixed(5);
      let r = key.get(k); if (r === undefined) { r = v; key.set(k, v); reps.push(v); } rep[v] = r; }
    const nt = I ? I.length / 3 : n / 3, tri = t => I ? [rep[I[t*3]], rep[I[t*3+1]], rep[I[t*3+2]]] : [rep[t*3], rep[t*3+1], rep[t*3+2]];
    const deg = new Int32Array(n); for (let t = 0; t < nt; t++) { const [a, b, c] = tri(t); deg[a] += 2; deg[b] += 2; deg[c] += 2; }
    const start = new Int32Array(n + 1); for (let v = 0; v < n; v++) start[v+1] = start[v] + deg[v];
    const nbr = new Int32Array(start[n]), fill = new Int32Array(n);
    const link = (a, b) => { nbr[start[a] + fill[a]++] = b; };
    for (let t = 0; t < nt; t++) { const [a, b, c] = tri(t); link(a, b); link(a, c); link(b, a); link(b, c); link(c, a); link(c, b); }
    return { n, reps, start, nbr, fill }; }
  function dijkstra(G, P, seeds, mask) {
    const d = new Float64Array(G.n).fill(Infinity), hc = [], hv = [];
    const push = (c, v) => { hc.push(c); hv.push(v); let i = hc.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= hc[i]) break; [hc[p], hc[i]] = [hc[i], hc[p]]; [hv[p], hv[i]] = [hv[i], hv[p]]; i = p; } };
    const pop = () => { const c = hc[0], v = hv[0], lc = hc.pop(), lv = hv.pop(); if (hc.length) { hc[0] = lc; hv[0] = lv; let i = 0; for (;;) { const l = 2*i+1, r = l+1; let m = i; if (l < hc.length && hc[l] < hc[m]) m = l; if (r < hc.length && hc[r] < hc[m]) m = r; if (m === i) break; [hc[m], hc[i]] = [hc[i], hc[m]]; [hv[m], hv[i]] = [hv[i], hv[m]]; i = m; } } return [c, v]; };
    for (const s of seeds) { d[s] = 0; push(0, s); }
    while (hc.length) { const [c, v] = pop(); if (c > d[v]) continue;
      for (let i = G.start[v]; i < G.start[v] + G.fill[v]; i++) { const u = G.nbr[i]; if (!mask[u]) continue;
        const w = c + Math.hypot(P[u*3]-P[v*3], P[u*3+1]-P[v*3+1], P[u*3+2]-P[v*3+2]); if (w < d[u]) { d[u] = w; push(w, u); } } }
    return d; }
  const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]], dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2], len = a => Math.hypot(a[0], a[1], a[2]);
  function checkHands(P, I) {
    const n = P.length / 3; if (n < 500) return { ok: null, hands: [], note: 'too few vertices' };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let v = 0; v < n; v++) { const x = P[v*3], y = P[v*3+1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const H = y1 - y0, cx = (x0 + x1) / 2; if (!(H > 0)) return { ok: null, hands: [], note: 'flat model' };
    if ((x1 - x0) < 0.55 * H) return { ok: null, hands: [], note: 'arms are not held out — hands not checked' };
    const G = graph(P, I), pv = v => [P[v*3], P[v*3+1], P[v*3+2]];
    const hands = [];
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'right' : 'left', reach = s < 0 ? cx - x0 : x1 - cx, out = v => s * (P[v*3] - cx);
      // 1) wrist: the narrowest slice of the arm between 22% and 6% of the height in from the fingertips
      const arm = G.reps.filter(v => out(v) > reach - 0.30 * H);
      const slice = (x, w) => arm.filter(v => Math.abs(out(v) - x) < w);
      const sw0 = 0.004 * H;
      // Two independent readings of the same hand — a false alarm ("your model is broken" on a good model) is worse than none, so a
      // hand is only FLAGGED when both see extra fingers. A: the wrist at the arm's narrowest slice. B: the count most wrist positions
      // along the forearm agree on (a cuff or gauntlet can be narrower than the real wrist, which fools A on its own).
      let A = null, bestSz = Infinity, bestX = null;
      for (let x = reach - 0.22 * H; x <= reach - 0.06 * H; x += 0.005 * H) { const S = slice(x, sw0); if (S.length < 6) continue;
        let ya = Infinity, yb = -Infinity, za = Infinity, zb = -Infinity; for (const v of S) { const p = pv(v); ya = Math.min(ya, p[1]); yb = Math.max(yb, p[1]); za = Math.min(za, p[2]); zb = Math.max(zb, p[2]); }
        const sz = (yb - ya) + (zb - za); if (sz < bestSz) { bestSz = sz; bestX = x; } }
      if (bestX != null) A = countFrom(slice(bestX, sw0), bestX);
      const votes = []; for (const off of [0.07, 0.09, 0.11, 0.13, 0.15, 0.17]) { const S = slice(reach - off * H, sw0); if (S.length < 6) continue; const r = countFrom(S, reach - off * H); if (r != null) votes.push(r); }
      let B = null; if (votes.length >= 2) { const tally = {}; for (const v of votes) tally[v] = (tally[v] || 0) + 1;
        const [top, cnt] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]; if (cnt >= Math.ceil(votes.length / 2)) B = +top; }
      const extra = A != null && B != null && A >= 6 && B >= 6;
      hands.push({ side, digits: extra ? Math.min(A, B) : (A === 5 || B === 5 ? 5 : null), extra, a: A, b: B, votes }); continue;
      function countFrom(S0, bx) { const best = { x: bx, S: S0 };
      const cen = S => { const c = [0, 0, 0]; for (const v of S) { const p = pv(v); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return c.map(q => q / S.length); };
      const W = cen(best.S), back = slice(best.x - 0.08 * H, sw0 * 2); const E = back.length >= 6 ? cen(back) : [W[0] - s * 0.08 * H, W[1], W[2]];
      let ax = sub(W, E); const al = len(ax) || 1; ax = ax.map(q => q / al);
      const along = v => dot(sub(pv(v), W), ax), perp = v => { const d = sub(pv(v), W), a = dot(d, ax); return len([d[0]-ax[0]*a, d[1]-ax[1]*a, d[2]-ax[2]*a]); };
      // 2) the hand: pieces past the wrist ring (Rigger rules: main piece on the forearm line + pieces the same ring cuts)
      const sw = Math.max(0.006 * H, sw0 * 1.5), slab = [], inSlab = new Uint8Array(G.n);
      for (const v of arm) if (Math.abs(along(v)) < sw && perp(v) < 0.08 * H) { slab.push(v); inSlab[v] = 1; }
      const ok = v => along(v) > -sw && len(sub(pv(v), W)) < 0.25 * H;
      const seen = new Uint8Array(G.n), comps = [];
      for (const r0 of slab) { if (seen[r0] || !ok(r0)) continue; const comp = [r0]; seen[r0] = 1;
        for (let k = 0; k < comp.length; k++) { const u = comp[k]; for (let i = G.start[u]; i < G.start[u] + G.fill[u]; i++) { const w = G.nbr[i]; if (!seen[w] && ok(w)) { seen[w] = 1; comp.push(w); } } }
        const c = cen(comp); let far = 0; for (const v of comp) far = Math.max(far, along(v));
        const d = sub(c, W), a = dot(d, ax), cp = len([d[0]-ax[0]*a, d[1]-ax[1]*a, d[2]-ax[2]*a]);
        const sp = comp.filter(v => inSlab[v]).map(perp).sort((p, q) => p - q);
        comps.push({ comp, med: sp[sp.length >> 1] || 0, mx: sp[sp.length - 1] || 0, onLine: cp < 0.05 * H && far > 0.03 * H }); }
      const main = comps.filter(o => o.onLine).sort((a, b) => b.comp.length - a.comp.length)[0] || comps.sort((a, b) => b.comp.length - a.comp.length)[0];
      if (!main) return null;
      const mask = new Uint8Array(G.n), hv = [], seeds = [];
      for (const o of comps) { if (o !== main && !(o.med < 2.0 * main.med && o.mx >= 0.75 * main.med)) continue;
        for (const v of o.comp) { mask[v] = 1; hv.push(v); if (inSlab[v]) seeds.push(v); } }
      const g = dijkstra(G, P, seeds, mask); let gmax = 0; for (const v of hv) if (g[v] < Infinity && g[v] > gmax) gmax = g[v];
      if (!(gmax > 0.03 * H)) return null;
      // 3) digit tips (Rigger rules)
      const cand = [];
      for (const v of hv) { const gv = g[v]; if (!(gv >= 0.35 * gmax) || gv === Infinity) continue; let top = true;
        for (let i = G.start[v]; i < G.start[v] + G.fill[v]; i++) { const w = G.nbr[i]; if (mask[w] && g[w] > gv) { top = false; break; } } if (top) cand.push(v); }
      cand.sort((a, b) => g[b] - g[a]);
      { let dmax = 0, amax = 0; for (const v of cand) { dmax = Math.max(dmax, len(sub(pv(v), W))); amax = Math.max(amax, along(v)); }
        for (let k = cand.length - 1; k >= 0; k--) { const v = cand[k]; if (len(sub(pv(v), W)) < 0.40 * dmax || along(v) < 0.15 * amax) cand.splice(k, 1); } }
      const tips = [];
      for (const v of cand) { if (tips.length >= 9) break; const p = pv(v);
        if (tips.some(t => { if (t.d[v] < 0.22 * gmax) return true; let u = sub(t.p, W); const ul = len(u) || 1; u = u.map(q => q / ul); const d = sub(p, t.p), a = dot(d, u);
            return len(d) < 0.07 * gmax || len([d[0]-u[0]*a, d[1]-u[1]*a, d[2]-u[2]*a]) < 0.03 * gmax; })) continue;
        const d = dijkstra(G, P, [v], mask), l = 0.25 * g[v], rv = [];
        for (const u of hv) if (Math.abs(d[u] - l) < 0.05 * g[v]) rv.push(u);
        if (rv.length >= 4) { const c = cen(rv); let r = 0; for (const u of rv) r += len(sub(pv(u), c)); if (r / rv.length > 0.6 * l) continue; }
        tips.push({ v, p, d }); }
      return tips.length >= 3 ? tips.length : null; } }
    const bad = hands.filter(h => h.extra), read = hands.filter(h => h.digits != null);
    if (bad.length) return { ok: false, hands, note: (bad.length === 2 ? "both hands don't look right" : `the ${bad[0].side} hand doesn't look right`) + ' — too many finger tips: an extra finger, or a torn, spiky shape' };
    if (!read.length) return { ok: null, hands, note: 'hands could not be read' };
    return { ok: true, hands, note: 'no extra fingers found' }; }
  const API = { checkHands };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.HandCheck = API;
})(typeof self !== 'undefined' ? self : this);
