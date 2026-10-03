/* ==========================================================================
   Parts check — finds pieces of a generated model that are NOT attached to the body.
   ------------------------------------------------------------------------------
   Picture-to-3D AI sometimes adds stray geometry: a duplicated leg floating behind a
   creature, specks hanging in space. They are separate pieces of the mesh (no shared
   surface with the body), so they can be found exactly: weld vertices by position,
   flood-fill the triangles into connected pieces, keep the biggest one as the body.
   A piece is flagged when it is FLOATING (a gap to the body bigger than 1.5 % of the
   model's height) or a SPECK (under 0.2 % of the triangles). Pieces that touch the body
   (separately modelled eyes, teeth, horns) are left alone.
   Returns { ok, pieces:[{tris, pct, gapPct, centre, floating, speck}], flagged, removeTris(Set) }.
   Pure geometry: positions (Float32Array xyz) + triangle indices (Uint32Array or null).
   ========================================================================== */
(function (root) {
  'use strict';
  function check(P, I, opt) {
    opt = opt || {};
    const n = P.length / 3, nt = I ? I.length / 3 : n / 3;
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) { const x = P[v*3+k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    const H = Math.max(1e-9, hi[1] - lo[1]), span = Math.max(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]) || 1, q = span * 1e-5;
    // weld by position (glTF splits vertices at UV seams)
    const key = new Map(), rep = new Int32Array(n);
    for (let v = 0; v < n; v++) { const k = Math.round(P[v*3]/q) + ',' + Math.round(P[v*3+1]/q) + ',' + Math.round(P[v*3+2]/q);
      let r = key.get(k); if (r === undefined) { r = v; key.set(k, v); } rep[v] = r; }
    const par = new Int32Array(n); for (let v = 0; v < n; v++) par[v] = v;
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
    const tv = t => I ? [rep[I[t*3]], rep[I[t*3+1]], rep[I[t*3+2]]] : [rep[t*3], rep[t*3+1], rep[t*3+2]];
    for (let t = 0; t < nt; t++) { const [a, b, c] = tv(t); join(a, b); join(a, c); }
    const tri = new Int32Array(nt), count = new Map();
    for (let t = 0; t < nt; t++) { const r = find(tv(t)[0]); tri[t] = r; count.set(r, (count.get(r) || 0) + 1); }
    const ids = [...count.keys()].sort((a, b) => count.get(b) - count.get(a)); const main = ids[0];
    // body sample points (for the gap) + per-piece boxes
    const pts = new Map(); for (let t = 0; t < nt; t++) { const r = tri[t]; let a = pts.get(r); if (!a) pts.set(r, a = []); if (a.length < 6000 || r !== main) a.push(tv(t)[0]); }
    const bodyPts = pts.get(main).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 3000)) === 0);
    const pieces = [];
    for (const r of ids) {
      const vs = pts.get(r), c = [0, 0, 0]; for (const v of vs) for (let k = 0; k < 3; k++) c[k] += P[v*3+k] / vs.length;
      let gap = 0;
      if (r !== main) { gap = 1e9; const sample = vs.filter((_, i) => i % Math.max(1, Math.floor(vs.length / 200)) === 0);
        for (const v of sample) for (const b of bodyPts) { const dx = P[v*3]-P[b*3], dy = P[v*3+1]-P[b*3+1], dz = P[v*3+2]-P[b*3+2], d = dx*dx+dy*dy+dz*dz; if (d < gap) gap = d; }
        gap = Math.sqrt(gap); }
      const pct = 100 * count.get(r) / nt, gapPct = 100 * gap / H;
      pieces.push({ root: r, tris: count.get(r), pct: +pct.toFixed(2), gapPct: +gapPct.toFixed(1), centre: c.map(x => +x.toFixed(3)),
        body: r === main, floating: r !== main && gapPct > (opt.gapPct ?? 1.5), speck: r !== main && pct < (opt.speckPct ?? 0.2) });
    }
    const flagged = pieces.filter(p => p.floating || p.speck);
    const removeTris = new Set(); const fr = new Set(flagged.map(p => p.root));
    for (let t = 0; t < nt; t++) if (fr.has(tri[t])) removeTris.add(t);
    const big = flagged.filter(p => p.pct >= 0.2).length, specks = flagged.length - big;
    const note = !flagged.length ? 'no loose pieces' :
      [big ? big + (big === 1 ? ' piece' : ' pieces') + ' floating off the body' : '', specks ? specks + (specks === 1 ? ' speck' : ' specks') + ' in the air' : ''].filter(Boolean).join(' and ');
    return { ok: !flagged.length, pieces, flagged, removeTris, note, big, specks };
  }
  const api = { check };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.PartsCheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
