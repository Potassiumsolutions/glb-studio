/* ==========================================================================
   Board Tile Engine — MAP-FIRST generator (replaces the greedy autoFill).
   --------------------------------------------------------------------------
   The old autoFill grew path networks greedily → roads & trails everywhere,
   starting and stopping in the middle of nowhere. This builds a COHERENT map
   the way a real map works, then realises it as connector-valid tiles:

     1. Lay coherent BIOME regions (plains base + blobs of water / mountains /
        forest, with snow & rocks fringing the mountains).
     2. Route 1–2 RIVERS that flow across the board, edge → edge (down-slope,
        away from the mountains toward the water), meandering — never a
        dead-end mid-map.
     3. Place a FEW settlements (villages, an optional castle) on good ground.
     4. Route a SPARSE road network: a spanning tree that connects the
        settlements to each other and one road out to a board edge. Roads
        avoid mountains/water, bridge rivers, and merge into junctions.
     5. Add 1–2 minor TRAILS branching off to a lone feature (a forest, a
        mountain pass). Most of the board stays open terrain.

   Realisation: every cell's edges are known exactly (and shared edges are
   written to BOTH neighbours, so connectors always match). Each cell becomes a
   bespoke `gen~…` tile carrying precisely those connectors — the procedural
   renderer (tile-render.js) draws the roads/trails/rivers from that edge data,
   so any junction shape connects and looks right. Plain cells reuse the
   library's blank biome tiles.  Dual-context (window / worker / node).
   ========================================================================== */
