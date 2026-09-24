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
  };

  /* ---- whole new map ---- */
  function generateModernMap(gridKind, board, cells, defs, opts) {
    opts = opts || {};
    const theme = THEME[opts.theme] ? opts.theme : 'city';
    const seed = (opts.seed || 1) >>> 0;
    const r = TE.generateMap(gridKind, board, cells, defs, { seed, theme: THEME[theme].base, stream: opts.stream, road: false, farms: false, castle: false, wild: true });
    const rivers = (r.draw || []).filter(s => s.type === 'river');
    const g = gridFor(gridKind);
    let cx = 0, cz = 0; cells.forEach(c => { const w = g.world(c); cx += w.x; cz += w.z; }); cx /= cells.length; cz /= cells.length;
    let span = 1; cells.forEach(c => { const w = g.world(c); span = Math.max(span, Math.hypot(w.x - cx, w.z - cz)); });
    const S = THEME[theme].S;
    // centre the grid on the middle of the board so downtown sits on a crossroads
    const mid = cells.slice().sort((a, b) => { const A = g.world(a), Bw = g.world(b); return Math.hypot(A.x - cx, A.z - cz) - Math.hypot(Bw.x - cx, Bw.z - cz); })[0];
    const ctx = { theme, seed, cx, cz, span, offA: mod(mid.q, S), offB: mod(mid.r, S), railRow: null, first: true,
      skySize: clamp((opts.skySize | 0) || 2, 2, 4), stadium: opts.stadium || 'auto' };
    const o = modernOverlay(gridKind, board, defs, cells, ctx);
    return { placed: board.size, draw: rivers.concat(o.draw), modern: o.ctx, towns: o.towns };
  }

  /* ---- develop a set of cells (the whole map, or the new land of an Extend) ----
     ctx = { theme, seed, cx, cz, span, offA, offB, railRow, first } — persisted by the host so Extends continue the grid. */
  function modernOverlay(gridKind, board, defs, cellList, ctxIn) {
    const ctx = Object.assign({}, ctxIn);
    const theme = THEME[ctx.theme] ? ctx.theme : 'city', T = THEME[theme];
    const g = gridFor(gridKind), N = g.N, S = T.S;
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
      const onBoard = W.has(n) || board.has(n);
      if (onBoard && !devable(n)) return;                             // stops at a lake / mountain
      setE(k, d, P.ROAD); street.add(k); if (W.has(n)) street.add(n);
      if (theme === 'rural' ? av : true) { paved.add(k); if (onBoard) paved.add(n); }
    };
    for (const k of keysW) { const c = cellOf(k);
      if (onA(c)) for (const d of dirsA) tryEdge(k, d, 'A');
      if (onB(c)) for (const d of dirsB) tryEdge(k, d, 'B'); }

    /* ---- 2. RAILWAY — straight across the map (new maps), or carried on from the seam (Extends) ---- */
    const rail = new Set();
    // the railway keeps to one world-z line (ctx.railRow), detouring only round lakes / mountains
    const railCost = (k, from) => { if (!W.has(k) || !devable(k)) return Infinity; return 1 + 3 * Math.abs(pos(k).z - ctx.railRow) + (hasRiver(k) ? 1.5 : 0) + rng() * 0.2; };
    function railPath(src, isGoal) {
      const dist = { [src]: 0 }, prev = {}, pq = [[0, src]]; let hit = null;
      while (pq.length) { pq.sort((a, b) => a[0] - b[0]); const [d, k] = pq.shift(); if (d > (dist[k] ?? Infinity)) continue;
        if (k !== src && isGoal(k)) { hit = k; break; }
        for (let dd = 0; dd < N; dd++) { const n = nb(k, dd); const c = railCost(n, k); if (!isFinite(c)) continue; const nd = d + c; if (nd < (dist[n] ?? Infinity)) { dist[n] = nd; prev[n] = k; pq.push([nd, n]); } } }
      if (!hit) return null; const p = [hit]; let k = hit; while (k !== src) { k = prev[k]; p.push(k); } return p.reverse(); }
    const offDirs = (k) => { const out = []; for (let d = 0; d < N; d++) { const n = nb(k, d); if (!W.has(n) && !board.has(n)) out.push(d); } return out; };
    const layRail = (p) => { for (let i = 0; i < p.length - 1; i++) { const a = p[i], b = p[i + 1]; for (let d = 0; d < N; d++) if (nb(a, d) === b) { setE(a, d, P.RAIL); break; } } p.forEach(k => rail.add(k)); };
    if (ctx.first && rng() < T.rail) {
      // a mid-block row (between two street rows) through the middle third of the map, edge to edge
      let minX = Infinity, maxX = -Infinity; keysW.forEach(k => { const x = pos(k).x; minX = Math.min(minX, x); maxX = Math.max(maxX, x); });
      if (hex) ctx.railRow = ctx.cz + (rng() - 0.5) * ctx.span * 0.4;
      else { const rows = [...new Set(keysW.map(k => cellOf(k).r))].sort((a, b) => a - b);          // square: a mid-block row (between two street rows) in the middle third
        const midRows = rows.filter(r0 => mod(r0 - ctx.offB, S) === Math.floor(S / 2)).filter(r0 => { const i = rows.indexOf(r0); return i > rows.length * 0.28 && i < rows.length * 0.72; });
        ctx.railRow = midRows.length ? midRows[ri(midRows.length)] : rows[Math.floor(rows.length / 2)]; }
      const src = keysW.filter(k => offDirs(k).length && devable(k) && pos(k).x < minX + 0.8).sort((a, b) => Math.abs(pos(a).z - ctx.railRow) - Math.abs(pos(b).z - ctx.railRow))[0];
      if (src) { const p = railPath(src, k => pos(k).x > maxX - 0.8 && offDirs(k).length > 0);
        if (p) { layRail(p);
          for (const e of [p[0], p[p.length - 1]]) { const od = offDirs(e); if (od.length) { let best = od[0], bs = -Infinity; const w = pos(e);
            for (const d of od) { const m = g.edgeMid(d), s = (e === p[0] ? -1 : 1) * m[0]; if (s > bs) { bs = s; best = d; } } edges[e][best] = P.RAIL; } } } }
    } else if (ctx.railRow != null) {
      // Extend: continue any railway that leaves the old map into this new land, on to the far edge
      for (const k of keysW) for (let d = 0; d < N; d++) { const n = nb(k, d); if (W.has(n) || !load(n) || edges[n][g.opposite(d)] !== P.RAIL || rail.has(k)) continue;
        if (!devable(k)) continue;
        edges[k][d] = P.RAIL; rail.add(k);
        const w0 = pos(k), away = [w0.x - pos(n).x, w0.z - pos(n).z];
        const p = railPath(k, j => offDirs(j).length > 0 && ((pos(j).x - w0.x) * away[0] + (pos(j).z - w0.z) * away[1]) > 1.5);
        if (p) { layRail(p); const e = p[p.length - 1], od = offDirs(e); let best = od[0], bs = -Infinity;
          for (const dd of od) { const m = g.edgeMid(dd), s = m[0] * away[0] + m[1] * away[1]; if (s > bs) { bs = s; best = dd; } } if (best != null) edges[e][best] = P.RAIL; }
        else { const od = offDirs(k); if (od.length) edges[k][od[0]] = P.RAIL; } }
    }

    /* ---- 2b. LANDMARKS (new maps only) — cells are RESERVED as whole blocks, like the castle keep:
         · a LANDMARK SKYSCRAPER of N×N squares (2×2 … 4×4; hex: 7 / 19 / 37 hexes) at the heart of downtown,
           plus a couple of 2×2 towers in other downtown blocks (city)
         · a STADIUM of 4–16 squares (2×2 … 4×4; hex: 7 hexes) with a parking-lot apron (city + suburbs)
       Streets that would run through a big block are closed — they end at the plaza / stadium like real superblocks. ---- */
    const reserved = new Set();
    const okCell = (k) => W.has(k) && devable(k) && !rail.has(k) && !hasRiver(k) && !reserved.has(k);
    const blockOf = (a, w, h) => { const c = cellOf(a), out = [];
      if (hex) { const R0 = Math.max(0, w - 1); for (let dq = -R0; dq <= R0; dq++) for (let dr = -R0; dr <= R0; dr++) if ((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 <= R0) out.push(keyOf({ q: c.q + dq, r: c.r + dr })); }
      else for (let dq = 0; dq < w; dq++) for (let dr = 0; dr < h; dr++) out.push(keyOf({ q: c.q + dq, r: c.r + dr }));
      return out; };
    const centreOf = (cells) => { let x = 0, z = 0; cells.forEach(k => { const w = pos(k); x += w.x; z += w.z; }); return { x: x / cells.length, z: z / cells.length }; };
    const claim = (cells, anchor, mainF, yardF) => { for (const k of cells) { for (let d = 0; d < N; d++) if (edges[k][d] === P.ROAD) setE(k, d, P.NONE);
        street.delete(k); paved.delete(k); reserved.add(k); biome[k] = B.URBAN; feature[k] = yardF; }
      feature[anchor] = mainF; };
    // best anchor for a w×h block inside a distance band (dn of the block centre), fewest streets swallowed
    const findBlock = (w, h, lo, hi, streetPenalty) => { let best = null, bs = Infinity;
      for (const a of keysW) { const cells = blockOf(a, w, h); if (!cells.every(okCell)) continue;
        const c = centreOf(cells), d = Math.hypot(c.x - ctx.cx, c.z - ctx.cz) / (ctx.span || 1); if (d < lo || d > hi) continue;
        let st = 0; for (const k of cells) if (street.has(k)) st++;
        const sc = st * streetPenalty + Math.abs(d - (lo + hi) / 2) * 2 + rng() * 0.3; if (sc < bs) { bs = sc; best = { a, cells }; } }
      return best; };
    if (ctx.first && theme === 'city') {
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

    /* ---- 3. BLOCKS — zone every developable cell ---- */
    const towns = [];
    const setB = (k, bm, f, v) => { biome[k] = bm; feature[k] = f; if (v !== undefined) extra[k] = Object.assign({}, extra[k], { variant: v }); else if (extra[k]) { const e = Object.assign({}, extra[k]); delete e.variant; delete e.mass; extra[k] = e; } };
    const nearRoad = (k) => { for (let d = 0; d < N; d++) { const n = nb(k, d); if (street.has(n) || (load(n) && edges[n].includes(P.ROAD))) return true; } return false; };
    const nearRail = (k, rad) => { const w = pos(k); for (const j of rail) { const v = pos(j); if ((v.x - w.x) ** 2 + (v.z - w.z) ** 2 <= rad * rad) return true; } return false; };
    if (theme === 'city' || theme === 'suburbs') {
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
        const xs = keysW.filter(k => street.has(k) && paved.has(k) && devable(k) && !hasRiver(k)).sort((a, b) => dn(a) - dn(b));
        townAt = xs[0] || null; if (townAt) { const w = pos(townAt); ctx.town = [w.x, w.z]; towns.push(townAt); }
      }
      const town = ctx.town;
      const inTown = (k, r0) => { if (!town) return false; const w = pos(k); return Math.hypot(w.x - town[0], w.z - town[1]) <= r0; };
      let tower = !ctx.first, elevator = !ctx.first;
      for (const k of keysW) {
        if (isWater(k) || isHigh(k) || biome[k] === B.ROCKS) continue;
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

    /* ---- 3a. houses on a block face the street beside them ('homes<d>' → the edge that street is on) ---- */
    for (const k of keysW) { if (feature[k] !== 'homes' || street.has(k)) continue;
      const order = [...Array(N).keys()].sort((a, b) => hash(ctx.seed, a, cellOf(k).q, cellOf(k).r) - hash(ctx.seed, b, cellOf(k).q, cellOf(k).r));
      for (const d of order) { const n = nb(k, d); if (street.has(n) || (load(n) && edges[n].includes(P.ROAD))) { feature[k] = 'homes' + d; break; } } }

    /* ---- 3b. SEAM: where a street / railway from the existing map meets this new land, make both sides agree
       (continue it into a developable cell; otherwise end it at the old edge — e.g. it runs into a lake) ---- */
    for (const k of keysW) for (let d = 0; d < N; d++) { const n = nb(k, d); if (W.has(n) || !load(n)) continue;
      const pn = edges[n][g.opposite(d)], pk = edges[k][d]; if (pn === pk || (pn !== P.ROAD && pn !== P.RAIL && pk !== P.ROAD && pk !== P.RAIL)) continue;
      if ((pn === P.ROAD || pn === P.RAIL) && devable(k) && pk === P.NONE) { edges[k][d] = pn; (pn === P.RAIL ? rail : street).add(k); }
      else { edges[n][g.opposite(d)] = pk; touched.add(n); } }

    /* ---- 4. realise changed cells ---- */
    const featDefault = (bm) => ({ plains: 'tufts', forest: 'trees', mountains: 'peaks', water: 'water', park: 'park', suburb: 'homes', urban: 'streetside', lot: 'lot' })[bm];
    const realise = (k) => { const sig = edges[k], bm = biome[k];
      let f = feature[k] !== undefined ? feature[k] : featDefault(bm);
      if (sig.includes(P.RIVER) && (sig.includes(P.ROAD) || sig.includes(P.RAIL))) f = 'bridge';
      const id = TE.registerGen(defs, gridKind, bm, sig, f), old = extra[k] || {}, rec = { defId: id, rot: 0 };
      if (old.mass !== undefined) rec.mass = old.mass; if (old.variant !== undefined) rec.variant = old.variant; if (old.tree !== undefined) rec.tree = old.tree;
      board.set(k, rec); };
    keysW.forEach(realise); touched.forEach(realise);

    /* ---- 5. strokes: streets (asphalt) / gravel roads / railway ---- */
    const segs = { street: [], road: [], rail: [] };
    for (const k of keysW) { const e = edges[k], w = pos(k);
      for (let d = 0; d < N; d++) { const p = e[d]; if (p !== P.ROAD && p !== P.RAIL) continue; const n = nb(k, d);
        const typ = p === P.RAIL ? 'rail' : (T.type === 'street' || paved.has(k) ? 'street' : 'road');
        if (W.has(n)) { if (k < n) { const v = pos(n); segs[typ === 'street' && !(T.type === 'street' || paved.has(n)) ? 'road' : typ].push([[w.x, w.z], [v.x, v.z]]); } }
        else { const m = g.edgeMid(d); segs[typ].push([[w.x, w.z], [w.x + m[0], w.z + m[1]]]); } } }
    const draw = [];
    for (const t in segs) for (const run of (t === 'rail' ? TE.chainSegments(segs[t]) : chainStraight(segs[t]))) if (run.length >= 2) draw.push({ type: t, pts: run });
    ctx.first = false;
    return { draw, ctx, towns };
  }

  TE.generateModernMap = generateModernMap;
  TE.modernOverlay = modernOverlay;
  TE.MODERN_THEMES = Object.keys(THEME);
  if (typeof module !== 'undefined' && module.exports) module.exports = TE;
  root.TileEngine = TE;
})(typeof self !== 'undefined' ? self : this);
