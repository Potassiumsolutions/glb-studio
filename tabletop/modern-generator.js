/* ==========================================================================
   MODERN PACK — City · Suburbs · Rural map generator (Tabletop expansion).
   --------------------------------------------------------------------------
   1. NATURAL LAND first — the regular generator in `wild` mode (lakes, a
      mountain range, forests, the stream/river drainage network; no fantasy
      settlements, castles or dirt roads).
   2. A STREET GRID laid over it. Street lines are fixed to the map's own
      coordinates (every S-th column / row, offset by the map's `off`), so
      when the map is EXTENDED the grid simply continues — new land lines up
      with the old streets without any matching work.
        City     S=3  — a tight downtown grid of asphalt streets
        Suburbs  S=4  — avenues + side streets, some dropped → T-junctions
                        and cul-de-sacs
        Rural    S=9  — section-line roads: paved county roads + gravel
   3. A RAILWAY straight across the map (city + rural, some suburbs).
   4. BLOCKS filled by zone: downtown towers → apartments & shops → suburban
      homes (city, by distance from the centre); homes + school + church +
      strip mall + parks (suburbs); a patchwork of fields, farmsteads by the
      roads, a small crossroads town with a water tower and a grain elevator
      by the railway, and a wind farm (rural).
   Grid-agnostic (square + hex). Output = connector-exact gen~ tiles + swept
   strokes ('street' asphalt · 'road' gravel · 'rail' railway).
   ========================================================================== */