(function (root) {
  'use strict';
  const TE = root.TileEngine || (typeof require !== 'undefined' && require('./tile-engine.js'));
  const P = TE.PATH, B = TE.BIOME, gridFor = TE.gridFor, keyOf = TE.keyOf, NATURAL = TE.NATURAL, pairKey = TE.pairKey;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const GEN = 'gen~';

  /* start-map THEMES — a dominant base biome + how much of each accent to sprinkle.
     `mixed` (and no theme) uses the original balanced generator instead. */
  const THEMES = {
    forest:    { base: B.FOREST,    water: 0.05, mtn: 0.06, forest: 0,    clearing: 0.16, snow: false, rocks: 1, rivers: 1 },
    grassland: { base: B.PLAINS,    water: 0.06, mtn: 0.05, forest: 0.12, clearing: 0,    snow: false, rocks: 1, rivers: 1 },
    desert:    { base: B.SAND,      water: 0.03, mtn: 0.06, forest: 0,    clearing: 0,    snow: false, rocks: 4, rivers: 0 },
    mountains: { base: B.MOUNTAINS, water: 0.04, mtn: 0,    forest: 0.10, clearing: 0.15, snow: true,  rocks: 5, rivers: 1 },
    wetlands:  { base: B.PLAINS,    water: 0.34, mtn: 0.03, forest: 0.10, clearing: 0,    snow: false, rocks: 1, rivers: 2 },
  };

  /* ---- synthesise (or reuse) a tile carrying an exact edge signature ---- */
  function genId(gridKind, biome, sig, feat) {
    return GEN + gridKind + '~' + biome + '~' + sig.join('.') + '~' + (feat || '');
  }
  function registerGen(defs, gridKind, biome, sig, feat) {
    const id = genId(gridKind, biome, sig, feat);
    if (!defs[id]) {
      const def = { id, biome, edges: sig.map(p => ({ path: p, biome })), gen: true };
      if (feat) def.feature = feat;
      if (biome === B.CITY) def.transition = true;         // a keep/castle bridges into its field
      defs[id] = def;
    }
    return id;
  }
  // rebuild any gen~ tiles referenced by a loaded board but missing from `defs`
  function hydrateGenerated(defs, gridKind, board) {
    for (const [, pl] of board) {
      const id = pl.defId;
      if (typeof id !== 'string' || id.indexOf(GEN) !== 0 || defs[id]) continue;
      const parts = id.split('~');                          // gen ~ grid ~ biome ~ p.p.p ~ feat
      const biome = parts[2], sig = parts[3].split('.').map(Number), feat = parts[4] || '';
      registerGen(defs, parts[1] || gridKind, biome, sig, feat);
    }
  }

  /* chain a bag of [ [x,z],[x,z] ] wall segments into continuous polyline runs (shared corners) */
  const _ck = (p) => (Math.round(p[0] * 1000) / 1000) + '|' + (Math.round(p[1] * 1000) / 1000);
  function chainSegments(segs) {
    const pt = new Map(), adj = new Map(), used = new Set();
    const eid = (a, b) => a < b ? a + '#' + b : b + '#' + a;
    for (const [A, B] of segs) { const ka = _ck(A), kb = _ck(B); if (ka === kb) continue;
      pt.set(ka, A); pt.set(kb, B); (adj.get(ka) || adj.set(ka, new Set()).get(ka)).add(kb); (adj.get(kb) || adj.set(kb, new Set()).get(kb)).add(ka); }
    const runs = [], starts = [...adj.keys()].sort((a, b) => adj.get(a).size - adj.get(b).size); // endpoints (deg 1) first, then loops
    for (const s of starts) for (const nb of [...adj.get(s)]) {
      if (used.has(eid(s, nb))) continue;
      const run = [pt.get(s)]; let cur = s, nxt = nb;
      while (nxt != null) { used.add(eid(cur, nxt)); run.push(pt.get(nxt)); let cont = null;
        for (const nn of adj.get(nxt)) if (!used.has(eid(nxt, nn))) { cont = nn; break; }
        cur = nxt; nxt = cont; }
      if (run.length >= 2) runs.push(run);
    }
    return runs;
  }

  /* ring a set of cells with a city WALL, leaving a gap wherever a road/river crosses (the gate).
     cellOf(k)→cell, posOf(k)→{x,z}, edgesOf(k)→edge-path array. Returns freeform wall draw strokes. */
  function ringWall(townCells, cellOf, posOf, g, edgesOf, N) {
    const cornersW = (k) => { const p = posOf(k); return g.corners().map(cn => [p.x + cn[0], p.z + cn[1]]); };
    const edgeCorners = (k, dir) => {
      const [ex, ez] = g.edgeMid(dir), p = posOf(k), mx = p.x + ex, mz = p.z + ez, C = cornersW(k);
      let best = null, bd = Infinity;
      for (let i = 0; i < C.length; i++) { const a = C[i], b = C[(i + 1) % C.length];
        const d = ((a[0] + b[0]) / 2 - mx) ** 2 + ((a[1] + b[1]) / 2 - mz) ** 2; if (d < bd) { bd = d; best = [a, b]; } }
      return best;
    };
    const segs = [];
    for (const k of townCells) { const c = cellOf(k);
      for (let d = 0; d < N; d++) { const nk = keyOf(g.step(c, d));
        if (townCells.has(nk)) continue;                                    // interior wall → skip
        const ep = edgesOf(k)[d]; if (ep === P.ROAD || ep === P.RIVER) continue;   // gate gap where a road/river crosses
        const ec = edgeCorners(k, d); if (ec) segs.push(ec); } }
    const out = [];
    for (const run of chainSegments(segs)) if (run.length >= 2) out.push({ type: 'wall', pts: run });
    return out;
  }

  /* trace the ROAD/RIVER/TRAIL tile-edge network into CONTINUOUS swept polyline strokes (like the hand-drawn
     ones) so generated paths don't render as per-tile ribbons that truncate & misalign at tile joins. Each
     path edge → a centre→centre segment; a spill off the board → a centre→edge-midpoint segment; chainSegments
     joins them into runs (breaking at junctions, which then overlap + get a merge plate like drawn Y's). The
     tile edges STAY set (gameplay/boardToGraph) — only the RENDER moves to strokes. */
  function tracePathStrokes(cellKeys, cellOf, posOf, edgesOf, g) {
    const N = g.N, cset = new Set(cellKeys), out = [];
    for (const [pathVal, typeName] of [[P.RIVER, 'river'], [P.TRAIL, 'trail'], [P.ROAD, 'road']]) {
      const segs = [];
      for (const k of cellKeys) { const e = edgesOf(k); if (!e) continue; const c = cellOf(k), pk = posOf(k);
        for (let d = 0; d < N; d++) { if (e[d] !== pathVal) continue; const nk = keyOf(g.step(c, d));
          if (cset.has(nk)) { if (k < nk) { const pn = posOf(nk); segs.push([[pk.x, pk.z], [pn.x, pn.z]]); } }   // centre→centre (dedupe)
          else { const em = g.edgeMid(d); segs.push([[pk.x, pk.z], [pk.x + em[0], pk.z + em[1]]]); } } }        // spill off-board
      for (const run of chainSegments(segs)) if (run.length >= 2) out.push({ type: typeName, pts: run });
    }
    return out;
  }

  /* ================= the generator ================= */
  function generateMap(gridKind, board, cells, defs, opts) {
    opts = opts || {};
    const g = gridFor(gridKind), N = g.N;
    const rng = TE.mulberry32((opts.seed || 1) >>> 0);
    const ri = (n) => Math.floor(rng() * n);

    // --- cell bookkeeping ---
    const keys = cells.map(keyOf);
    const cset = new Set(keys);
    const cellOf = {}, pos = {};
    cells.forEach(c => { const k = keyOf(c); cellOf[k] = c; pos[k] = g.world(c); });
    const nbrs = (k) => { const c = cellOf[k], out = []; for (let d = 0; d < N; d++) { const nk = keyOf(g.step(c, d)); if (cset.has(nk)) out.push({ k: nk, dir: d }); } return out; };
    const offDirs = (k) => { const c = cellOf[k], out = []; for (let d = 0; d < N; d++) { if (!cset.has(keyOf(g.step(c, d)))) out.push(d); } return out; };
    const isBorder = (k) => offDirs(k).length > 0;
    const d2 = (a, b) => { const p = pos[a], q = pos[b], dx = p.x - q.x, dz = p.z - q.z; return dx * dx + dz * dz; };
    const nearBlob = (k, arr) => { let m = Infinity; for (const b of arr) m = Math.min(m, d2(k, b)); return m; };
    // map centre + extent
    let cx = 0, cz = 0; keys.forEach(k => { cx += pos[k].x; cz += pos[k].z; }); cx /= keys.length; cz /= keys.length;
    let span = 0; keys.forEach(k => { const dx = pos[k].x - cx, dz = pos[k].z - cz; span = Math.max(span, Math.hypot(dx, dz)); });
    span = span || 1;

    // --- per-cell state we build up, then realise ---
    const biome = {}, edges = {}, feature = {};
    keys.forEach(k => { biome[k] = B.PLAINS; edges[k] = new Array(N).fill(P.NONE); });
    // write a connector onto the shared edge (k,dir) — mirror onto the neighbour so both agree
    function setEdge(k, dir, path) {
      edges[k][dir] = path;
      const nk = keyOf(g.step(cellOf[k], dir));
      if (cset.has(nk)) edges[nk][g.opposite(dir)] = path;
    }
    // the dir from cell a to adjacent cell b (or -1)
    function dirTo(a, b) { for (let d = 0; d < N; d++) if (keyOf(g.step(cellOf[a], d)) === b) return d; return -1; }

    /* ---- 1. biome blobs (region-grow so they're coherent; theme skews the mix) ---- */
    const taken = new Set();
    // per-cell deterministic jitter (stable per seed) — added to the grow front so blobs come out ORGANIC/lumpy
    // instead of perfect discs that clip the board into diagonal stripes. Higher JIT = more irregular.
    const JIT = 5.0;
    const _jit = {}; keys.forEach(k => { const c = cellOf[k];
      _jit[k] = ((Math.imul(((c.q * 73856) ^ (c.r * 19349)) >>> 0, 2654435761) ^ (((opts.seed || 1) * 2246822519) >>> 0)) >>> 0) / 4294967295; });
    function grow(seed, size, avoid) {
      const out = [], used = new Set([seed]), q = [seed];
      while (q.length && out.length < size) {
        q.sort((a, b) => (d2(a, seed) + _jit[a] * JIT) - (d2(b, seed) + _jit[b] * JIT));   // nearest-first + jitter → a lumpy, natural blob
        const k = q.shift();
        if (avoid && avoid(k)) continue;
        out.push(k);
        for (const { k: nk } of nbrs(k)) if (!used.has(nk)) { used.add(nk); q.push(nk); }
      }
      return out;
    }
    const areaOf = (frac, min) => Math.max(min, Math.round(keys.length * frac));
    const nearWater = (k) => nbrs(k).some(n => waterSet.has(n.k)) || waterSet.has(k);

    // water: a blob hugging one board edge/corner
    const border = keys.filter(isBorder);
    const corners = border.slice().sort((a, b) => (Math.abs(pos[b].x - cx) + Math.abs(pos[b].z - cz)) - (Math.abs(pos[a].x - cx) + Math.abs(pos[a].z - cz)));
    let water, waterSet, mtn, mtnSet, forest, forestSet;

    const TH = (opts.theme && opts.theme !== 'mixed') ? THEMES[opts.theme] : null;
    if (TH) {
      /* ---- themed layout: a dominant base biome + smaller accents skewed by the theme ---- */
      const base = TH.base;
      keys.forEach(k => { biome[k] = base; });                              // whole section skews to the theme
      // water
      const wSeed = corners[ri(Math.max(1, Math.min(4, corners.length)))];
      water = TH.water > 0 ? grow(wSeed, areaOf(TH.water, 3), null) : [];
      waterSet = new Set(water); water.forEach(k => { biome[k] = B.WATER; feature[k] = 'water'; taken.add(k); });
      // mountains  (whole map is highland when the theme's base is mountains)
      if (base === B.MOUNTAINS) { mtn = keys.filter(k => !waterSet.has(k)); }
      else if (TH.mtn > 0) {
        const nw = keys.filter(k => !waterSet.has(k));
        const ms = nw.slice().sort((a, b) => nearBlob(b, water) - nearBlob(a, water))[ri(Math.max(1, Math.min(4, nw.length)))];
        mtn = grow(ms, areaOf(TH.mtn, 3), k => waterSet.has(k)); mtn.forEach(k => biome[k] = B.MOUNTAINS);
      } else mtn = [];
      mtnSet = new Set(mtn); mtn.forEach(k => taken.add(k));
      // forest  (base already forest when the theme is Forest → collect those cells)
      if (base === B.FOREST) { forest = keys.filter(k => biome[k] === B.FOREST); }
      else if (TH.forest > 0) {
        const fp = keys.filter(k => !waterSet.has(k) && !mtnSet.has(k));
        const fs = fp.slice().sort((a, b) => (nearBlob(b, water) + nearBlob(b, mtn) * 0.3) - (nearBlob(a, water) + nearBlob(a, mtn) * 0.3))[0];
        forest = fs ? grow(fs, areaOf(TH.forest, 3), k => waterSet.has(k) || mtnSet.has(k)) : []; forest.forEach(k => biome[k] = B.FOREST);
      } else forest = [];
      forestSet = new Set(forest); forest.forEach(k => taken.add(k));
      // clearing: a central plains valley so a forest/mountain theme still has buildable ground
      if (TH.clearing > 0) {
        const cp = keys.filter(k => !waterSet.has(k));
        const cs = cp.slice().sort((a, b) => Math.hypot(pos[a].x - cx, pos[a].z - cz) - Math.hypot(pos[b].x - cx, pos[b].z - cz))[0];
        if (cs) grow(cs, areaOf(TH.clearing, 3), k => waterSet.has(k)).forEach(k => { biome[k] = B.PLAINS; mtnSet.delete(k); forestSet.delete(k); taken.delete(k); });
        mtn = mtn.filter(k => mtnSet.has(k)); forest = forest.filter(k => forestSet.has(k));
      }
      // snow cap on the highest mountains
      if (TH.snow && mtn.length >= 4) {
        const snowSeed = mtn.slice().sort((a, b) => Math.hypot(pos[b].x - cx, pos[b].z - cz) - Math.hypot(pos[a].x - cx, pos[a].z - cz)).find(k => !nearWater(k));
        if (snowSeed) grow(snowSeed, clamp(Math.round(mtn.length * 0.35), 1, 6), k => !mtnSet.has(k) || nearWater(k)).forEach(k => biome[k] = B.SNOW);
      }
      // rocks: foothills by the mountains, or (desert) bare outcrops on the sand
      let rockPool = keys.filter(k => !taken.has(k) && biome[k] !== B.SNOW && !nearWater(k) && nbrs(k).some(n => mtnSet.has(n.k)));
      if (rockPool.length < (TH.rocks || 0)) rockPool = rockPool.concat(keys.filter(k => !taken.has(k) && biome[k] === base && !nearWater(k)).slice(0, 12));
      for (let i = 0; i < Math.min(TH.rocks || 0, rockPool.length); i++) { if (rng() < 0.7) { biome[rockPool[i]] = B.ROCKS; taken.add(rockPool[i]); } }
    } else {
      // water: a blob hugging one board edge/corner
      const waterSeed = corners[ri(Math.max(1, Math.min(4, corners.length)))];
      water = grow(waterSeed, areaOf(0.14, 3), null);
      waterSet = new Set(water); water.forEach(k => { biome[k] = B.WATER; feature[k] = 'water'; taken.add(k); });
      // mountains: a blob well away from the water
      const notWater = keys.filter(k => !waterSet.has(k));
      const mtnSeed = notWater.slice().sort((a, b) => nearBlob(b, water) - nearBlob(a, water))[ri(Math.max(1, Math.min(4, notWater.length)))];
      mtn = grow(mtnSeed, areaOf(0.13, 3), k => waterSet.has(k));
      mtnSet = new Set(mtn); mtn.forEach(k => { biome[k] = B.MOUNTAINS; taken.add(k); });
      // forest: a blob away from water (may touch mountains — natural)
      const forestPool = keys.filter(k => !waterSet.has(k) && !mtnSet.has(k));
      const forSeed = forestPool.slice().sort((a, b) => (nearBlob(b, water) + nearBlob(b, mtn) * 0.3) - (nearBlob(a, water) + nearBlob(a, mtn) * 0.3))[0];
      forest = grow(forSeed, areaOf(0.17, 3), k => waterSet.has(k) || mtnSet.has(k));
      forestSet = new Set(forest); forest.forEach(k => { biome[k] = B.FOREST; taken.add(k); });
      // snow: a small cap on the mountain fringe farthest from centre (never touching water)
      if (mtn.length >= 5) {
        const snowSeed = mtn.slice().sort((a, b) => (Math.hypot(pos[b].x - cx, pos[b].z - cz)) - (Math.hypot(pos[a].x - cx, pos[a].z - cz))).find(k => !nearWater(k));
        if (snowSeed) grow(snowSeed, clamp(Math.round(mtn.length * 0.4), 1, 4), k => !mtnSet.has(k) || nearWater(k)).forEach(k => biome[k] = B.SNOW);
      }
      // rocks: a couple of foothill cells adjacent to the mountains (not by water)
      const foothills = keys.filter(k => !taken.has(k) && !nearWater(k) && nbrs(k).some(n => mtnSet.has(n.k)));
      for (let i = 0; i < Math.min(3, foothills.length); i++) { if (rng() < 0.6) biome[foothills[i]] = B.ROCKS; }
    }

    /* ---- 2. rivers (1–2), edge → edge, flowing down-slope & meandering ---- */
    // elevation: high in the mountains, low toward the water — rivers flow high→low
    const elev = {}; keys.forEach(k => { elev[k] = (mtn.length ? 1 / (1 + Math.sqrt(nearBlob(k, mtn))) : 0) - (water.length ? 0.8 / (1 + Math.sqrt(nearBlob(k, water))) : 0); });
    const riverSet = new Set();
    const themeRivers = TH ? TH.rivers : (keys.length > 46 ? 2 : 1);
    const nRivers = opts.rivers != null ? opts.rivers
      : opts.stream === false ? 0
      : opts.stream === true ? Math.max(1, themeRivers)
      : themeRivers;
    const doRoads = opts.road !== false;
    function dijkstra(src, dst, cost) {
      const dist = { [src]: 0 }, prev = {}, pq = [[0, src]];
      while (pq.length) {
        pq.sort((a, b) => a[0] - b[0]); const [d, k] = pq.shift();
        if (k === dst) break; if (d > (dist[k] ?? Infinity)) continue;
        for (const { k: nk } of nbrs(k)) { const c = cost(nk, k); if (!isFinite(c)) continue; const nd = d + c; if (nd < (dist[nk] ?? Infinity)) { dist[nk] = nd; prev[nk] = k; pq.push([nd, nk]); } }
      }
      if (dist[dst] == null) return null;
      const path = [dst]; let k = dst; while (k !== src) { k = prev[k]; path.push(k); } return path.reverse();
    }
    for (let r = 0; r < nRivers; r++) {
      // source: a border cell nearest the mountains; target: a far border cell nearest the water
      const src = border.slice().filter(k => !waterSet.has(k)).sort((a, b) => (mtn.length ? nearBlob(a, mtn) - nearBlob(b, mtn) : 0))[ri(3) % Math.max(1, border.length)];
      let tgtPool = border.filter(k => k !== src && !waterSet.has(k) && d2(k, src) > (span * 0.9) * (span * 0.9));
      if (!tgtPool.length) tgtPool = border.filter(k => k !== src && !waterSet.has(k));
      const tgt = tgtPool.sort((a, b) => (water.length ? nearBlob(a, water) - nearBlob(b, water) : d2(b, src) - d2(a, src)))[0];
      if (!src || !tgt) continue;
      // cost: flow downhill (+elev), meander (+jitter), avoid other rivers & water bodies
      const path = dijkstra(src, tgt, (nk) => waterSet.has(nk) ? Infinity : riverSet.has(nk) ? Infinity : 1 + Math.max(0, elev[nk]) * 3 + rng() * 1.1);
      if (!path || path.length < 2) continue;
      for (const k of path) { riverSet.add(k); biome[k] = B.PLAINS; feature[k] = feature[k] === 'water' ? feature[k] : undefined; }
      for (let i = 0; i < path.length - 1; i++) setEdge(path[i], dirTo(path[i], path[i + 1]), P.RIVER);
      // each end flows INTO an adjacent lake if there is one (no dangling stream beside the water);
      // otherwise it spills off the board edge so it clearly flows through, not dead-ends.
      [path[0], path[path.length - 1]].forEach(end => {
        const waterNb = nbrs(end).find(n => waterSet.has(n.k));
        if (waterNb) setEdge(end, waterNb.dir, P.RIVER);
        else { const od = offDirs(end); if (od.length) setEdge(end, od[ri(od.length)], P.RIVER); }
      });
    }

    /* ---- 3. settlements on good ground, well spread ---- */
    const onShore = (k) => nbrs(k).some(n => waterSet.has(n.k));
    const buildable = (k) => !waterSet.has(k) && !mtnSet.has(k) && !riverSet.has(k) && !onShore(k) && biome[k] !== B.SNOW && biome[k] !== B.ROCKS;
    const cand = keys.filter(k => buildable(k) && !nbrs(k).some(n => mtnSet.has(n.k)));   // villages don't abut mountains (no natural pair)
    const nSet = clamp(opts.settlements != null ? opts.settlements : Math.round(keys.length / 26), 2, 4);
    const settlements = [];
    if (cand.length) {
      settlements.push(cand.slice().sort((a, b) => (Math.hypot(pos[a].x - cx, pos[a].z - cz)) - (Math.hypot(pos[b].x - cx, pos[b].z - cz)))[0]); // one central
      while (settlements.length < nSet && settlements.length < cand.length) {
        let best = null, bestD = -1;
        for (const k of cand) { if (settlements.includes(k)) continue; const md = Math.min(...settlements.map(s => d2(k, s))); if (md > bestD) { bestD = md; best = k; } }
        if (best == null) break; settlements.push(best);
      }
    }
    const settleSet = new Set(settlements);
    // SETTLEMENT SIZE: at 5-ft BATTLE scale a 1-cell "village" or 3-cell "town" is absurdly small, so grow each
    // settlement into a blob sized as a FRACTION OF THE WHOLE BOARD (opts.battle). World scale keeps the compact
    // region-symbol footprint. growBlob() BFS-grows a compact blob from a seed over buildable, unclaimed cells.
    const battle = !!opts.battle, NC = keys.length;
    // opts.townSize (cells) lets the caller size the central town explicitly — so a big board doesn't get a tiny
    // town. 0/undefined = auto. When set, villages & the castle scale with it so the whole settlement reads right.
    const forceTown = Math.max(0, Math.round(opts.townSize || 0));
    const townTarget    = forceTown > 0 ? clamp(forceTown, 1, NC) : (battle ? clamp(Math.round(NC * 0.08), 6, 60) : (keys.length >= 64 ? 3 : 2));
    const villageTarget = forceTown > 0 ? clamp(Math.round(forceTown * 0.45), 2, NC) : (battle ? clamp(Math.round(NC * 0.03), 3, 18) : 1);
    const castleTarget  = forceTown > 0 ? clamp(Math.round(forceTown * 0.7), 3, NC)  : (battle ? clamp(Math.round(NC * 0.05), 4, 24) : 1);
    const grownSettle   = battle || forceTown > 0;   // grow blobs (vs the compact 1-cell region symbol) whenever a size is forced OR at battle scale
    function growBlob(seed, target, claimed){ const blob = new Set([seed]); claimed.add(seed);
      while (blob.size < target){ const ring = [];
        for (const k of blob){ const c = cellOf[k];
          for (let d = 0; d < N; d++){ const nk = keyOf(g.step(c, d)); if (blob.has(nk) || claimed.has(nk) || !cellOf[nk] || !buildable(nk)) continue; ring.push(nk); } }   // cellOf guard = stay on the board
        if (!ring.length) break;
        ring.sort((a, b) => d2(a, seed) - d2(b, seed));                       // compact, roughly round blob
        for (const nk of ring){ if (blob.size >= target) break; if (blob.has(nk) || claimed.has(nk)) continue; blob.add(nk); claimed.add(nk); } }
      return blob; }
    const claimed = new Set(settlements);
    // TOWN: the central settlement grows into a cluster that gets a ringed city WALL (built after roads, §4b)
    const townCells = new Set();
    if (settlements.length) {
      if (grownSettle) growBlob(settlements[0], townTarget, claimed).forEach(k => townCells.add(k));
      else { townCells.add(settlements[0]);
        nbrs(settlements[0]).map(n => n.k).filter(k => buildable(k) && !settleSet.has(k))
          .sort((a, b) => Math.hypot(pos[a].x - cx, pos[a].z - cz) - Math.hypot(pos[b].x - cx, pos[b].z - cz))
          .forEach(k => { if (townCells.size < townTarget) { townCells.add(k); claimed.add(k); } }); }
    }
    // optional castle: a NON-town settlement nearest the mountains becomes a keep + (in battle) a walled compound
    let castle = null; const castleCells = new Set();
    if (settlements.length >= 3 && mtn.length) {
      castle = settlements.slice(1).sort((a, b) => nearBlob(a, mtn) - nearBlob(b, mtn))[0];
      if (castle) { if (grownSettle) growBlob(castle, castleTarget, claimed).forEach(k => castleCells.add(k)); else castleCells.add(castle);
        for (const k of castleCells) { biome[k] = B.CITY; feature[k] = 'buildings'; } feature[castle] = 'keep';
        // ring the castle grounds with variety — orchards/gardens + a few trees — so its surroundings aren't plain
        const cring = new Set(); for (const k of castleCells) for (const { k: nk } of nbrs(k)) if (!castleCells.has(nk) && !settleSet.has(nk)) cring.add(nk);
        for (const nk of cring){ if (waterSet.has(nk) || mtnSet.has(nk)) continue; const rv = rng();
          if (rv < 0.42){ biome[nk] = B.ORCHARD; feature[nk] = undefined; }
          else if (rv < 0.6){ biome[nk] = B.FOREST; feature[nk] = 'trees'; } }
      }
    }
    // VILLAGES: every remaining settlement grows a small blob of houses (ring wall added in §4b)
    const villageBlobs = [];
    for (const vk of settlements) { if (townCells.has(vk) || castleCells.has(vk)) continue;
      const blob = grownSettle ? growBlob(vk, villageTarget, claimed) : new Set([vk]);
      for (const k of blob) { biome[k] = B.VILLAGE; feature[k] = 'houses'; }
      villageBlobs.push(blob); }

    /* ---- 4. sparse road network: a spanning tree over settlements + 1 edge exit ---- */
    const roadCost = (nk) => {
      if (waterSet.has(nk) || mtnSet.has(nk)) return Infinity;      // roads route around mountains & water
      let c = 1;
      const bm = biome[nk];
      if (bm === B.FOREST) c = 2.6; else if (bm === B.ROCKS || bm === B.SNOW) c = 1.6; else if (bm === B.VILLAGE || bm === B.CITY) c = 0.6;
      if (edges[nk].includes(P.ROAD)) c = 0.35;                     // reuse roads → merge into junctions, not parallels
      if (riverSet.has(nk)) c += 3;                                 // a bridge
      return c;
    };
    // one road exit to a board edge (a border plains/forest cell away from the settlements)
    const exitPool = border.filter(k => buildable(k) && !settleSet.has(k));
    const exit = exitPool.length ? exitPool.sort((a, b) => (settlements.length ? nearBlob(b, settlements) - nearBlob(a, settlements) : 0))[0] : null;
    const terminals = settlements.concat(exit ? [exit] : []);
    const roadCells = new Set();
    function layRoad(pathKeys) {
      for (const k of pathKeys) roadCells.add(k);
      for (let i = 0; i < pathKeys.length - 1; i++) setEdge(pathKeys[i], dirTo(pathKeys[i], pathKeys[i + 1]), P.ROAD);
    }
    if (doRoads && terminals.length >= 2) {
      const connected = [terminals[0]];
      const rest = terminals.slice(1);
      while (rest.length) {
        // connect the nearest still-unconnected terminal to the tree (Prim's, path-cost distance)
        let bestPath = null, bestCost = Infinity, bestIdx = -1;
        for (let i = 0; i < rest.length; i++) {
          for (const src of connected) {
            const path = dijkstra(src, rest[i], roadCost);
            if (path) { const c = path.length; if (c < bestCost) { bestCost = c; bestPath = path; bestIdx = i; } }
          }
        }
        if (!bestPath) { rest.shift(); continue; }
        layRoad(bestPath);
        connected.push(rest[bestIdx]); rest.splice(bestIdx, 1);
      }
      // exit spills off the board
      if (exit && roadCells.has(exit)) { const od = offDirs(exit); if (od.length) setEdge(exit, od[ri(od.length)], P.ROAD); }
      // GUARANTEE the castle has its OWN road out to the nearest board edge (never a dead-end; extends cleanly)
      if (castle){
        const cexit = border.filter(k => (buildable(k) || k===castle) && !castleCells.has(k)).sort((a, b) => d2(a, castle) - d2(b, castle))[0];
        if (cexit){ const path = dijkstra(castle, cexit, roadCost); if (path){ layRoad(path); const od = offDirs(cexit); if (od.length) setEdge(cexit, od[ri(od.length)], P.ROAD); } }
      }
    }
    // a plains road leaf (a dead-end that isn't a village/castle/exit) becomes a farm
    roadCells.forEach(k => {
      if (settleSet.has(k) || townCells.has(k) || k === exit) return;
      const roadN = edges[k].filter(p => p === P.ROAD).length;
      if (roadN === 1 && biome[k] === B.PLAINS && !riverSet.has(k)) feature[k] = 'farm';
    });

    /* ---- 4b. walled TOWN: ring the town cluster with a city wall, leaving a gate where a road enters ---- */
    const walls = [];   // freeform draw strokes {type:'wall', pts:[[x,z]…]} in g.world frame
    if (townCells.size) {
      for (const k of townCells) { biome[k] = B.CITY; feature[k] = 'buildings'; }
      const cornersW = (k) => g.corners().map(cn => [pos[k].x + cn[0], pos[k].z + cn[1]]);
      const edgeCorners = (k, dir) => {                          // the two corner points bounding edge `dir`
        const [ex, ez] = g.edgeMid(dir), mx = pos[k].x + ex, mz = pos[k].z + ez, C = cornersW(k);
        let best = null, bd = Infinity;
        for (let i = 0; i < C.length; i++) { const a = C[i], b = C[(i + 1) % C.length];
          const d = ((a[0] + b[0]) / 2 - mx) ** 2 + ((a[1] + b[1]) / 2 - mz) ** 2; if (d < bd) { bd = d; best = [a, b]; } }
        return best;
      };
      const segs = [];
      for (const k of townCells) { const c = cellOf[k];
        for (let d = 0; d < N; d++) { const nk = keyOf(g.step(c, d));
          if (townCells.has(nk)) continue;                       // interior wall → skip
          if (edges[k][d] === P.ROAD || edges[k][d] === P.RIVER) continue;   // a road/river crossing = the gate → leave a gap
          segs.push(edgeCorners(k, d)); } }
      for (const run of chainSegments(segs)) if (run.length >= 2) walls.push({ type: 'wall', pts: run });
    }
    // villages get a ring wall too (with a gate gap where a road/river crosses)
    for (const vk of settlements) { if (townCells.has(vk) || vk === castle) continue;
      ringWall(new Set([vk]), k => cellOf[k], k => pos[k], g, k => edges[k], N).forEach(w => walls.push(w)); }

    /* ---- 5. one or two trails off to a lone feature (forest / mountain pass) ---- */
    const trailCost = (nk) => {
      if (waterSet.has(nk)) return Infinity;
      let c = 1;
      const bm = biome[nk];
      if (bm === B.MOUNTAINS) c = 2.2; else if (bm === B.FOREST) c = 1.2; else if (bm === B.ROCKS || bm === B.SNOW) c = 1.4;
      if (edges[nk].includes(P.TRAIL)) c = 0.4;
      if (edges[nk].includes(P.ROAD) || edges[nk].includes(P.RIVER)) c += 2.5;   // avoid running on roads/rivers
      return c;
    };
    const trailStarts = roadCells.size ? [...roadCells] : settlements.slice();
    const featureTargets = [];
    const deepForest = forest.slice().sort((a, b) => nearBlob(b, forest.filter(x => isBorder(x))) - nearBlob(a, forest.filter(x => isBorder(x))));
    if (mtn.length) featureTargets.push(mtn.slice().sort((a, b) => nearBlob(a, trailStarts) - nearBlob(b, trailStarts))[0]);
    if (forest.length) featureTargets.push(deepForest[0]);
    let trailsLaid = 0;
    for (const tgt of featureTargets) {
      if (!doRoads || trailsLaid >= 2 || !tgt || !trailStarts.length) break;
      const start = trailStarts.slice().sort((a, b) => d2(a, tgt) - d2(b, tgt))[0];
      if (start === tgt) continue;
      const path = dijkstra(start, tgt, trailCost);
      if (!path || path.length < 2) continue;
      for (let i = 0; i < path.length - 1; i++) setEdge(path[i], dirTo(path[i], path[i + 1]), P.TRAIL);
      trailsLaid++;
    }

    /* ---- 5a. retract any TRAIL that dead-ends on bare open ground — a footpath must reach somewhere:
       a destination (forest / mountain / rocks / snow / water / settlement), a road it joins, or off the
       map (a trailhead). A tip left in an empty plains/sand field reads as a "path to nowhere", so we trim
       it back cell-by-cell until it meets a justified cell. Trails to forests/mountains are the intended
       look and are never touched (they are justified by their destination biome). ---- */
    {
      const trailJustified = (k) => {
        const bm = biome[k];
        if (bm===B.FOREST||bm===B.MOUNTAINS||bm===B.ROCKS||bm===B.SNOW||bm===B.WATER||bm===B.VILLAGE||bm===B.CITY) return true;
        if (settleSet.has(k) || townCells.has(k)) return true;
        if (edges[k].includes(P.ROAD) || edges[k].includes(P.RIVER)) return true;   // joins a road/ford
        for (const d of offDirs(k)) if (edges[k][d]===P.TRAIL) return true;          // a trailhead leaving the map is fine
        return false;
      };
      let changed = true, guard = 0;
      while (changed && guard++ < 400) { changed = false;
        for (const k of keys) {
          let one = -1, cnt = 0;
          for (let d=0; d<N; d++) if (edges[k][d]===P.TRAIL){ cnt++; one=d; }
          if (cnt===1 && !trailJustified(k)) { setEdge(k, one, P.NONE); changed = true; }   // trim the pointless tip
        }
      }
    }

    /* ---- 5b. farmland: patches of crop rows / orchards / centre-pivot circles on open plains ("farms
       from the air") near settlements & irrigation water. Painted top-down tiles, mixed per-cell for a patchwork. */
    const farmVar = {};                                   // per-cell field variant (crops 0–2, orchard 0–1, pivot 0–1)
    if (opts.farms !== false) {
      const anchor = settlements.concat([...townCells]);
      const canFarm = (k) => biome[k] === B.PLAINS && !riverSet.has(k) && !settleSet.has(k) && !townCells.has(k)
        && feature[k] === undefined && k !== exit;
      let seeds = keys.filter(canFarm);
      if (anchor.length) { const near = seeds.filter(k => nearBlob(k, anchor) <= 9); if (near.length) seeds = near; }   // prefer within ~3 tiles of a settlement
      const nClusters = seeds.length ? 1 + ri(3) : 0;    // 1–3 farm districts
      for (let s = 0; s < nClusters && seeds.length; s++) {
        const start = seeds[ri(seeds.length)];
        const size = 3 + ri(5), grown = [start], gset = new Set(grown);   // 3–7 fields per district
        while (grown.length < size) {
          const cand = nbrs(grown[ri(grown.length)]).map(n => n.k).filter(k => canFarm(k) && !gset.has(k));
          if (!cand.length) break; const nk = cand[ri(cand.length)]; gset.add(nk); grown.push(nk);
        }
        for (const k of grown) {
          const nearW = water.length ? nearBlob(k, water) : 999, roll = rng();
          if ((nearW <= 9 && roll < 0.45) || roll < 0.14) { biome[k] = B.PIVOT;   farmVar[k] = ri(2); }   // pivot circles (love water; some dry-land)
          else if (roll < 0.4)                            { biome[k] = B.ORCHARD; farmVar[k] = ri(2); }   // orchards
          else                                            { biome[k] = B.CROPS;   farmVar[k] = ri(3); }   // crop rows (default)
          feature[k] = 'field';
        }
      }
    }

    /* ---- 5c. mountain-massif depth (0 = fringe/foothill, 1 = range core) so peaks grow toward the heart of
       the range and taper to foothills at its edge — no more a uniform grid of identical spikes. ---- */
    const mtnMass = {};
    { const dist = {}, front = [];
      keys.forEach(k => { if (biome[k] !== B.MOUNTAINS) { dist[k] = 0; front.push(k); } else if (isBorder(k)) { dist[k] = 1; front.push(k); } });
      let head = 0; while (head < front.length) { const k = front[head++];
        for (const { k: nk } of nbrs(k)) if (dist[nk] === undefined && biome[nk] === B.MOUNTAINS) { dist[nk] = dist[k] + 1; front.push(nk); } }
      let maxd = 2; keys.forEach(k => { if (biome[k] === B.MOUNTAINS && dist[k] > maxd) maxd = dist[k]; });
      keys.forEach(k => { if (biome[k] === B.MOUNTAINS) mtnMass[k] = Math.min(1, (dist[k] || 1) / maxd); });
    }

    /* ---- 5d. MOAT + drawbridge around the castle (toggle) — ring the castle grounds with water; where the
       castle's road crosses the ring the road rides over the water = a drawbridge (renderer bridges it). ---- */
    if (opts.moat && castle && castleCells.size){
      const moatRing = new Set();
      for (const k of castleCells) for (const { k: nk } of nbrs(k)) if (!castleCells.has(nk) && !settleSet.has(nk) && !townCells.has(nk)) moatRing.add(nk);
      for (const nk of moatRing){ if (mtnSet.has(nk)) continue;                         // don't drown a mountain
        biome[nk] = B.WATER; feature[nk] = (edges[nk] && edges[nk].includes(P.ROAD)) ? undefined : 'water'; }   // road-over-water cell = drawbridge
    }

    /* ---- 6. realise every cell as a connector-exact tile ---- */
    const defaultFeature = (bm) => ({ plains: 'tufts', forest: 'trees', mountains: 'peaks', village: 'houses', city: 'buildings', water: 'water' })[bm];
    board.clear();
    let placed = 0;
    for (const k of keys) {
      const sig = edges[k], bm = biome[k];
      let feat = feature[k] !== undefined ? feature[k] : defaultFeature(bm);
      if (sig.includes(P.ROAD) && sig.includes(P.RIVER)) feat = 'bridge';     // a road bridging the river
      const id = registerGen(defs, gridKind, bm, sig, feat);
      const rec = { defId: id, rot: 0 };
      if (mtnMass[k] !== undefined) rec.mass = mtnMass[k];
      if (farmVar[k] !== undefined) rec.variant = farmVar[k];
      board.set(k, rec);
      placed++;
    }
    // render roads/rivers/trails as CONTINUOUS swept strokes (not per-tile ribbons) — smooth, no truncation.
    const pathStrokes = tracePathStrokes(keys, k => cellOf[k], k => pos[k], k => edges[k], g);
    return { placed, draw: walls.concat(pathStrokes), settlements: settlements.length, town: townCells.size, rivers: nRivers, roads: roadCells.size, water: water.length, mountains: mtn.length, forest: forest.length };
  }

  /* ================= whole-map / zoom-in SETTLEMENT generator =========================================
     Fills `cells` with ONE coherent settlement — a castle, town or village — instead of wilderness. Used by
     the castle/town/village map THEMES (the whole board becomes that settlement) and by the click-to-zoom
     feature (drilling into a town/castle/village on a wilderness map regenerates the board as its detailed
     5-ft interior). Layout: a street network (radial avenues from a central plaza/keep + a gate), building
     lots between the streets (city buildings / village houses), and — for castle/town — a perimeter wall
     with a gate. Randomised by seed but always structured so it reads as a real settlement, and grid-agnostic
     (square + hex) via the same edge/wall/stroke machinery as generateMap. ---- */
  function generateSettlement(gridKind, board, cells, defs, opts){
    opts = opts || {};
    const g = gridFor(gridKind), N = g.N;
    const rng = TE.mulberry32((opts.seed || 1) >>> 0);
    const ri = (n) => Math.floor(rng() * n);
    const type = (opts.settlementType === 'castle' || opts.settlementType === 'village') ? opts.settlementType : 'town';
    const keys = cells.map(keyOf), cset = new Set(keys);
    const cellOf = {}, pos = {};
    cells.forEach(c => { const k = keyOf(c); cellOf[k] = c; pos[k] = g.world(c); });
    const nbrs = (k) => { const c = cellOf[k], out = []; for (let d = 0; d < N; d++){ const nk = keyOf(g.step(c, d)); if (cset.has(nk)) out.push({ k: nk, dir: d }); } return out; };
    const offDirs = (k) => { const c = cellOf[k], out = []; for (let d = 0; d < N; d++){ if (!cset.has(keyOf(g.step(c, d)))) out.push(d); } return out; };
    const isBorder = (k) => offDirs(k).length > 0;
    let cx = 0, cz = 0; keys.forEach(k => { cx += pos[k].x; cz += pos[k].z; }); cx /= (keys.length || 1); cz /= (keys.length || 1);
    const dCentre = (k) => Math.hypot(pos[k].x - cx, pos[k].z - cz);
    let maxR = 0; keys.forEach(k => { maxR = Math.max(maxR, dCentre(k)); }); maxR = maxR || 1;
    const d2 = (a, b) => { const p = pos[a], q = pos[b]; return (p.x - q.x) ** 2 + (p.z - q.z) ** 2; };

    const biome = {}, edges = {}, feature = {};
    keys.forEach(k => { biome[k] = B.GREEN; edges[k] = new Array(N).fill(P.NONE); });
    function setEdge(k, dir, path){ edges[k][dir] = path; const nk = keyOf(g.step(cellOf[k], dir)); if (cset.has(nk)) edges[nk][g.opposite(dir)] = path; }
    function dirTo(a, b){ for (let d = 0; d < N; d++) if (keyOf(g.step(cellOf[a], d)) === b) return d; return -1; }
    function dj(src, dst){ const dist = { [src]: 0 }, prev = {}, pq = [[0, src]];
      while (pq.length){ pq.sort((a, b) => a[0] - b[0]); const [d, k] = pq.shift(); if (k === dst) break; if (d > (dist[k] ?? 1e9)) continue;
        for (const { k: nk } of nbrs(k)){ const c = edges[nk].includes(P.ROAD) ? 0.4 : 1; const nd = d + c; if (nd < (dist[nk] ?? 1e9)){ dist[nk] = nd; prev[nk] = k; pq.push([nd, nk]); } } }
      if (dist[dst] == null) return null; const path = [dst]; let k = dst; while (k !== src){ k = prev[k]; path.push(k); } return path.reverse(); }

    if (!keys.length) { board.clear(); return { placed: 0, draw: [], settlementType: type }; }
    const centerK = keys.slice().sort((a, b) => dCentre(a) - dCentre(b))[0];
    const border = keys.filter(isBorder);
    const street = new Set();
    function layRoad(path){ if (!path) return; for (const k of path) street.add(k); for (let i = 0; i < path.length - 1; i++) setEdge(path[i], dirTo(path[i], path[i + 1]), P.ROAD); }

    // GATE: a border cell (front/south, roughly centred), where the main road leaves the settlement.
    const gate = border.slice().sort((a, b) => (pos[b].z - pos[a].z) || (Math.abs(pos[a].x - cx) - Math.abs(pos[b].x - cx)))[0];
    if (type === 'village'){
      // village = a through-road across the settlement (gate → centre → far side); no wall, houses strung along it.
      const far = border.slice().sort((a, b) => d2(b, gate) - d2(a, gate))[0];
      layRoad(dj(gate, centerK)); layRoad(dj(centerK, far));
    } else {
      // town / castle = radial avenues from the central plaza/keep out to spread border points (incl. the gate).
      const nSpokes = clamp(2 + Math.round(keys.length / 40), 3, 6);
      const byAngle = border.slice().sort((a, b) => Math.atan2(pos[a].z - cz, pos[a].x - cx) - Math.atan2(pos[b].z - cz, pos[b].x - cx));
      const targets = new Set([gate]);
      for (let i = 0; i < nSpokes && byAngle.length; i++) targets.add(byAngle[Math.floor(i * byAngle.length / nSpokes)]);
      for (const t of targets){ if (t !== centerK) layRoad(dj(centerK, t)); }
    }
    // the gate road spills off the board (so the wall leaves a real gateway there)
    { const od = offDirs(gate); if (od.length) setEdge(gate, od[ri(od.length)], P.ROAD); street.add(gate); }

    // centre: castle keep, or an open plaza for a town/village
    biome[centerK] = (type === 'castle') ? B.CITY : B.GREEN;
    if (type === 'castle') feature[centerK] = 'keep';

    // building lots on every non-street, non-centre cell
    for (const k of keys){ if (k === centerK) continue;
      if (street.has(k)){ biome[k] = B.GREEN; continue; }                                   // road runs over open ground
      if (type === 'village'){
        if (rng() < 0.55){ biome[k] = B.VILLAGE; feature[k] = 'houses'; } else biome[k] = B.GREEN;   // spread-out cottages + greens
      } else if (type === 'town'){
        if (isBorder(k) && rng() < 0.35){ biome[k] = B.VILLAGE; feature[k] = 'houses'; }              // humbler houses at the edge
        else if (rng() < 0.85){ biome[k] = B.CITY; feature[k] = 'buildings'; } else biome[k] = B.GREEN; // packed town blocks + a few squares
      } else {                                                                                          // CASTLE grounds — varied, not uniform green+buildings
        const rr = dCentre(k) / maxR, rv = rng();
        if (rr > 0.66){                                                                                 // outer bailey: curtain buildings + orchards + kitchen fields
          if (rv < 0.5){ biome[k] = B.CITY; feature[k] = 'buildings'; }
          else if (rv < 0.7){ biome[k] = B.ORCHARD; feature[k] = undefined; }                            // orchard / garden
          else if (rv < 0.85){ biome[k] = B.CROPS; feature[k] = undefined; }                             // kitchen fields
          else biome[k] = B.GREEN;
        } else if (rr < 0.32){                                                                           // courtyard around the keep: lawn + ornamental trees + a well/pond
          if (rv < 0.18){ biome[k] = B.FOREST; feature[k] = 'trees'; }
          else if (rv < 0.24){ biome[k] = B.WATER; feature[k] = 'water'; }
          else biome[k] = B.GREEN;
        } else {                                                                                         // inner ward: halls + gardens + greens
          if (rv < 0.55){ biome[k] = B.CITY; feature[k] = 'buildings'; }
          else if (rv < 0.72){ biome[k] = B.FOREST; feature[k] = 'trees'; }
          else biome[k] = B.GREEN;
        }
      }
    }

    // MOAT + DRAWBRIDGE (toggle) — the OUTERMOST ring of the plan becomes the water moat, which sits OUTSIDE the
    // curtain wall (the wall is moved one ring in, below). So it reads castle → wall → moat → countryside, not a
    // pool inside the keep. Where the gate road crosses the moat the road rides over water = a drawbridge.
    const moatOn = opts.moat && type !== 'village';
    if (moatOn){
      for (const k of keys){ if (!isBorder(k)) continue;                 // the plan's outer edge = the moat ring
        biome[k] = B.WATER;
        feature[k] = street.has(k) ? undefined : 'water';               // gate road over water = drawbridge; else plain moat
      }
    }

    // perimeter WALL with a gate gap (castle + town; villages stay open). With a moat the wall rings the INNER
    // cells (one in from the edge) so the moat sits OUTSIDE the wall; otherwise it rings the whole plan.
    const walls = [];
    if (type !== 'village'){ const wallSet = moatOn ? new Set(keys.filter(k => !isBorder(k))) : new Set(keys);
      ringWall(wallSet, k => cellOf[k], k => pos[k], g, k => edges[k], N).forEach(w => walls.push(w)); }

    // realise every cell as a connector-exact tile
    const defFeat = (bm) => ({ plains: 'tufts', forest: 'trees', mountains: 'peaks', village: 'houses', city: 'buildings', water: 'water' })[bm];
    board.clear(); let placed = 0;
    for (const k of keys){ const sig = edges[k], bm = biome[k];
      let feat = feature[k] !== undefined ? feature[k] : defFeat(bm);
      const id = registerGen(defs, gridKind, bm, sig, feat);
      board.set(k, { defId: id, rot: 0 }); placed++;
    }
    const pathStrokes = tracePathStrokes(keys, k => cellOf[k], k => pos[k], k => edges[k], g);
    return { placed, draw: walls.concat(pathStrokes), settlementType: type,
             buildings: keys.filter(k => biome[k] === B.CITY || biome[k] === B.VILLAGE).length };
  }

  /* ================= single-biome FILL — base-terrain tiles/mats ======================================
     Fill every cell with ONE biome (no roads/rivers/settlements) so a user can print a set of plain
     terrain pieces — e.g. a desert hex-tile set, a Flower Mat of all-forest hexes, or a Square Mat of
     nothing but water. Per-tile seed variation (rotation + scattered trees/peaks) + a random painted
     variant per cell keep the tiles from looking identical. Works on any grid + any TGC print size. ---- */
  function generateBiomeFill(gridKind, board, cells, defs, opts){
    opts = opts || {};
    const g = gridFor(gridKind), N = g.N;
    const rng = TE.mulberry32((opts.seed || 1) >>> 0);
    const biome = opts.biome || B.PLAINS;
    const feat = opts.feature !== undefined ? opts.feature
      : ({ plains:'tufts', forest:'trees', mountains:'peaks', water:'water' })[biome];   // others = painted ground only
    const sig = new Array(N).fill(P.NONE);                                                // plain edges — base tiles have no connectors
    const keys = cells.map(keyOf);
    if(!opts.append) board.clear(); let placed = 0;                                       // append = add to the board (e.g. an extended flower unit)
    for (const k of keys){ const id = registerGen(defs, gridKind, biome, sig, feat);
      const rec = { defId:id, rot:0, variant: Math.floor(rng()*3) };                      // renderer clamps to the biome's variant count
      if (biome === B.MOUNTAINS){ rec.variant = 0; rec.mass = 0.45 + rng()*0.55; }         // mountains = rocky peaks of varied size (snow-cap via Repaint)
      board.set(k, rec); placed++;
    }
    return { placed, biome };
  }

  /* ================= extend an existing map: fill NEW cells so they MATCH the seam, then drift =========
     Terrain follows a natural low→high order (water→plains→forest→rocks→mountains→snow); a new cell mostly
     continues its already-decided neighbours (so the seam matches), occasionally starting a fresh region
     sampled by realistic percentages, and legality rules keep the orders sane (snow caps mountains, water
     never abuts high ground). newCells must be pre-sorted seam-first by the caller. */
  const _FEAT = { plains:'tufts', forest:'trees', mountains:'peaks', village:'houses', city:'buildings', water:'water' };
  const _ORDER = [B.WATER, B.PLAINS, B.FOREST, B.ROCKS, B.MOUNTAINS, B.SNOW];
  const _ordOf = (bm)=>{ const i=_ORDER.indexOf(bm); return i<0 ? 1 : i; };
  const _TARGET = [[B.WATER,0.13],[B.PLAINS,0.40],[B.FOREST,0.22],[B.ROCKS,0.06],[B.MOUNTAINS,0.13],[B.SNOW,0.06]];
  function _sampleTarget(rng){ let x=rng(); for(const [bm,w] of _TARGET){ if((x-=w)<=0) return bm; } return B.PLAINS; }
  function _legalize(bm, nb){                                  // nb = neighbour biomes already decided
    const has=(b)=>nb.indexOf(b)>=0;
    if(bm===B.SNOW && !(has(B.MOUNTAINS)||has(B.SNOW))) return B.MOUNTAINS;   // snow only caps mountains
    if(bm===B.WATER && (has(B.MOUNTAINS)||has(B.SNOW)||has(B.ROCKS))) return B.PLAINS;  // no sea against high ground
    if(bm===B.MOUNTAINS && has(B.WATER)) return B.ROCKS;      // mountains don't plunge into the sea → foothill buffer
    if(bm===B.ROCKS && has(B.WATER)) return B.PLAINS;
    return bm;
  }
  // extend-section TERRAIN presets: a dominant biome + how to sprinkle water/rock/snow accents.
  // `match` (or no terrain) keeps the old behaviour: continue the seam then drift by natural order.
  const TERR = {
    match:       null,
    forest:      { dom:B.FOREST,    snow:false, rocks:0, lakes:0, river:false, big:false },
    plains:      { dom:B.PLAINS,    snow:false, rocks:0, lakes:0, river:false, big:false },
    desert:      { dom:B.SAND,      snow:false, rocks:3, lakes:0, river:false, big:false },
    mountains:   { dom:B.MOUNTAINS, snow:true,  rocks:3, lakes:0, river:false, big:false },
    snow:        { dom:B.SNOW,      snow:false, rocks:2, lakes:0, river:false, big:false },
    lakes:       { dom:B.PLAINS,    snow:false, rocks:0, lakes:3, river:false, big:false },
    hills:       { dom:B.PLAINS,    snow:false, rocks:5, lakes:0, river:false, big:false },
    riverbottom: { dom:B.PLAINS,    snow:false, rocks:0, lakes:0, river:true,  big:false },
    largelake:   { dom:B.PLAINS,    snow:false, rocks:0, lakes:0, river:false, big:true },
  };

  function generateNextSection(gridKind, board, defs, newCellsSorted, opts){
    opts = opts || {};
    const g = gridFor(gridKind), N = g.N;
    const rng = TE.mulberry32((opts.seed || 1) >>> 0);
    const rng2 = TE.mulberry32(((opts.seed || 1) * 7 + 13) >>> 0);
    const T = (opts.terrain && opts.terrain !== 'match') ? TERR[opts.terrain] : null;
    const feature = opts.feature || 'bare';

    const newSet = new Set(newCellsSorted.map(keyOf)), cellOfNew = {}, newKeys = newCellsSorted.map(keyOf);
    for (const c of newCellsSorted) cellOfNew[keyOf(c)] = c;
    const edges = {}; for (const k of newKeys) edges[k] = new Array(N).fill(P.NONE);
    const isNew = (k)=> newSet.has(k);
    const decided = {}, featOf = {}, walls = [], props = [];
    const biomeAt = (k)=>{ if(k in decided) return decided[k]; const pl=board.get(k); return pl && defs[pl.defId] ? defs[pl.defId].biome : null; };
    const posN = (k)=> g.world(cellOfNew[k]);
    const d2N = (a,b)=>{ const p=posN(a),q=posN(b); return (p.x-q.x)**2+(p.z-q.z)**2; };
    const offDirsNew = (k)=>{ const c=cellOfNew[k], out=[]; for(let d=0;d<N;d++){ const nk=keyOf(g.step(c,d)); if(!isNew(nk)&&!board.has(nk)) out.push(d); } return out; };
    const dirNew = (a,b)=>{ const c=cellOfNew[a]; for(let d=0;d<N;d++) if(keyOf(g.step(c,d))===b) return d; return -1; };

    // depth of each new cell from the seam (0 = touches the existing map) — drives the transition band
    const depth = {}; { const q=[];
      for (const k of newKeys){ const c=cellOfNew[k]; let seam=false;
        for(let d=0;d<N;d++){ const nk=keyOf(g.step(c,d)); if(!isNew(nk)&&board.has(nk)){ seam=true; break; } }
        if(seam){ depth[k]=0; q.push(k); } }
      let qi=0; while(qi<q.length){ const k=q[qi++], c=cellOfNew[k];
        for(let d=0;d<N;d++){ const nk=keyOf(g.step(c,d)); if(isNew(nk)&&!(nk in depth)){ depth[nk]=depth[k]+1; q.push(nk); } } }
      for(const k of newKeys) if(!(k in depth)) depth[k]=99;
    }
    const maxDepth = Math.max(0, ...newKeys.map(k=>depth[k]).filter(v=>v<99));

    // centre + a blob-grow limited to the new cells
    let cx=0, cz=0; newKeys.forEach(k=>{ const p=posN(k); cx+=p.x; cz+=p.z; }); cx/=(newKeys.length||1); cz/=(newKeys.length||1);
    const centerCell = newKeys.slice().sort((a,b)=>((posN(a).x-cx)**2+(posN(a).z-cz)**2)-((posN(b).x-cx)**2+(posN(b).z-cz)**2))[0];
    function growNew(seed, size, avoid){ const out=[], used=new Set([seed]), q=[seed];
      while(q.length && out.length<size){ q.sort((a,b)=>d2N(a,seed)-d2N(b,seed)); const k=q.shift(); if(avoid&&avoid(k)) continue; out.push(k);
        const c=cellOfNew[k]; for(let d=0;d<N;d++){ const nk=keyOf(g.step(c,d)); if(isNew(nk)&&!used.has(nk)){ used.add(nk); q.push(nk); } } } return out; }

    /* ---- 1. decide each new cell's biome ---- */
    if (T) {
      // themed: dominant biome, but blend from the old terrain across the first rank or two (seam transition)
      for (const c of newCellsSorted){ const k=keyOf(c);
        const nbOld=[], nbNew=[];
        for (let d=0; d<N; d++){ const nk=keyOf(g.step(c,d)); if(isNew(nk)){ if(nk in decided) nbNew.push(decided[nk]); } else { const b=biomeAt(nk); if(b) nbOld.push(b); } }
        let bm = T.dom; const dep = depth[k];
        // ORGANIC seam transition: fingers of the OLD terrain reach inward and taper out, instead of a hard 2-rank
        // edge that reads as a straight line on big extensions. Blend depth scales with the extension size, and we
        // prefer CONTINUING an already-decided neighbour's non-dominant biome (seam-first order → fingers grow
        // inward), so the boundary interlocks. Probability fades with depth → a natural gradient.
        const blendBand = clamp(Math.round(maxDepth * 0.45), 2, 9);
        const cont = nbNew.filter(b => b !== T.dom);                    // a finger of old terrain already touching this cell
        const pool = cont.length ? cont : nbOld;
        const pOld = clamp((blendBand + 1 - dep) / (blendBand + 1), 0, 1) * 0.72;
        if (pool.length && rng() < pOld) bm = pool[(rng()*pool.length)|0];
        decided[k] = bm;
      }
      // accents
      if (T.rocks){ const pool=newKeys.filter(k=>decided[k]===T.dom).sort(()=>rng()-0.5); for(let i=0;i<Math.min(T.rocks,pool.length);i++) decided[pool[i]]=B.ROCKS; }
      if (T.snow){ const far=newKeys.filter(k=>depth[k]>=maxDepth && decided[k]===B.MOUNTAINS); for(const k of far.slice(0,Math.max(2,(far.length*0.6)|0))) decided[k]=B.SNOW; }
      if (T.lakes){ // scale the number of lakes with the extended AREA and vary their sizes (many small ponds + a few big lakes) instead of a fixed 3 dots
        const nL = clamp(Math.round(newKeys.length/14 * (T.lakes/3)), 3, 40);
        for (let i=0;i<nL;i++){ const s=newKeys[(rng()*newKeys.length)|0]; if(decided[s]===B.WATER) continue;
          const sz = 1 + ((rng()*rng()*8)|0);                                   // 1..8, biased small → varied sizes
          growNew(s, sz, k=>decided[k]===B.WATER).forEach(k=>{ decided[k]=B.WATER; featOf[k]='water'; }); } }
      if (T.big){ growNew(centerCell, Math.max(4, Math.round(newKeys.length*0.5)), null).forEach(k=>{ decided[k]=B.WATER; featOf[k]='water'; }); }
    } else {
      // match/auto: continue the seam then drift by natural terrain order (original behaviour)
      for (const c of newCellsSorted){ const k=keyOf(c); const nb=[];
        for (let d=0; d<N; d++){ const b=biomeAt(keyOf(g.step(c,d))); if(b) nb.push(b); }
        let bm;
        if (!nb.length || rng() < 0.16){ bm = _sampleTarget(rng); }
        else { const base = nb.reduce((a,b)=>a+_ordOf(b),0)/nb.length;
          const ord = clamp(Math.round(base + (rng()*2-1)*0.85), 0, _ORDER.length-1); bm = _ORDER[ord]; }
        decided[k] = _legalize(bm, nb);
      }
    }

    /* ---- 2. a lake FEATURE carves water before roads route (so roads avoid it) ---- */
    let anchor = newKeys.filter(k=>decided[k]!==B.WATER).sort((a,b)=> (depth[b]-depth[a]) || (d2N(a,centerCell)-d2N(b,centerCell)) )[0] || centerCell;
    if (feature==='lake'){ growNew(anchor, Math.max(4, Math.round(newKeys.length*0.28)), null).forEach(k=>{ decided[k]=B.WATER; featOf[k]='water'; });
      anchor = newKeys.filter(k=>decided[k]!==B.WATER).sort((a,b)=> (depth[b]-depth[a]) || (d2N(a,centerCell)-d2N(b,centerCell)) )[0] || anchor; }

    /* ---- 3. carry existing ROADS/RIVERS/TRAILS across the seam — a swept stroke that heads for the
       FAR outer edge — it continues roughly STRAIGHT in its incoming direction, THROUGH the new section, and
       spills off the new outer boundary (the side you extended). So a road/river that used to leave the old
       edge keeps leaving the map — the town never ends up landlocked, and the road traverses the new land
       instead of hooking off a nearby side. For a river, ending in a lake counts too. One continuous
       Catmull-Rom ribbon from the seam, so no tile-to-tile joints. ---- */
    function existingPath(existK, dd){ const pl=board.get(existK); if(!pl) return P.NONE; const def=defs[pl.defId]; if(!def) return P.NONE;
      const rot=pl.rot||0, e=def.edges[((dd-rot)%N+N)%N]; return e?e.path:P.NONE; }
    const PNAME = { [P.ROAD]:'road', [P.TRAIL]:'trail', [P.RIVER]:'river' };
    function spillDir(pts, k, dir){ const wc=g.world(cellOfNew[k]), e2=g.edgeMid(dir); pts.push([wc.x+e2[0], wc.z+e2[1]]); }
    function carryStroke(startK, path, fromDir){
      const sw = g.world(cellOfNew[startK]), em = g.edgeMid(fromDir);
      const pts = [[sw.x + em[0], sw.z + em[1]], [sw.x, sw.z]];         // seam edge midpoint → first cell centre
      let cur=startK, prevDir=fromDir; const seen=new Set([startK]);
      for (let s=0; s<newKeys.length+2; s++){ const cell=cellOfNew[cur];
        const ahead = g.opposite(prevDir), od=offDirsNew(cur);
        // reached the FAR (extended) edge — leave the board straight ahead (or off any edge at max depth) & stop
        if (s>0 && od.length && (od.indexOf(ahead)>=0 || depth[cur]>=maxDepth)){ spillDir(pts, cur, od.indexOf(ahead)>=0?ahead:od[0]); cur=null; break; }
        const cand=[]; for (let d=0; d<N; d++){ if(d===prevDir) continue; const nk=keyOf(g.step(cell,d)); if(isNew(nk)&&!seen.has(nk)) cand.push(d); }
        if(!cand.length){ if(od.length) spillDir(pts, cur, od.indexOf(ahead)>=0?ahead:od[0]); cur=null; break; }
        // head toward the FAR edge (increasing depth), roads PREFERRING to avoid water/mountains but CROSSING
        // them (a bridge/pass) rather than dead-ending; a visited set keeps it from looping back.
        const mj = path===P.RIVER ? 1.4 : 0;   // rivers MEANDER toward the far edge (jitter the depth pref), roads stay straight
        cand.sort((a,b)=>{ const na=keyOf(g.step(cell,a)), nb=keyOf(g.step(cell,b));
          const pa=(path===P.ROAD&&(decided[na]===B.WATER||decided[na]===B.MOUNTAINS))?1:0, pb=(path===P.ROAD&&(decided[nb]===B.WATER||decided[nb]===B.MOUNTAINS))?1:0;
          const sa=depth[na]+(rng2()-0.5)*mj, sb=depth[nb]+(rng2()-0.5)*mj;
          return (pa-pb) || (sb-sa) || (rng2()-0.5); });
        const dir=cand[0], nk=keyOf(g.step(cell,dir)), w=g.world(cellOfNew[nk]);
        pts.push([w.x, w.z]); seen.add(nk);
        if(path===P.RIVER && decided[nk]===B.WATER){ cur=null; break; } // a river ends in the lake
        cur=nk; prevDir=g.opposite(dir);
      }
      if(cur!=null){ // fallback: the walk got boxed in mid-section — GUARANTEE it still reaches an edge by
        // running straight to the nearest off-board edge midpoint anywhere in the new section (never a stub).
        const od=offDirsNew(cur);
        if(od.length) spillDir(pts, cur, od[0]);
        else { const last=pts[pts.length-1]; let best=null, bd=Infinity;
          for(const k of newKeys){ const o2=offDirsNew(k); if(!o2.length) continue; const wc=g.world(cellOfNew[k]);
            for(const d of o2){ const em=g.edgeMid(d), px=wc.x+em[0], pz=wc.z+em[1], dd=(px-last[0])**2+(pz-last[1])**2; if(dd<bd){ bd=dd; best=[px,pz]; } } }
          if(best) pts.push(best); } }
      if(pts.length>=2) walls.push({ type: PNAME[path]||'road', pts });
    }
    for (const c of newCellsSorted){ const ck=keyOf(c);
      for (let d=0; d<N; d++){ const nk=keyOf(g.step(c,d));
        if(isNew(nk) || !board.has(nk)) continue;
        const p=existingPath(nk, g.opposite(d));
        if(p===P.ROAD || p===P.RIVER || p===P.TRAIL) carryStroke(ck, p, d);
      }
    }
    /* ---- 3b. continue any PRIOR drawn stroke (a road/river carried by an EARLIER extend) that ended at
       what is now this seam — otherwise a second extend beyond it strands the road mid-map. ---- */
    const _PT = { road:P.ROAD, river:P.RIVER, trail:P.TRAIL };
    if (opts.priorStrokes && opts.priorStrokes.length){
      const usedEnds = new Set();
      for (const c of newCellsSorted){ const ck=keyOf(c), sw=g.world(c);
        for (let d=0; d<N; d++){ const nk=keyOf(g.step(c,d));
          if(isNew(nk) || !board.has(nk)) continue;                       // d points at an EXISTING (old) neighbour = the seam
          const em=g.edgeMid(d), ex=sw.x+em[0], ez=sw.z+em[1];            // this seam edge's midpoint
          for (let i=0;i<opts.priorStrokes.length;i++){ if(usedEnds.has(i)) continue; const ps=opts.priorStrokes[i], pt=_PT[ps.type]; if(!pt||!ps.end) continue;
            if(Math.hypot(ps.end[0]-ex, ps.end[1]-ez) < 0.14){ usedEnds.add(i); carryStroke(ck, pt, d); break; }   // continue it into the new land
          }
        }
      }
    }

    /* ---- 4. river-bottom terrain sends one river across the whole section (a single swept stroke) ---- */
    if (T && T.river){ let cur = newKeys.filter(k=>depth[k]===0).sort(()=>rng()-0.5)[0] || centerCell, prevDir=-1;
      const w0=g.world(cellOfNew[cur]); const pts=[[w0.x, w0.z]];
      for (let s=0; s<newKeys.length+2; s++){ const c=cellOfNew[cur]; let best=-1, bestScore=-1;
        for(let d=0;d<N;d++){ if(d===prevDir) continue; const nk=keyOf(g.step(c,d)); if(!isNew(nk)) continue; const sc=depth[nk]+rng()*0.6; if(sc>bestScore){ bestScore=sc; best=d; } }
        const od=offDirsNew(cur);
        if(best<0 || (od.length && depth[cur]>=maxDepth && rng()<0.6)){ if(od.length){ const wc=g.world(cellOfNew[cur]), em=g.edgeMid(od[0]); pts.push([wc.x+em[0], wc.z+em[1]]); } break; }
        const nk=keyOf(g.step(c,best)), w=g.world(cellOfNew[nk]); pts.push([w.x, w.z]); cur=nk; prevDir=g.opposite(best);
      }
      if(pts.length>=2) walls.push({ type:'river', pts });
    }

    /* ---- 5. settlement / monument FEATURE ---- */
    function routeRoadFrom(fromK){ const prev={}, seen=new Set([fromK]), q=[fromK]; let target=null;
      while(q.length){ const k=q.shift();
        if(k!==fromK && (edges[k].includes(P.ROAD) || offDirsNew(k).length)){ target=k; break; }
        const c=cellOfNew[k], dd=[...Array(N).keys()].sort(()=>rng()-0.5);
        for(const d of dd){ const nk=keyOf(g.step(c,d)); if(!isNew(nk)||seen.has(nk)) continue; const bm=decided[nk]; if(bm===B.WATER||bm===B.MOUNTAINS) continue; seen.add(nk); prev[nk]=k; q.push(nk); } }
      if(!target) return;
      const path=[target]; let k=target; while(k!==fromK){ k=prev[k]; path.push(k); } path.reverse();
      for(let i=0;i<path.length-1;i++){ const a=path[i], b=path[i+1], dir=dirNew(a,b); if(dir>=0){ edges[a][dir]=P.ROAD; edges[b][g.opposite(dir)]=P.ROAD; } }
      const od=offDirsNew(target); if(od.length) edges[target][od[0]]=P.ROAD;   // spill off the board edge so the road goes somewhere
    }
    if (feature==='henge' || feature==='pyramid'){ const p=posN(anchor);
      props.push({ kind:feature, x:p.x, z:p.z, scale: feature==='pyramid'?1.7:1.4, mode:'3d', rot:0 }); }
    else if (feature==='village'){ decided[anchor]=B.VILLAGE; featOf[anchor]='houses'; routeRoadFrom(anchor);
      ringWall(new Set([anchor]), (k)=>cellOfNew[k], (k)=>g.world(cellOfNew[k]), g, (k)=>edges[k], N).forEach(w=>walls.push(w)); }
    else if (feature==='town' || feature==='castle'){
      const townCells=new Set([anchor]);
      if (feature==='town'){ const c=cellOfNew[anchor]; for(let d=0;d<N;d++){ const nk=keyOf(g.step(c,d)); if(isNew(nk)&&decided[nk]!==B.WATER&&townCells.size<3) townCells.add(nk); } }
      for (const k of townCells){ decided[k]=B.CITY; featOf[k]= feature==='castle'?'keep':'buildings'; }
      routeRoadFrom(anchor);
      ringWall(townCells, (k)=>cellOfNew[k], (k)=>g.world(cellOfNew[k]), g, (k)=>edges[k], N).forEach(w=>walls.push(w));
    }

    /* ---- 6. realise every new cell as a connector-exact tile ---- */
    for (const c of newCellsSorted){ const k=keyOf(c), bm=decided[k], sig=edges[k];
      let feat = featOf[k] !== undefined ? featOf[k] : _FEAT[bm];
      if(sig.includes(P.ROAD)&&sig.includes(P.RIVER)) feat='bridge';
      const id = registerGen(defs, gridKind, bm, sig, feat);
      board.set(k, { defId:id, rot:0 }); }
    // trace the new section's tile-edge roads (settlement roads) into swept strokes too (carried paths are
    // already strokes) — so nothing renders as a per-tile ribbon.
    const traced = tracePathStrokes(newCellsSorted.map(keyOf), k=>cellOfNew[k], k=>g.world(cellOfNew[k]), k=>edges[k], g);
    return { added: newCellsSorted.length, draw: walls.concat(traced), props };
  }

  TE.generateMap = generateMap;
  TE.generateSettlement = generateSettlement;
  TE.generateBiomeFill = generateBiomeFill;
  TE.generateNextSection = generateNextSection;
  TE.registerGen = registerGen;
  TE.hydrateGenerated = hydrateGenerated;
  if (typeof module !== 'undefined' && module.exports) module.exports = TE;
  root.TileEngine = TE;
})(typeof self !== 'undefined' ? self : this);