(function (root) {
  'use strict';
  const TE = root.TileEngine || (typeof require !== 'undefined' && require('./tile-engine.js'));
  const P = TE.PATH, B = TE.BIOME, keyOf = TE.keyOf, gridFor = TE.gridFor;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mod = (a, n) => ((a % n) + n) % n;
  const hash = (...a) => { let h = 2166136261; for (const v of a) { h ^= (v | 0) + 0x9e3779b9; h = Math.imul(h ^ (h >>> 15), 2246822519); h ^= h >>> 13; } return (h >>> 0) / 4294967295; };
  const kc = (k) => { const i = k.indexOf(','); return { q: +k.slice(0, i), r: +k.slice(i + 1) }; };
  /* join ONLY collinear segments into runs, so a street grid stays dead straight through every junction (the
     generic chainer follows any free neighbour, so runs turned corners and the spline made the grid wobble) */
  function chainStraight(segs) {
    const key = (p) => Math.round(p[0] * 1000) + '|' + Math.round(p[1] * 1000), adj = new Map(), pt = new Map(), used = new Set();
    const eid = (a, b) => a < b ? a + '#' + b : b + '#' + a;
    for (const [A, Bp] of segs) { const ka = key(A), kb = key(Bp); if (ka === kb) continue; pt.set(ka, A); pt.set(kb, Bp);
      (adj.get(ka) || adj.set(ka, []).get(ka)).push(kb); (adj.get(kb) || adj.set(kb, []).get(kb)).push(ka); }
    const dir = (a, b) => { const p = pt.get(a), q = pt.get(b), dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    const along = (from, d) => adj.get(from).find(x => !used.has(eid(from, x)) && (() => { const e = dir(from, x); return e[0] * d[0] + e[1] * d[1] > 0.97; })());
    const runs = [];
    for (const s of adj.keys()) for (const n0 of adj.get(s)) { if (used.has(eid(s, n0))) continue;
      let a = s, b = n0, d = dir(a, b), guard = 0;
      while (guard++ < 2000) { const back = adj.get(a).find(x => x !== b && !used.has(eid(x, a)) && (() => { const e = dir(x, a); return e[0] * d[0] + e[1] * d[1] > 0.97; })()); if (!back) break; b = a; a = back; d = dir(a, b); }
      const run = [pt.get(a)]; let cur = a, nxt = along(a, d);
      while (nxt) { used.add(eid(cur, nxt)); run.push(pt.get(nxt)); const dd = dir(cur, nxt); cur = nxt; nxt = along(cur, dd); }
      if (run.length >= 2) runs.push(run); }
    return runs;
  }

  const THEME = {
    city:    { S: 3, drop: 0,    type: 'street', rail: 1,   base: 'grassland' },
    suburbs: { S: 4, drop: 0.3,  type: 'street', rail: 0.5, base: 'grassland' },
    rural:   { S: 9, drop: 0.3,  type: 'road',   rail: 1,   base: 'grassland' },
    industrial: { S: 4, drop: 0.2, type: 'street', rail: 1,  base: 'grassland' },
    coastal: { S: 4, drop: 0.25, type: 'street', rail: 0.4,  base: 'grassland', coast: true },
  };
  // BATTLE (5-ft) scale: one cell = 5 ft, so blocks are much bigger in cells and there's room for sidewalks
  const BATTLE_S = { city: 12, suburbs: 12, rural: 20, industrial: 12, coastal: 12 };   // real proportions: a 2-lane street ≈ 25 ft (5 cells) + sidewalks

  /* COASTAL: turn a wavy band along one side of the map into open SEA (the side that already has the most water,
     else random). Rivers that reach it flow in; river strokes over the new sea are dropped. */
  function carveCoast(gridKind, board, cells, defs, rng, rivers) {
    const g = gridFor(gridKind), N = g.N, P2 = cells.map(c => ({ c, k: keyOf(c), w: g.world(c) }));
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; P2.forEach(p => { x0 = Math.min(x0, p.w.x); x1 = Math.max(x1, p.w.x); z0 = Math.min(z0, p.w.z); z1 = Math.max(z1, p.w.z); });
    const isW = (k) => { const pl = board.get(k), d = pl && defs[pl.defId]; return !!(d && d.biome === B.WATER); };
    const side = (p, s) => s === 0 ? p.w.z - z0 : s === 1 ? x1 - p.w.x : s === 2 ? z1 - p.w.z : p.w.x - x0;       // distance to N / E / S / W edge
    const ext = (s) => (s % 2 ? x1 - x0 : z1 - z0) || 1, alongOf = (p, s) => s % 2 ? p.w.z : p.w.x;
    let best = (rng() * 4) | 0, bw = -1; for (let s = 0; s < 4; s++) { let n = 0; P2.forEach(p => { if (side(p, s) < ext(s) * 0.25 && isW(p.k)) n++; }); if (n > bw) { bw = n; best = n ? s : best; } }
    const s = best, depth = ext(s) * 0.22, amp = ext(s) * 0.07, ph = rng() * 6;
    const sea = new Set();
    for (const p of P2) { const a = alongOf(p, s), band = depth + Math.sin(a * 0.35 + ph) * amp + Math.sin(a * 0.9 + ph * 2) * amp * 0.4; if (side(p, s) < band) sea.add(p.k); }
    for (const p of P2) { if (!sea.has(p.k)) continue; const sig = new Array(N).fill(P.NONE);
      for (let d = 0; d < N; d++) { const nk = keyOf(g.step(p.c, d)), npl = board.get(nk); if (!npl || sea.has(nk)) continue; const nd = defs[npl.defId]; if (nd && nd.edges[g.opposite(d)].path === P.RIVER) sig[d] = P.RIVER; }
      board.set(p.k, { defId: TE.registerGen(defs, gridKind, B.WATER, sig, 'water'), rot: 0 }); }
    const seaW = P2.filter(p => sea.has(p.k)).map(p => p.w);
    const wet = (x, z) => seaW.some(w => (w.x - x) ** 2 + (w.z - z) ** 2 < 0.2);
    const out = [];
    for (const st of rivers) { let cur = null; for (let i = 0; i < st.pts.length - 1; i++) { const a = st.pts[i], b = st.pts[i + 1];
        if (!wet((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) { if (!cur) cur = { type: st.type, w: st.w, pts: [a] }; cur.pts.push(b); } else { if (cur && cur.pts.length >= 2) out.push(cur); cur = null; } }
      if (cur && cur.pts.length >= 2) out.push(cur); }
    return { side: s, rivers: out };
  }

  /* ---- whole new map ---- */
  function generateModernMap(gridKind, board, cells, defs, opts) {
    opts = opts || {};
    const theme = THEME[opts.theme] ? opts.theme : 'city';
    const seed = (opts.seed || 1) >>> 0;
    const r = TE.generateMap(gridKind, board, cells, defs, { seed, theme: THEME[theme].base, stream: opts.stream, road: false, farms: false, castle: false, wild: true });
    let rivers = (r.draw || []).filter(s => s.type === 'river');
    const g = gridFor(gridKind);
    let coastSide = null;
    if (THEME[theme].coast) { const cc = carveCoast(gridKind, board, cells, defs, TE.mulberry32((seed * 53 + 9) >>> 0), rivers); rivers = cc.rivers; coastSide = cc.side; }
    let cx = 0, cz = 0; cells.forEach(c => { const w = g.world(c); cx += w.x; cz += w.z; }); cx /= cells.length; cz /= cells.length;
    let span = 1; cells.forEach(c => { const w = g.world(c); span = Math.max(span, Math.hypot(w.x - cx, w.z - cz)); });
    const battle = !!opts.battle, S = battle ? BATTLE_S[theme] : THEME[theme].S;
    // centre the grid on the middle of the board so downtown sits on a crossroads
    const mid = cells.slice().sort((a, b) => { const A = g.world(a), Bw = g.world(b); return Math.hypot(A.x - cx, A.z - cz) - Math.hypot(Bw.x - cx, Bw.z - cz); })[0];
    const ctx = { theme, seed, cx, cz, span, offA: mod(mid.q, S), offB: mod(mid.r, S), railRow: null, first: true,
      skySize: clamp((opts.skySize | 0) || 2, 2, 4), stadium: opts.stadium || 'auto',
      landmarks: Object.assign({ airport: true, military: true, space: true, port: true, power: true }, opts.landmarks || {}),
      S, battle, coastSide, highway: opts.highway !== false && !battle };
    if (battle) { ctx.landmarks = {}; ctx.stadium = 'none'; ctx.noSky = true; }
    const o = modernOverlay(gridKind, board, defs, cells, ctx);
    return { placed: board.size, draw: rivers.concat(o.draw), modern: o.ctx, towns: o.towns };
  }

  /* ---- develop a set of cells (the whole map, or the new land of an Extend) ----
     ctx = { theme, seed, cx, cz, span, offA, offB, railRow, first } — persisted by the host so Extends continue the grid. */
  function modernOverlay(gridKind, board, defs, cellList, ctxIn) {
    const ctx = Object.assign({}, ctxIn);
    const theme = THEME[ctx.theme] ? ctx.theme : 'city', T = THEME[theme];
    const g = gridFor(gridKind), N = g.N, S = ctx.S || T.S;
    const rng = TE.mulberry32(((ctx.seed || 1) * 131 + cellList.length * 7 + 11) >>> 0), ri = (n) => Math.floor(rng() * n);
    const W = new Set(cellList.map(keyOf)), keysW = cellList.map(keyOf);
    const cellOf = (k) => kc(k), pos = (k) => g.world(kc(k));
    const biome = {}, edges = {}, feature = {}, extra = {}, touched = new Set();
    const load = (k) => { if (k in biome) return true; const pl = board.get(k); if (!pl) return false; const d = defs[pl.defId]; if (!d) return false;
      biome[k] = d.biome; edges[k] = d.edges.map(e => e.path); feature[k] = d.feature; extra[k] = pl; return true; };
    keysW.forEach(load);
    const nb = (k, d) => keyOf(g.step(cellOf(k), d));
    const setE = (k, d, p) => { edges[k][d] = p; const n = nb(k, d); if (W.has(n)) edges[n][g.opposite(d)] = p; else if (load(n)) { edges[n][g.opposite(d)] = p; touched.add(n); } };
    const isWater = (k) => biome[k] === B.WATER, isHigh = (k) => biome[k] === B.MOUNTAINS || biome[k] === B.SNOW;
    const hasRiver = (k) => edges[k] && edges[k].includes(P.RIVER);
    const devable = (k) => load(k) && !isWater(k) && !isHigh(k);
    const dn = (k) => { const w = pos(k); return Math.hypot(w.x - ctx.cx, w.z - ctx.cz) / (ctx.span || 1); };
    const noise = (k, f, s) => { const w = pos(k); return (Math.sin(w.x * f + s) + Math.cos(w.z * f * 1.13 + s * 1.7) + Math.sin((w.x - w.z) * f * 0.71 + s * 0.3)) / 6 + 0.5; };

    /* ---- 1. STREET GRID (fixed to map coordinates) ---- */
    const hex = gridKind === 'hex';
    const dirsA = hex ? [2, 5] : [0, 2], dirsB = hex ? [0, 3] : [1, 3];        // A = lines of constant q (N–S) · B = lines of constant r (E–W / ESE–WNW on hex)
    const onA = (c) => mod(c.q - ctx.offA, S) === 0, onB = (c) => mod(c.r - ctx.offB, S) === 0;
    const segA = (c) => Math.floor((c.r - ctx.offB) / S), segB = (c) => Math.floor((c.q - ctx.offA) / S);
    const lineA = (c) => Math.floor((c.q - ctx.offA) / S), lineB = (c) => Math.floor((c.r - ctx.offB) / S);
    // avenues (never dropped): every 3rd line in the suburbs; paved county roads in the country
    const avenueA = (c) => mod(lineA(c), 3) === 0, avenueB = (c) => mod(lineB(c), 3) === 1;
    const keepSeg = (axis, line, seg) => T.drop <= 0 || hash(ctx.seed, axis, line, seg) >= T.drop;
    const street = new Set(), paved = new Set();
    const tryEdge = (k, d, axis) => {                                 // a street edge from W cell k in direction d along `axis`
      const c = cellOf(k), n = nb(k, d), cn = cellOf(n);
      const on = axis === 'A' ? onA(c) && onA(cn) : onB(c) && onB(cn); if (!on) return;
      const lo = axis === 'A' ? (c.r < cn.r ? c : cn) : (c.q < cn.q ? c : cn);
      const av = axis === 'A' ? avenueA(c) : avenueB(c);
      if (!av && !keepSeg(axis, axis === 'A' ? lineA(c) : lineB(c), axis === 'A' ? segA(lo) : segB(lo))) return;
      if (!devable(k)) return;
      if (edges[k][d] === P.RIVER) return;                            // the river runs along this line here → the street gives way (Paul: streams ran UNDER roads for cells)
      const onBoard = W.has(n) || board.has(n);
      if (onBoard && !devable(n)) return;                             // stops at a lake / mountain
      setE(k, d, P.ROAD); street.add(k); if (W.has(n)) street.add(n);
      if (theme === 'rural' ? av : true) { paved.add(k); if (onBoard) paved.add(n); }
    };
    for (const k of keysW) { const c = cellOf(k);
      if (onA(c)) for (const d of dirsA) tryEdge(k, d, 'A');
      if (onB(c)) for (const d of dirsB) tryEdge(k, d, 'B'); }

    /* ---- 1b. TUNNELS — a street line that runs into a mountain range (up to 8 cells thick) and carries on as a street
         beyond it bores straight through instead of stopping dead; portals are drawn where it enters / leaves the rock ---- */
    const tunnel = new Set();
    for (const k of keysW) { if (!street.has(k)) continue; const c = cellOf(k);
      for (const [axis, dirs] of [['A', dirsA], ['B', dirsB]]) { if (axis === 'A' ? !onA(c) : !onB(c)) continue;
        for (const d of dirs) { const n0 = nb(k, d); if (edges[k][d] === P.ROAD || !load(n0) || !isHigh(n0)) continue;
          const run = []; let cur = n0; while (run.length < 9 && W.has(cur) && load(cur) && isHigh(cur)) { run.push(cur); cur = nb(cur, d); }
          if (!run.length || run.length > 8) continue;
          const offMap = !load(cur) && !board.has(cur);                                                 // the range runs off the map edge → the road tunnels on out of the map
          if (!offMap && (!load(cur) || !devable(cur) || !(street.has(cur) || (!W.has(cur) && edges[cur].includes(P.ROAD))))) continue;   // else the far side must be a street too
          let prev = k; for (const t of (offMap ? run : run.concat([cur]))) { setE(prev, d, P.ROAD); prev = t; }
          if (offMap) edges[run[run.length - 1]][d] = P.ROAD;
          run.forEach(t => tunnel.add(t)); } } }

    /* ---- 2. RAILWAY — straight across the map (new maps), or carried on from the seam (Extends) ---- */
    const rail = new Set();
    // the railway keeps to ONE GRID ROW (ctx.railRow = an r index) — a dead-straight line on squares AND hexes (a hex
    // row runs ESE–WNW; the old world-z line zig-zagged between hex rows and the spline turned it into an S-curve).
    // Now and then it takes ONE deliberate bend (Paul: "a gentle or 45 degree bend from time to time") — a straight
    // ramp of 30° or 45° over to the next mid-block row (±S), then straight again. ctx.railBends = [{a,b,dr}] measured
    // along the row (u, world units); a→b may run either way, so bends added when Extending west don't move the old line.
    const _o = g.world({ q: 0, r: 0 }), _q1 = g.world({ q: 1, r: 0 }), _r1 = g.world({ q: 0, r: 1 });
    const rowDir = (() => { const x = _q1.x - _o.x, z = _q1.z - _o.z, L = Math.hypot(x, z) || 1; return [x / L, z / L]; })();
    const rowGap = Math.abs(rowDir[0] * (_r1.z - _o.z) - rowDir[1] * (_r1.x - _o.x)) || 1;          // distance between neighbouring rows
    const uOf = (k) => { const w = pos(k); return w.x * rowDir[0] + w.z * rowDir[1]; };
    const railTarget = (u) => { let r = ctx.railRow; for (const b of (ctx.railBends || [])) r += b.dr * Math.max(0, Math.min(1, (u - b.a) / (b.b - b.a))); return r; };
    const planBends = (uFrom, uTo) => {                                                                 // add bends between uFrom and uTo (either direction)
      const dir = Math.sign(uTo - uFrom); if (!dir) return; ctx.railBends = ctx.railBends || [];
      let u = uFrom + dir * (4 + rng() * 5), cur = Math.round(railTarget(uFrom));
      while ((uTo - u) * dir > 4) {
        if (rng() < 0.5) { const opts = [S, -S].filter(dr => Math.abs(cur + dr - ctx.railRow) <= S);        // wander at most one block off the home row
          const dr = opts[ri(opts.length)], ang = (rng() < (hex ? 0.65 : 0.5) ? 30 : 45) * Math.PI / 180, du = Math.abs(dr) * rowGap / Math.tan(ang);
          if ((uTo - (u + dir * du)) * dir < 2) break;
          ctx.railBends.push({ a: u, b: u + dir * du, dr }); cur += dr; u += dir * (du + 5 + rng() * 5); }
        else u += dir * (5 + rng() * 5); } };
    const railCost = (k, from) => { if (!W.has(k) || !devable(k)) return Infinity; return 1 + 3 * Math.abs(cellOf(k).r - railTarget(uOf(k))) + (hasRiver(k) ? 1.5 : 0) + rng() * 0.05; };
    function railPath(src, isGoal) {
      const dist = { [src]: 0 }, prev = {}, pq = [[0, src]]; let hit = null;
      while (pq.length) { pq.sort((a, b) => a[0] - b[0]); const [d, k] = pq.shift(); if (d > (dist[k] ?? Infinity)) continue;
        if (k !== src && isGoal(k)) { hit = k; break; }
        for (let dd = 0; dd < N; dd++) { if (edges[k] && (edges[k][dd] === P.RIVER || edges[k][dd] === P.ROAD || edges[k][dd] === P.HWY)) continue;   // cross streets / rivers, never run along them
          if (ctx.hwyLine != null && (ctx.hwyAxis === 'A' ? cellOf(k).q : cellOf(k).r) === ctx.hwyLine && (ctx.hwyAxis === 'A' ? dirsA : dirsB).includes(dd)) continue;   // nor along the freeway line
          const n = nb(k, dd); const c = railCost(n, k); if (!isFinite(c)) continue; const nd = d + c; if (nd < (dist[n] ?? Infinity)) { dist[n] = nd; prev[n] = k; pq.push([nd, n]); } } }
      if (!hit) return null; const p = [hit]; let k = hit; while (k !== src) { k = prev[k]; p.push(k); } return p.reverse(); }
    const offDirs = (k) => { const out = []; for (let d = 0; d < N; d++) { const n = nb(k, d); if (!W.has(n) && !board.has(n)) out.push(d); } return out; };
    const layRail = (p) => { for (let i = 0; i < p.length - 1; i++) { const a = p[i], b = p[i + 1]; for (let d = 0; d < N; d++) if (nb(a, d) === b) { setE(a, d, P.RAIL); break; } } p.forEach(k => rail.add(k)); };
    if (ctx.first && rng() < T.rail) {
      // a mid-block row (between two street rows) through the middle third of the map, edge to edge
      let minX = Infinity, maxX = -Infinity; keysW.forEach(k => { const x = pos(k).x; minX = Math.min(minX, x); maxX = Math.max(maxX, x); });
      // a mid-block row (between two street rows) in the middle third — the one with the fewest lakes / mountains on it
      const rows = [...new Set(keysW.map(k => cellOf(k).r))].sort((a, b) => a - b);
      const cand = rows.filter(r0 => mod(r0 - ctx.offB, S) === Math.floor(S / 2)).filter(r0 => { const i = rows.indexOf(r0); return i > rows.length * 0.25 && i < rows.length * 0.75; });
      const score = (r0) => { let n = 0, bad = 0; for (const k of keysW) if (cellOf(k).r === r0) { n++; if (!devable(k)) bad++; } return n ? bad / n + rng() * 0.05 : 9; };
      ctx.railRow = cand.length ? cand.sort((a, b) => score(a) - score(b))[0] : rows[Math.floor(rows.length / 2)];
      const row = keysW.filter(k => cellOf(k).r === ctx.railRow).sort((a, b) => cellOf(a).q - cellOf(b).q);
      const src = row.find(k => offDirs(k).length && devable(k)) || keysW.filter(k => offDirs(k).length && devable(k) && pos(k).x < minX + 0.8).sort((a, b) => Math.abs(cellOf(a).r - ctx.railRow) - Math.abs(cellOf(b).r - ctx.railRow))[0];
      if (src) { const far = (k) => Math.hypot(pos(k).x - pos(src).x, pos(k).z - pos(src).z) > ctx.span * 0.9;
        ctx.railV = 2; ctx.railBends = []; planBends(uOf(src), Math.max(...keysW.map(uOf)));
        const p = railPath(src, k => offDirs(k).length > 0 && far(k) && pos(k).x > pos(src).x);
        if (p) { layRail(p);
          const a = pos(p[0]), b = pos(p[p.length - 1]), dx = b.x - a.x, dz = b.z - a.z;                  // leave the map straight on, along the line
          for (const e of [p[0], p[p.length - 1]]) { const od = offDirs(e); if (od.length) { let best = od[0], bs = -Infinity;
            for (const d of od) { const m = g.edgeMid(d), sg = (e === p[0] ? -1 : 1) * (m[0] * dx + m[1] * dz); if (sg > bs) { bs = sg; best = d; } } edges[e][best] = P.RAIL; } } } }
    } else if (ctx.railRow != null) {
      // Extend: continue any railway that leaves the old map into this new land, on to the far edge
      for (const k of keysW) for (let d = 0; d < N; d++) { const n = nb(k, d); if (W.has(n) || !load(n) || edges[n][g.opposite(d)] !== P.RAIL || rail.has(k)) continue;
        if (!devable(k)) continue;
        edges[k][d] = P.RAIL; rail.add(k);
        const w0 = pos(k), away = [w0.x - pos(n).x, w0.z - pos(n).z];
        if (hex && !ctx.railV) { ctx.railRow = cellOf(k).r; ctx.railBends = []; } ctx.railV = 2;           // a pre-v0.98 hex map stored a world z here
        const along = away[0] * rowDir[0] + away[1] * rowDir[1];
        if (Math.abs(along) > 0.3) { const u0 = uOf(k), ends = keysW.map(uOf); planBends(u0, along > 0 ? Math.max(...ends) : Math.min(...ends)); }
        const p = railPath(k, j => offDirs(j).length > 0 && ((pos(j).x - w0.x) * away[0] + (pos(j).z - w0.z) * away[1]) > 1.5);
        if (p) { layRail(p); const e = p[p.length - 1], od = offDirs(e); let best = od[0], bs = -Infinity;
          for (const dd of od) { const m = g.edgeMid(dd), s = m[0] * away[0] + m[1] * away[1]; if (s > bs) { bs = s; best = dd; } } if (best != null) edges[e][best] = P.RAIL; }
        else { const od = offDirs(k); if (od.length) edges[k][od[0]] = P.RAIL; } }
    }

    /* ---- 2a. ELEVATED HIGHWAY — a straight 4-lane freeway on piers, edge to edge, along one grid line between the
         streets (N–S by default; E–W on a coast that runs N–S… i.e. parallel to the shore). It rides OVER the streets,
         railway and water; where it crosses an avenue there are on/off ramps. Fixed to map coordinates → Extend continues it. ---- */
    const hwy = new Set();
    if (ctx.highway) {
      if (ctx.first) {
        const axis = (ctx.coastSide === 0 || ctx.coastSide === 2) ? 'B' : 'A';
        const lineOf = (k) => axis === 'A' ? cellOf(k).q : cellOf(k).r, vals = [...new Set(keysW.map(lineOf))].sort((a, b) => a - b);
        const off = axis === 'A' ? ctx.offA : ctx.offB, mid = Math.floor(S / 2);
        let best = null, bs = Infinity;
        for (let i = Math.floor(vals.length * 0.22); i < Math.ceil(vals.length * 0.78); i++) { const v = vals[i]; if (mod(v - off, S) !== mid) continue;
          const hd = axis === 'A' ? dirsA : dirsB;
          let bad = 0, n = 0; for (const k of keysW) { if (lineOf(k) !== v) continue; n++; if (!devable(k)) bad += isWater(k) ? 1 : 3; if (rail.has(k) && axis === 'B') bad += 5; if (hd.some(d => edges[k][d] === P.RIVER || edges[k][d] === P.RAIL)) bad += 40; }
          const sc = bad + Math.abs(i - vals.length * 0.4) * 0.3 + rng() * 0.5; if (n && sc < bs) { bs = sc; best = v; } }
        if (best != null) { ctx.hwyAxis = axis; ctx.hwyLine = best; }
      }
      if (ctx.hwyLine != null) {
        const axis = ctx.hwyAxis, on = (k) => (axis === 'A' ? cellOf(k).q : cellOf(k).r) === ctx.hwyLine, dirs = axis === 'A' ? dirsA : dirsB;
        for (const k of keysW) { if (!on(k) || !load(k)) continue; hwy.add(k);
          for (const d of dirs) { const n = nb(k, d); if (W.has(n) || !board.has(n) || (load(n) && edges[n].includes(P.HWY))) edges[k][d] = P.HWY; if (W.has(n)) edges[n][g.opposite(d)] = P.HWY; } }
      }
    }

    /* ---- 2b. LANDMARKS (new maps only) — cells are RESERVED as whole blocks, like the castle keep:
         · a LANDMARK SKYSCRAPER of N×N squares (2×2 … 4×4; hex: 7 / 19 / 37 hexes) at the heart of downtown,
           plus a couple of 2×2 towers in other downtown blocks (city)
         · a STADIUM of 4–16 squares (2×2 … 4×4; hex: 7 hexes) with a parking-lot apron (city + suburbs)
       Streets that would run through a big block are closed — they end at the plaza / stadium like real superblocks. ---- */
    const reserved = new Set();
    const okCell = (k) => W.has(k) && devable(k) && !rail.has(k) && !hasRiver(k) && !reserved.has(k) && !hwy.has(k);
    const blockOf = (a, w, h) => { const c = cellOf(a), out = [];
      if (hex) { const R0 = Math.max(0, w - 1); for (let dq = -R0; dq <= R0; dq++) for (let dr = -R0; dr <= R0; dr++) if ((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 <= R0) out.push(keyOf({ q: c.q + dq, r: c.r + dr })); }
      else for (let dq = 0; dq < w; dq++) for (let dr = 0; dr < h; dr++) out.push(keyOf({ q: c.q + dq, r: c.r + dr }));
      return out; };
    const centreOf = (cells) => { let x = 0, z = 0; cells.forEach(k => { const w = pos(k); x += w.x; z += w.z; }); return { x: x / cells.length, z: z / cells.length }; };
    const claim = (cells, anchor, mainF, yardF, bm) => { for (const k of cells) { for (let d = 0; d < N; d++) if (edges[k][d] === P.ROAD) setE(k, d, P.NONE);
        street.delete(k); paved.delete(k); reserved.add(k); biome[k] = bm || B.URBAN; feature[k] = yardF; }
      feature[anchor] = mainF; };
    // best anchor for a w×h block inside a distance band (dn of the block centre), fewest streets swallowed
    const gapOK = (cells) => { const set = new Set(cells); for (const k of cells) for (let d = 0; d < N; d++) { const n = nb(k, d); if (!set.has(n) && reserved.has(n) && feature[n] !== 'lot') return false; } return true; };
    const findBlock = (w, h, lo, hi, streetPenalty, gap) => { let best = null, bs = Infinity;
      for (const a of keysW) { const cells = blockOf(a, w, h); if (!cells.every(okCell) || (gap && !gapOK(cells))) continue;
        const c = centreOf(cells), d = Math.hypot(c.x - ctx.cx, c.z - ctx.cz) / (ctx.span || 1); if (d < lo || d > hi) continue;
        let st = 0; for (const k of cells) if (street.has(k)) st++;
        const sc = st * streetPenalty + Math.abs(d - (lo + hi) / 2) * 2 + rng() * 0.3; if (sc < bs) { bs = sc; best = { a, cells }; } }
      return best; };
    if (ctx.first && theme === 'city' && !ctx.noSky) {
      const N0 = hex ? clamp(ctx.skySize, 2, 3) : ctx.skySize;
      const L = findBlock(N0, N0, 0, 0.22, 0.05) || findBlock(N0, N0, 0, 0.4, 0.05);
      if (L) { claim(L.cells, hex ? L.a : L.a, 'skyscraper' + N0, 'skyyard');
        if (hex) { /* ring block is centred on its anchor already */ } }
      for (let i = 0; i < 2 && !hex; i++) { const b = findBlock(2, 2, 0.1, 0.34, 3); if (b && !b.cells.some(k => [...Array(N).keys()].some(d => reserved.has(nb(k, d)) && !b.cells.includes(nb(k, d))))) claim(b.cells, b.a, 'skyscraper2', 'skyyard'); }
    }
    if (ctx.first && (theme === 'city' || theme === 'suburbs') && ctx.stadium !== 'none') {
      const pick = ctx.stadium && ctx.stadium !== 'auto' ? ctx.stadium.split('x').map(Number)
        : (theme === 'city' ? [[3, 3], [3, 4], [4, 3], [4, 4], [2, 3]] : [[2, 2], [2, 3], [3, 2], [3, 3]])[ri(theme === 'city' ? 5 : 4)];
      const [sw, sh] = hex ? [2, 2] : pick;
      const b = findBlock(sw, sh, theme === 'city' ? 0.35 : 0.2, theme === 'city' ? 0.85 : 0.75, 0.2) || findBlock(sw, sh, 0.15, 1.2, 0.2);
      if (b) { claim(b.cells, b.a, hex ? 'stadiumh' : 'stadium' + sw + 'x' + sh, 'stadyard');
        for (const k of b.cells) for (let d = 0; d < N; d++) { const n = nb(k, d); if (okCell(n) && !street.has(n) && rng() < 0.55) { reserved.add(n); biome[n] = B.LOT; feature[n] = 'lot'; } } }   // the car park round it
    }
    /* ---- 2c. BIG SITES (new maps; each 4–16 squares like the stadium, hex = 7) — out on the edge of town, never touching
         another landmark:  ✈ AIRPORT (a long block: the runway runs along it) · 🎖 MILITARY BASE · 🚀 SPACE HUB with a giant
         rocket (the remotest spot) · ⚓ SEA PORT (must have open water along one whole side — the ship docks there). ---- */
    if (ctx.first) {
      const LM = ctx.landmarks || {};
      const sizes = (list) => hex ? [[2, 2]] : list.slice().sort(() => rng() - 0.5);
      const place = (list, lo, hi, featOf, bm) => { for (const [w, h] of sizes(list)) for (const [ww, hh] of (w === h ? [[w, h]] : [[w, h], [h, w]])) {
          const b = findBlock(ww, hh, lo, hi, 0.4, true) || findBlock(ww, hh, Math.max(0, lo - 0.3), hi + 0.6, 0.4, true);
          if (b) { claim(b.cells, b.a, featOf(ww, hh), 'siteyard', bm); return true; } } return false; };
      const sz = (pre) => (w, h) => hex ? pre + 'h' : pre + w + 'x' + h;
      if (LM.airport) place([[4, 2], [4, 3]], 0.65, 1.3, sz('airport'), B.LOT);
      if (LM.space) place([[3, 3], [3, 4], [4, 4]], 0.7, 1.4, sz('spacehub'), B.URBAN);
      if (LM.military) place([[3, 3], [3, 4], [4, 4]], 0.6, 1.3, sz('military'), B.DIRT);
      if (LM.power && theme === 'industrial') place([[3, 3], [4, 3], [4, 4]], 0.3, 1.1, sz('powerplant'), B.INDUSTRIAL);
      if (LM.port) {                                                            // a quay along open water
        let best = null, bs = Infinity;
        for (const [w, h] of sizes([[3, 2], [4, 2], [3, 3], [4, 3]])) for (const [ww, hh] of (w === h ? [[w, h]] : [[w, h], [h, w]])) for (const a of keysW) {
          const cells = blockOf(a, ww, hh); if (!cells.every(okCell) || !gapOK(cells)) continue;
          const set = new Set(cells); let bestD = -1, bestF = 0;
          for (let d = 0; d < N; d++) { let n0 = 0, wet = 0; for (const k of cells) { const n = nb(k, d); if (set.has(n)) continue; n0++; if (load(n) && biome[n] === B.WATER && !reserved.has(n)) wet++; }
            const f = n0 ? wet / n0 : 0; if (f > bestF) { bestF = f; bestD = d; } }
          if (bestF < (hex ? 0.6 : 0.99)) continue;
          const sc = cells.length * -0.05 + rng() * 0.5; if (sc < bs) { bs = sc; best = { a, cells, d: bestD, w: ww, h: hh }; } }
        if (best) claim(best.cells, best.a, (hex ? 'porth' : 'port' + best.w + 'x' + best.h) + 'd' + best.d, 'siteyard', B.URBAN);
      }
    }

    /* ---- 3. BLOCKS — zone every developable cell ---- */
    const towns = [];
    const avenueX = (k) => { const c = cellOf(k); return ctx.hwyAxis === 'A' ? (onB(c) && avenueB(c)) : (onA(c) && avenueA(c)); };
    for (const k of hwy) { if (!W.has(k) || !devable(k)) continue; reserved.add(k);                       // land under the freeway
      const st = edges[k].includes(P.ROAD); biome[k] = theme === 'rural' ? B.PLAINS : theme === 'industrial' ? B.INDUSTRIAL : B.LOT; feature[k] = st && avenueX(k) ? 'interchange' : 'underhwy'; }
    if (ctx.battle) for (const k of keysW) { if (street.has(k) || rail.has(k) || reserved.has(k) || !devable(k) || theme === 'rural') continue;   // 5-ft scale: a sidewalk along every street
      let near = false; for (let d = 0; d < N && !near; d++){ const n = nb(k, d); if (street.has(n) || rail.has(n)) near = true; else for (let d2 = 0; d2 < N; d2++) if (street.has(nb(n, d2))) { near = true; break; } }   // + a strip beside the track   // 2 cells either side lie under the 5-cell street
      if (near) { reserved.add(k); biome[k] = B.URBAN; feature[k] = 'sidewalk'; } }
    const setB = (k, bm, f, v) => { biome[k] = bm; feature[k] = f; if (v !== undefined) extra[k] = Object.assign({}, extra[k], { variant: v }); else if (extra[k]) { const e = Object.assign({}, extra[k]); delete e.variant; delete e.mass; extra[k] = e; } };
    const nearRoad = (k) => { for (let d = 0; d < N; d++) { const n = nb(k, d); if (street.has(n) || (load(n) && edges[n].includes(P.ROAD))) return true; } return false; };
    const nearRail = (k, rad) => { const w = pos(k); for (const j of rail) { const v = pos(j); if ((v.x - w.x) ** 2 + (v.z - w.z) ** 2 <= rad * rad) return true; } return false; };
    if (theme === 'industrial') {
      for (const k of keysW) {
        if (isWater(k) || isHigh(k) || reserved.has(k)) continue;
        const d = dn(k), h = hash(ctx.seed, cellOf(k).q, cellOf(k).r), onSt = street.has(k), tf = noise(k, 0.45, 29);
        if (rail.has(k)) { setB(k, B.INDUSTRIAL, 'railside'); continue; }
        if (onSt) { setB(k, B.INDUSTRIAL, 'yard'); continue; }
        if (hasRiver(k)) { setB(k, B.PLAINS, undefined); continue; }
        if (nearRail(k, 1.1) && h < 0.5) { setB(k, B.INDUSTRIAL, 'sidings'); continue; }
        if (d > 0.95 && h < 0.5) { setB(k, B.SUBURB, 'homes'); continue; }                                   // a little worker housing out at the edge
        if (biome[k] === B.FOREST && h < 0.5) continue;
        if (tf > 0.74) { setB(k, B.INDUSTRIAL, 'tankfarm'); continue; }
        if (h < 0.3) setB(k, B.INDUSTRIAL, 'factory');
        else if (h < 0.62) setB(k, B.INDUSTRIAL, 'warehouse');
        else if (h < 0.76) setB(k, B.LOT, 'depot');
        else if (h < 0.84) setB(k, B.LOT, 'lot');
        else setB(k, B.INDUSTRIAL, 'yard');
      }
    } else if (theme === 'coastal') {
      // distance (in cells) from the sea
      const sd = {}, q0 = []; for (const k of keysW) if (isWater(k)) { sd[k] = 0; q0.push(k); }
      for (let i = 0; i < q0.length; i++) { const k = q0[i]; for (let d = 0; d < N; d++) { const n = nb(k, d); if (W.has(n) && sd[n] === undefined && !isHigh(n)) { sd[n] = sd[k] + 1; q0.push(n); } } }
      const toSea = (k) => { for (let d = 0; d < N; d++) { const n = nb(k, d); if (sd[n] === (sd[k] || 0) - 1) return d; } return -1; };
      const toLand = (k) => { for (let d = 0; d < N; d++) { const n = nb(k, d); if (sd[n] === 1) return d; } return -1; };
      // marinas + a pier on the water beside the town centre, a lighthouse on the far point
      if (ctx.first) {
        const shoreW = keysW.filter(k => isWater(k) && toLand(k) >= 0 && !reserved.has(k)).sort((a, b) => dn(a) - dn(b));
        let placed = 0; const used = new Set();
        for (const k of shoreW) { if (placed >= 4) break; if ([...used].some(u => (pos(u).x - pos(k).x) ** 2 + (pos(u).z - pos(k).z) ** 2 < 2.2)) continue;
          feature[k] = (placed === 1 ? 'pier' : 'marina') + toLand(k); reserved.add(k); used.add(k); placed++; }
        const pt = keysW.filter(k => sd[k] === 1 && !street.has(k) && !rail.has(k) && !reserved.has(k) && !hwy.has(k)).sort((a, b) => dn(b) - dn(a))[0];
        if (pt) { biome[pt] = B.BEACH; feature[pt] = 'lighthouse'; reserved.add(pt); }
      }
      for (const k of keysW) {
        if (isWater(k) || isHigh(k) || reserved.has(k)) continue;
        const d = dn(k), h = hash(ctx.seed, cellOf(k).q, cellOf(k).r), onSt = street.has(k), dist = sd[k] ?? 99;
        if (rail.has(k)) { setB(k, B.URBAN, 'railside'); continue; }
        if (dist === 1 && !onSt) { setB(k, B.BEACH, 'beach'); continue; }
        if (onSt) { setB(k, dist <= 2 ? B.URBAN : B.SUBURB, dist <= 3 && d < 0.5 ? 'streetside' : 'homes'); continue; }
        if (dist === 2 && d < 0.55 && h < 0.7) { const f = toSea(k); setB(k, B.URBAN, f >= 0 ? 'hotel' + f : 'hotel'); continue; }
        if (hasRiver(k)) { setB(k, B.PARK, 'park'); continue; }
        if (d < 0.25 && h < 0.55) { setB(k, h < 0.2 ? B.LOT : B.URBAN, h < 0.2 ? 'lot' : 'shops'); continue; }
        if (biome[k] === B.FOREST && noise(k, 0.7, 5) > 0.55) continue;
        if (noise(k, 0.9, 11) > 0.84) { setB(k, B.PARK, 'park'); continue; }
        setB(k, B.SUBURB, 'homes');
      }
    } else if (theme === 'city' || theme === 'suburbs') {
      let stationDone = !ctx.first;
      const order = keysW.slice().sort((a, b) => dn(a) - dn(b));
      // suburbs: one school + one church + a strip mall at the centre
      let school = theme === 'suburbs' && ctx.first ? 0 : 2, church = theme === 'suburbs' && ctx.first ? 0 : 1;
      for (const k of order) {
        if (isWater(k) || isHigh(k) || reserved.has(k)) continue;
        const d = dn(k), pk = noise(k, 0.9, ctx.seed % 97), onSt = street.has(k), rv = hasRiver(k), h = hash(ctx.seed, cellOf(k).q, cellOf(k).r);
        if (rail.has(k)) { if (!stationDone && theme === 'city' && d < 0.45) { setB(k, B.URBAN, 'station'); stationDone = true; } else setB(k, onSt ? B.URBAN : biome[k] === B.FOREST ? B.PARK : B.URBAN, 'railside'); continue; }
        if (rv && !onSt) { setB(k, B.PARK, 'park'); continue; }                                   // riverside parkland
        if (theme === 'city') {
          if (onSt) { setB(k, d < 0.62 ? B.URBAN : B.SUBURB, d < 0.62 ? 'streetside' : 'homes'); continue; }
          if (pk > 0.8 || (biome[k] === B.FOREST && d < 0.8)) { setB(k, B.PARK, h < 0.3 && d > 0.3 ? 'sportsfield' : 'park'); continue; }
          if (d < 0.28) setB(k, B.URBAN, h < 0.06 ? 'plaza' : 'towers', undefined);
          else if (d < 0.6) setB(k, h < 0.08 ? B.LOT : B.URBAN, h < 0.08 ? 'lot' : (h < 0.62 ? 'apartments' : 'shops'));
          else if (d < 0.95) setB(k, B.SUBURB, h < 0.12 ? 'apartments' : 'homes');
          else if (biome[k] === B.FOREST) continue;
          else setB(k, B.SUBURB, 'homes');
          if (feature[k] === 'towers') extra[k] = Object.assign({}, extra[k], { mass: clamp(1 - d / 0.28, 0.15, 1) });   // downtown towers rise toward the centre
        } else {
          if (!onSt && d < 0.16 && nearRoad(k)) { setB(k, h < 0.35 ? B.LOT : B.URBAN, h < 0.35 ? 'lot' : 'shops'); continue; }   // strip mall + parking
          if (!onSt && school < 2 && d > 0.12 && d < 0.5 && nearRoad(k)) { setB(k, school ? B.PARK : B.SUBURB, school ? 'sportsfield' : 'school'); school++; continue; }
          if (!onSt && !church && d > 0.1 && d < 0.45 && nearRoad(k)) { setB(k, B.SUBURB, 'church'); church = 1; continue; }
          if (!onSt && pk > 0.82) { setB(k, B.PARK, 'park'); continue; }
          if (biome[k] === B.FOREST && noise(k, 0.7, 5) > 0.5 && !onSt) continue;              // keep some woodlots
          setB(k, B.SUBURB, 'homes');
        }
      }
    } else {
      /* RURAL: fields patchwork · farmsteads by the roads · a crossroads town · wind farm */
      let townAt = null;
      if (ctx.first) {
        const xs = keysW.filter(k => street.has(k) && paved.has(k) && devable(k) && !hasRiver(k) && !reserved.has(k)).sort((a, b) => dn(a) - dn(b));
        townAt = xs[0] || null; if (townAt) { const w = pos(townAt); ctx.town = [w.x, w.z]; towns.push(townAt); }
      }
      const town = ctx.town;
      const inTown = (k, r0) => { if (!town) return false; const w = pos(k); return Math.hypot(w.x - town[0], w.z - town[1]) <= r0; };
      let tower = !ctx.first, elevator = !ctx.first;
      for (const k of keysW) {
        if (isWater(k) || isHigh(k) || biome[k] === B.ROCKS || reserved.has(k)) continue;
        const h = hash(ctx.seed, cellOf(k).q, cellOf(k).r), onSt = street.has(k);
        if (rail.has(k)) { if (!elevator && inTown(k, 4.5)) { setB(k, B.URBAN, 'elevator'); elevator = true; } else if (!onSt && biome[k] !== B.FOREST) setB(k, B.PLAINS, 'railside'); continue; }
        if (inTown(k, 1.6)) { setB(k, B.URBAN, onSt ? 'streetside' : 'shops'); continue; }
        if (inTown(k, 3.1)) { if (!tower && !onSt) { setB(k, B.SUBURB, 'watertower'); tower = true; } else setB(k, B.SUBURB, 'homes'); continue; }
        if (biome[k] === B.FOREST) continue;
        if (hasRiver(k)) { if (!onSt) setB(k, B.PLAINS, undefined); continue; }
        if (!onSt && nearRoad(k) && h < 0.085) { setB(k, B.PLAINS, 'farmstead'); continue; }
        const wind = noise(k, 0.33, 41);
        if (!onSt && wind > 0.8 && dn(k) > 0.3 && h < 0.6) { setB(k, B.PLAINS, 'turbines'); continue; }
        const f = noise(k, 0.52, 13), v = hash(ctx.seed + 1, cellOf(k).q >> 1, cellOf(k).r >> 1);   // 2×2-ish field parcels
        if (f < 0.2) setB(k, B.PLAINS, undefined);                                               // pasture
        else if (v < 0.18) setB(k, B.PIVOT, 'field', (v * 100 | 0) % 2);
        else if (v < 0.3) setB(k, B.ORCHARD, 'field', (v * 100 | 0) % 2);
        else setB(k, B.CROPS, 'field', (v * 1000 | 0) % 3);
      }
    }

    /* ---- 3-battle. At 5-ft scale a whole BLOCK is one lot: every cell of a block takes the block's majority use, so the
         host builds ONE building filling it (not a scatter of 10-ft sheds). ---- */
    if (ctx.battle) {
      const skip = (k) => !W.has(k) || !devable(k) || street.has(k) || rail.has(k) || hwy.has(k) || feature[k] === 'sidewalk' || hasRiver(k);
      const seen = new Set();
      for (const k0 of keysW) { if (seen.has(k0) || skip(k0)) continue;
        const comp = [], q = [k0]; seen.add(k0);
        while (q.length) { const k = q.pop(); comp.push(k); for (let d = 0; d < N; d++) { const n = nb(k, d); if (!seen.has(n) && !skip(n)) { seen.add(n); q.push(n); } } }
        const cnt = {}; for (const k of comp) { const f = String(feature[k] || biome[k]).replace(/\d+$/, ''); cnt[f] = (cnt[f] || 0) + 1; }
        let bestF = null, bc = -1; for (const f in cnt) if (cnt[f] > bc) { bc = cnt[f]; bestF = f; }
        const lead = comp.find(k => String(feature[k] || biome[k]).replace(/\d+$/, '') === bestF);
        for (const k of comp) { biome[k] = biome[lead]; feature[k] = feature[lead]; } }
    }

    /* ---- 3a. houses on a block face the street beside them ('homes<d>' → the edge that street is on) ---- */
    for (const k of keysW) { if (feature[k] !== 'homes' || street.has(k)) continue;
      const order = [...Array(N).keys()].sort((a, b) => hash(ctx.seed, a, cellOf(k).q, cellOf(k).r) - hash(ctx.seed, b, cellOf(k).q, cellOf(k).r));
      for (const d of order) { const n = nb(k, d); if (street.has(n) || (load(n) && edges[n].includes(P.ROAD))) { feature[k] = 'homes' + d; break; } } }

    /* ---- 3b. SEAM: where a street / railway from the existing map meets this new land, make both sides agree
       (continue it into a developable cell; otherwise end it at the old edge — e.g. it runs into a lake) ---- */
    for (const k of keysW) for (let d = 0; d < N; d++) { const n = nb(k, d); if (W.has(n) || !load(n)) continue;
      const pn = edges[n][g.opposite(d)], pk = edges[k][d]; if (pn === pk || (pn !== P.ROAD && pn !== P.RAIL && pn !== P.HWY && pk !== P.ROAD && pk !== P.RAIL && pk !== P.HWY)) continue;
      if (pn === P.HWY && pk === P.NONE) { edges[k][d] = pn; continue; }
      if ((pn === P.ROAD || pn === P.RAIL) && devable(k) && pk === P.NONE) { edges[k][d] = pn; (pn === P.RAIL ? rail : street).add(k); }
      else if (pn === P.ROAD && isHigh(k) && pk === P.NONE) edges[k][d] = pn;                      // a tunnel carries on into the new mountains
      else { edges[n][g.opposite(d)] = pk; touched.add(n); } }

    /* ---- 3c. mountain cells a street / the highway passes through = TUNNEL cells: 'tunnel<dirs>' lists the edges with a portal ---- */
    for (const k of keysW) { if (!isHigh(k)) continue; const p = []; let any = false;
      for (let d = 0; d < N; d++) { const e = edges[k][d]; if (e !== P.ROAD && e !== P.HWY) continue; any = true; const n = nb(k, d); if (load(n) && !isHigh(n)) p.push(d); }
      if (any) feature[k] = 'tunnel' + p.join(''); }

    /* ---- 4. realise changed cells ---- */
    const featDefault = (bm) => ({ plains: 'tufts', forest: 'trees', mountains: 'peaks', water: 'water', park: 'park', suburb: 'homes', urban: 'streetside', lot: 'lot', industrial: 'yard', beach: 'beach' })[bm];
    const realise = (k) => { const sig = edges[k], bm = biome[k];
      let f = feature[k] !== undefined ? feature[k] : featDefault(bm);
      if (sig.includes(P.RIVER) && (sig.includes(P.ROAD) || sig.includes(P.RAIL)) && !sig.includes(P.HWY)) f = 'bridge';
      const id = TE.registerGen(defs, gridKind, bm, sig, f), old = extra[k] || {}, rec = { defId: id, rot: 0 };
      if (old.mass !== undefined) rec.mass = old.mass; if (old.variant !== undefined) rec.variant = old.variant; if (old.tree !== undefined) rec.tree = old.tree;
      board.set(k, rec); };
    keysW.forEach(realise); touched.forEach(realise);

    /* ---- 5. strokes: streets (asphalt) / gravel roads / railway ---- */
    const segs = { street: [], road: [], rail: [], highway: [] };
    for (const k of keysW) { const e = edges[k], w = pos(k), hk = isHigh(k);
      for (let d = 0; d < N; d++) { const p = e[d]; if (p !== P.ROAD && p !== P.RAIL && p !== P.HWY) continue; const n = nb(k, d);
        const typ = p === P.RAIL ? 'rail' : p === P.HWY ? 'highway' : (T.type === 'street' || paved.has(k) || paved.has(n) ? 'street' : 'road');
        const hn = load(n) && isHigh(n);
        if (hk) continue;                                                                              // inside the rock: nothing drawn
        if (hn) { const m = g.edgeMid(d); segs[typ].push([[w.x, w.z], [w.x + m[0], w.z + m[1]]]); continue; }   // up to the tunnel portal
        if (W.has(n)) { if (k < n) { const v = pos(n); segs[typ === 'street' && !(T.type === 'street' || paved.has(n)) ? 'road' : typ].push([[w.x, w.z], [v.x, v.z]]); } }
        else { const m = g.edgeMid(d); segs[typ].push([[w.x, w.z], [w.x + m[0], w.z + m[1]]]); } } }
    // the railway is drawn TRUE: a staircase of cell centres (a bend on squares, a 45° run on hexes) is pulled into
    // one straight line (Douglas–Peucker, within half a cell), then re-sampled so the spline keeps it straight and
    // only rounds the corners a little — straight track with the odd clean bend, never a wobble.
    const trueLine = (pts, tol) => { if (pts.length < 3) return pts;
      const dp = (i, j, out) => { const [ax, az] = pts[i], [bx, bz] = pts[j], L = Math.hypot(bx - ax, bz - az) || 1e-9; let m = -1, md = tol;
        for (let t = i + 1; t < j; t++) { const d = Math.abs((pts[t][0] - ax) * (bz - az) - (pts[t][1] - az) * (bx - ax)) / L; if (d > md) { md = d; m = t; } }
        if (m < 0) out.push(pts[j]); else { dp(i, m, out); dp(m, j, out); } };
      const keep = [pts[0]]; dp(0, pts.length - 1, keep);
      // every corner is eased into a curve (a railway can't turn sharp): cut back up to 1.2 cells each side, join with an arc
      const pts2 = [keep[0]];
      for (let i = 1; i < keep.length - 1; i++) { const V = keep[i], A = keep[i - 1], B = keep[i + 1];
        const la = Math.hypot(A[0] - V[0], A[1] - V[1]), lb = Math.hypot(B[0] - V[0], B[1] - V[1]), c = Math.min(1.2, la * 0.45, lb * 0.45);
        const P1 = [V[0] + (A[0] - V[0]) * c / la, V[1] + (A[1] - V[1]) * c / la], P2 = [V[0] + (B[0] - V[0]) * c / lb, V[1] + (B[1] - V[1]) * c / lb];
        pts2.push(P1); for (let t = 1; t < 6; t++) { const u = t / 6, m = 1 - u; pts2.push([m * m * P1[0] + 2 * m * u * V[0] + u * u * P2[0], m * m * P1[1] + 2 * m * u * V[1] + u * u * P2[1]]); } pts2.push(P2); }
      pts2.push(keep[keep.length - 1]);
      const out = [pts2[0]]; for (let i = 1; i < pts2.length; i++) { const [ax, az] = pts2[i - 1], [bx, bz] = pts2[i], n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 0.5));
        for (let t = 1; t <= n; t++) out.push([ax + (bx - ax) * t / n, az + (bz - az) * t / n]); }
      return out; };
    const draw = [];
    for (const t in segs) for (const run of (t === 'rail' ? TE.chainSegments(segs[t]) : chainStraight(segs[t]))) if (run.length >= 2) draw.push({ type: t, pts: t === 'rail' ? trueLine(run, 0.8) : run });
    ctx.first = false;
    return { draw, ctx, towns };
  }

  TE.generateModernMap = generateModernMap;
  TE.modernOverlay = modernOverlay;
  TE.MODERN_THEMES = Object.keys(THEME);
  if (typeof module !== 'undefined' && module.exports) module.exports = TE;
  root.TileEngine = TE;
})(typeof self !== 'undefined' ? self : this);
