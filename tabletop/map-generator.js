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
  function tracePathStrokes(cellKeys, cellOf, posOf, edgesOf, g, types) {
    const N = g.N, cset = new Set(cellKeys), out = [];
    for (const [pathVal, typeName] of [[P.RIVER, 'river'], [P.TRAIL, 'trail'], [P.ROAD, 'road']]) {
      if (types && types.indexOf(pathVal) < 0) continue;
      const segs = [];
      for (const k of cellKeys) { const e = edgesOf(k); if (!e) continue; const c = cellOf(k), pk = posOf(k);
        for (let d = 0; d < N; d++) { if (e[d] !== pathVal) continue; const nk = keyOf(g.step(c, d));
          if (cset.has(nk)) { if (k < nk) { const pn = posOf(nk); segs.push([[pk.x, pk.z], [pn.x, pn.z]]); } }   // centre→centre (dedupe)
          else { const em = g.edgeMid(d); segs.push([[pk.x, pk.z], [pk.x + em[0], pk.z + em[1]]]); } } }        // spill off-board
      for (const run of chainSegments(segs)) if (run.length >= 2) out.push({ type: typeName, pts: run });
    }
    return out;
  }

  /* world-rectangle block of cells (~w×h) centred on `anchor` — the SAME maths as the host's bSettleRegionCells,
     so a castle planned here lines up with one planned there. Cells may lie OFF the board (a castle can hang
     over the edge and be completed when the map is Extended). */
  function regionCells(gridKind, anchor, w, h) {
    const g = gridFor(gridKind), aw = g.world(anchor);
    const halfW = (gridKind === 'hex' ? w * 0.75 : w) / 2, halfH = (gridKind === 'hex' ? h * 0.8660254 : h) / 2, m = 0.35, out = [];
    for (let dq = -w - 3; dq <= w + 3; dq++) for (let dr = -h - 3; dr <= h + 3; dr++) {
      const c = { q: anchor.q + dq, r: anchor.r + dr }, wc = g.world(c);
      if (Math.abs(wc.x - aw.x) <= halfW + m && Math.abs(wc.z - aw.z) <= halfH + m) out.push(c); }
    return out;
  }

  /* NATURAL MINIMUM SIZES for terrain features (Paul): a mountain range is never a lone square — at least 5
     cells counting its snow cap — and a lake is at least 16 cells. Small ones GROW to the minimum when there is
     room (and they are already a real start: ≥3 mountains / ≥4 water), otherwise they revert: a stray peak
     becomes rocky foothills, a stray pond becomes plains. Cells already on the board (ctx.fixed) count toward a
     feature's size but are never changed — so an Extend that continues an existing range/lake is fine.
     ctx = { keys, get(k), set(k,bm), nbrs(k)→keys, fixed(k)→biome|null, locked(k)→bool, rng, lakes:bool } */
  function enforceTerrainSizes(ctx) {
    const ed = new Set(ctx.keys), locked = ctx.locked || (() => false);
    const bAt = (k) => ed.has(k) ? ctx.get(k) : ctx.fixed(k);
    const isM = (b) => b === B.MOUNTAINS || b === B.SNOW, isW = (b) => b === B.WATER;
    function comps(pred) {
      const seen = new Set(), out = [];
      for (const k of ctx.keys) {
        if (seen.has(k) || locked(k) || !pred(bAt(k))) continue;
        const edit = [], q = [k]; let size = 0; seen.add(k);
        while (q.length) { const c = q.pop(); size++; if (ed.has(c) && !locked(c)) edit.push(c);
          for (const n of ctx.nbrs(c)) { if (seen.has(n)) continue; const b = bAt(n); if (b == null || !pred(b)) continue; seen.add(n); q.push(n); } }
        out.push({ edit, size });
      }
      return out;
    }
    function tryGrow(comp, target, canTake, bm) {
      const set = new Set(comp.edit), added = []; let size = comp.size, guard = 0;
      while (size < target && guard++ < 4000) {
        const cand = [];
        for (const c of set) for (const n of ctx.nbrs(c)) if (ed.has(n) && !set.has(n) && !locked(n) && canTake(n)) cand.push(n);
        if (!cand.length) break;
        const n = cand[(ctx.rng() * cand.length) | 0]; set.add(n); added.push([n, ctx.get(n)]); ctx.set(n, bm); size++;
      }
      if (size >= target) return true;
      for (let i = added.length - 1; i >= 0; i--) ctx.set(added[i][0], added[i][1]);   // couldn't reach the minimum → undo the growth
      return false;
    }
    const touches = (k, pred) => ctx.nbrs(k).some(n => pred(bAt(n)));
    const OPEN = (b) => b === B.PLAINS || b === B.FOREST || b === B.ROCKS || b === B.SAND;
    // mountains ≥ 5
    for (const c of comps(isM)) {
      if (c.size >= 5) continue;
      const ok = c.size >= 3 && tryGrow(c, 5, (n) => OPEN(bAt(n)) && !touches(n, isW), B.MOUNTAINS);
      if (!ok) for (const k of c.edit) {                        // a lone peak melts into whatever land surrounds it (not a rash of rock patches)
        const cnt = {}; for (const n of ctx.nbrs(k)) { const b = bAt(n); if (b === B.PLAINS || b === B.FOREST || b === B.ROCKS || b === B.SAND || b === B.GREEN || b === B.DIRT) cnt[b] = (cnt[b] || 0) + 1; }
        let bm = B.PLAINS, bc = 0; for (const b in cnt) if (cnt[b] > bc) { bc = cnt[b]; bm = b; }
        if (bm === B.ROCKS && touches(k, isW)) bm = B.PLAINS;
        ctx.set(k, bm); }
    }
    // lakes 16+
    for (const c of comps(isW)) {
      if (c.size >= 16) continue;
      const ok = ctx.lakes !== false && c.size >= 4 && tryGrow(c, 16,
        (n) => { const b = bAt(n); return (OPEN(b) && b !== B.ROCKS || b === B.CROPS || b === B.ORCHARD || b === B.PIVOT) && !touches(n, (bb) => isM(bb) || bb === B.ROCKS); }, B.WATER);
      if (!ok) for (const k of c.edit) ctx.set(k, B.PLAINS);
    }
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
    const NC = keys.length;
    const lakesOk = NC >= 40, mtnOk = NC >= 20;              // a 16-cell lake / 5-cell range can't fit on a tiny mat

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
    const edgePt = (k, dir) => { const e = g.edgeMid(dir); return [pos[k].x + e[0], pos[k].z + e[1]]; };

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
    const lakeArea = (frac) => lakesOk ? clamp(Math.round(NC * frac), 16, 400) : 0;       // lakes are 16–400 cells
    const mtnArea = (frac) => mtnOk ? areaOf(frac, 5) : 0;                                 // a range is ≥5 cells
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
      water = TH.water > 0 ? grow(wSeed, lakeArea(TH.water), null) : [];
      waterSet = new Set(water); water.forEach(k => { biome[k] = B.WATER; feature[k] = 'water'; taken.add(k); });
      // mountains  (whole map is highland when the theme's base is mountains)
      if (base === B.MOUNTAINS) { mtn = keys.filter(k => !waterSet.has(k)); }
      else if (TH.mtn > 0) {
        const nw = keys.filter(k => !waterSet.has(k));
        const ms = nw.slice().sort((a, b) => nearBlob(b, water) - nearBlob(a, water))[ri(Math.max(1, Math.min(4, nw.length)))];
        mtn = ms ? grow(ms, mtnArea(TH.mtn), k => waterSet.has(k)) : []; mtn.forEach(k => biome[k] = B.MOUNTAINS);
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
      water = grow(waterSeed, lakeArea(0.14), null);
      waterSet = new Set(water); water.forEach(k => { biome[k] = B.WATER; feature[k] = 'water'; taken.add(k); });
      // mountains: a blob well away from the water
      const notWater = keys.filter(k => !waterSet.has(k));
      const mtnSeed = notWater.slice().sort((a, b) => nearBlob(b, water) - nearBlob(a, water))[ri(Math.max(1, Math.min(4, notWater.length)))];
      mtn = mtnSeed ? grow(mtnSeed, mtnArea(0.13), k => waterSet.has(k)) : [];
      mtnSet = new Set(mtn); mtn.forEach(k => { biome[k] = B.MOUNTAINS; taken.add(k); });
      // forest: a blob away from water (may touch mountains — natural)
      const forestPool = keys.filter(k => !waterSet.has(k) && !mtnSet.has(k));
      const forSeed = forestPool.slice().sort((a, b) => (nearBlob(b, water) + nearBlob(b, mtn) * 0.3) - (nearBlob(a, water) + nearBlob(a, mtn) * 0.3))[0];
      forest = forSeed ? grow(forSeed, areaOf(0.17, 3), k => waterSet.has(k) || mtnSet.has(k)) : [];
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

    /* ---- 1a. FILL (Paul: "All Mountains … had road and stream selected and only got mountains"): a single-biome
       map. Every cell takes opts.fill, then the normal drainage network + roads run across it — through mountains
       they cut a green VALLEY (river) or a rocky PASS (road) — and an all-mountain map gets raised PLATEAUS (§5d). ---- */
    const FILL = opts.fill || null;
    if (FILL) keys.forEach(k => { biome[k] = FILL; feature[k] = FILL === B.WATER ? 'water' : undefined; });
    if (!FILL) enforceTerrainSizes({ keys, get: (k) => biome[k], fixed: () => null, rng, lakes: lakesOk,
      nbrs: (k) => nbrs(k).map(n => n.k),
      set: (k, bm) => { biome[k] = bm; feature[k] = bm === B.WATER ? 'water' : undefined; } });
    const reread = () => {
      water = keys.filter(k => biome[k] === B.WATER); waterSet = new Set(water);
      mtn = keys.filter(k => biome[k] === B.MOUNTAINS || biome[k] === B.SNOW); mtnSet = new Set(mtn);
      forest = keys.filter(k => biome[k] === B.FOREST); forestSet = new Set(forest); };
    reread();
    if (FILL) { water = []; waterSet = new Set(); mtn = []; mtnSet = new Set(); }                  // passable everywhere; the land just tilts

    /* ---- 2. CASTLE (boards of 256+ cells) — a REAL walled castle of 64+ cells (keep, curtain wall, gatehouses,
       optional moat + drawbridges) with a 2-ring OUTSKIRTS of hamlets, farmsteads & fields outside the moat, built
       by generateSettlement over a region that MAY run off the board edge. On-board cells are stamped + LOCKED;
       every region tile (on- or off-board) comes back in `structure` so the host can COMPLETE the castle first
       when the map is Extended, before the new land is generated. ---- */
    const locked = new Set(), castleExits = [], castleFeeds = [];
    let structure = null, castleAnchor = null;
    const wantCastle = opts.castle !== false && !FILL && NC >= 256 && (mtn.length > 0 || rng() < 0.4);
    if (wantCastle) {
      const cw = 8 + ri(3), ch = 8 + ri(3), OUT = 2, RW = cw + 2 * OUT, RH = ch + 2 * OUT;
      const cand = keys.filter(k => !waterSet.has(k) && !mtnSet.has(k));
      const stride = Math.max(1, Math.floor(cand.length / 400));
      let best = null, bestS = -Infinity, bestBad = 0, bestOn = 0;
      for (let i = 0; i < cand.length; i += stride) {
        const a = cand[i], reg = regionCells(gridKind, cellOf[a], RW, RH);
        let bad = 0, off = 0, on = 0;
        for (const c of reg) { const k = keyOf(c); if (!cset.has(k)) { off++; continue; } on++; if (waterSet.has(k) || mtnSet.has(k)) bad++; }
        const dm = mtn.length ? Math.sqrt(nearBlob(a, mtn)) : 0;                   // castles guard the hills
        const s = -(4 * bad + 0.3 * off + 0.35 * dm) + rng() * 3;
        if (s > bestS) { bestS = s; best = a; bestBad = bad; bestOn = on; }
      }
      if (best && bestBad <= bestOn * 0.2) {
        castleAnchor = best;
        const reg = regionCells(gridKind, cellOf[best], RW, RH);
        // the moat's feed stream heads toward the nearest lake, else downhill (away from the mountains)
        let fx = 0, fz = 1;
        if (water.length) { const wk = water.slice().sort((a, b) => d2(a, best) - d2(b, best))[0]; fx = pos[wk].x - pos[best].x; fz = pos[wk].z - pos[best].z; }
        else if (mtn.length) { let mx = 0, mz = 0; mtn.forEach(k => { mx += pos[k].x; mz += pos[k].z; }); fx = pos[best].x - mx / mtn.length; fz = pos[best].z - mz / mtn.length; }
        const tmp = new Map();
        const rs = generateSettlement(gridKind, tmp, reg, defs, { seed: (((opts.seed || 1) * 7919) + 3) >>> 0, settlementType: 'castle', moat: !!opts.moat,
          outskirts: OUT, keepSize: opts.keepSize, battle: !!opts.battle, feedDir: (opts.moat && opts.stream !== false) ? [fx, fz] : null });
        const regKeys = reg.map(keyOf), regSet = new Set(regKeys), tiles = [];
        for (const k of regKeys) { const t = tmp.get(k); if (!t) continue; tiles.push([k, { defId: t.defId, rot: 0 }]);
          if (!cset.has(k)) continue;
          const d = defs[t.defId]; biome[k] = d.biome; edges[k] = d.edges.map(e => e.path); feature[k] = d.feature; locked.add(k); }
        // wherever a castle road / the moat stream leaves the region ONTO the board, continue it out here
        for (const k of regKeys) { if (!cset.has(k)) continue; const c = cellOf[k];
          for (let d = 0; d < N; d++) { const p = edges[k][d]; if (p !== P.ROAD && p !== P.RIVER) continue;
            const nk = keyOf(g.step(c, d)); if (regSet.has(nk) || !cset.has(nk)) continue;
            edges[nk][g.opposite(d)] = p;
            if (p === P.ROAD) castleExits.push(nk); else castleFeeds.push({ k: nk, dir: g.opposite(d) }); } }
        structure = { keys: regKeys, tiles, draw: Array.isArray(rs.draw) ? rs.draw : [], w: cw, h: ch, anchor: cellOf[best] };
        reread(); water = water.filter(k => !locked.has(k)); waterSet = new Set(water);
        mtn = mtn.filter(k => !locked.has(k)); mtnSet = new Set(mtn); forest = forest.filter(k => !locked.has(k)); forestSet = new Set(forest);
        // the castle may have cut a range/lake below its minimum → tidy the leftovers
        enforceTerrainSizes({ keys: keys.filter(k => !locked.has(k)), get: (k) => biome[k], fixed: (k) => locked.has(k) ? null : null, rng, lakes: lakesOk,
          nbrs: (k) => nbrs(k).map(n => n.k).filter(n => !locked.has(n)),
          set: (k, bm) => { biome[k] = bm; feature[k] = bm === B.WATER ? 'water' : undefined; } });
        reread(); water = water.filter(k => !locked.has(k)); waterSet = new Set(water);
        mtn = mtn.filter(k => !locked.has(k)); mtnSet = new Set(mtn); forest = forest.filter(k => !locked.has(k)); forestSet = new Set(forest);
      }
    }

    /* ---- 3. WATERWAYS — a physically plausible DRAINAGE NETWORK. Streams RISE in the mountains (springs on the
       range's flank) or DRAIN out of an inland lake, run DOWNHILL (elevation = high at the peaks, low toward the
       lakes/sea), and when one meets another they JOIN at a confluence (tributaries fork upstream, a river never
       splits downstream). A reach's width comes from how many sources feed it: 1 = stream, 2 = river (2× wide),
       3+ = big river (3×). Every channel ends in a lake/sea, in another channel, or off the board edge. ---- */
    const riverSet = new Set(), riverStrokes = [];
    const themeRivers = TH ? TH.rivers : (keys.length > 46 ? 2 : 1);
    const nRivers = opts.rivers != null ? opts.rivers
      : opts.stream === false ? 0
      : opts.stream === true ? Math.max(1, themeRivers)
      : themeRivers;
    const doRoads = opts.road !== false;
    const wantRiver = !!opts.river;                                  // 🌊 a RIVER (2× wide) — with 💧 stream on too it gets a tributary
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
    if (nRivers > 0 || castleFeeds.length || wantRiver) {
      const bfsDist = (src) => { const d = {}, q = []; for (const k of src) { d[k] = 0; q.push(k); } let h = 0;
        while (h < q.length) { const k = q[h++]; for (const { k: nk } of nbrs(k)) if (d[nk] === undefined) { d[nk] = d[k] + 1; q.push(nk); } } return d; };
      const dM = mtn.length ? bfsDist(mtn) : null, dW = water.length ? bfsDist(water) : null;
      const ta = rng() * Math.PI * 2, tx = Math.cos(ta), tz = Math.sin(ta);           // no mountains → the land tilts one way
      const elev = {};
      keys.forEach(k => { elev[k] = (dM ? -(dM[k] ?? 60) : ((pos[k].x - cx) * tx + (pos[k].z - cz) * tz) * 1.2)
        + (dW ? Math.min(dW[k] ?? 60, 14) * 0.45 : 0) + _jit[k] * 0.9
        + (FILL ? 1.7 * (Math.sin(pos[k].x * 0.43 + ta * 3) + Math.cos(pos[k].z * 0.47 + ta * 5) + Math.sin((pos[k].x + pos[k].z) * 0.29 + ta)) : 0); });
      let eLo = Infinity, eHi = -Infinity; keys.forEach(k => { eLo = Math.min(eLo, elev[k]); eHi = Math.max(eHi, elev[k]); });
      const eN = (k) => (elev[k] - eLo) / ((eHi - eLo) || 1);
      const blocked = (k) => locked.has(k) || mtnSet.has(k) || (biome[k] === B.WATER && !waterSet.has(k));
      const sources = [];
      // (0) the 🌊 RIVER: already a river when it enters the board (its headwaters lie beyond), on the high side
      if (wantRiver) { const hs = border.filter(k => !blocked(k) && !waterSet.has(k)).sort((a, b) => elev[b] - elev[a]), hi = hs[Math.min(hs.length - 1, ri(3))];
        if (hi) { const od = offDirs(hi); sources.push({ k: hi, flow: 2, from: edgePt(hi, od[0]), link: od[0], offSrc: true, main: true, alts: hs.filter(k => k !== hi).slice(0, 40) }); } }
      // (a) mountain SPRINGS on the range's flank — a few, moderately spread so their streams can meet downhill
      if (nRivers > 0 && mtn.length) {
        const pool = keys.filter(k => !blocked(k) && !waterSet.has(k) && nbrs(k).some(n => mtnSet.has(n.k)));
        const nS = Math.min(pool.length, nRivers + 1 + (NC > 500 ? 1 : 0)), picked = [];
        pool.sort((a, b) => elev[b] - elev[a]);
        if (pool.length) picked.push(pool[ri(Math.max(1, Math.ceil(pool.length / 3)))]);
        while (picked.length < nS) { let bk = null, bs = -1;
          for (const k of pool) { if (picked.includes(k)) continue; const md = Math.min(...picked.map(p => d2(p, k))); if (md < 4) continue;
            const s = Math.min(md, 36) + rng() * 6; if (s > bs) { bs = s; bk = k; } }
          if (!bk) break; picked.push(bk); }
        for (const s of picked) { const mn = nbrs(s).find(n => mtnSet.has(n.k)); sources.push({ k: s, flow: 1, from: edgePt(s, mn.dir), link: mn.dir, joinPref: wantRiver }); }
      }
      // (b) LAKE OUTLETS — an inland lake (not touching the board edge) spills a river from its low side
      if (nRivers > 0 && water.length) {
        const seen = new Set();
        for (const w0 of water) { if (seen.has(w0)) continue; const lk = [], q = [w0]; seen.add(w0);
          while (q.length) { const k = q.pop(); lk.push(k); for (const { k: nk } of nbrs(k)) if (waterSet.has(nk) && !seen.has(nk)) { seen.add(nk); q.push(nk); } }
          if (lk.some(isBorder) || sources.filter(s => s.lake).length >= 2) continue;
          const lset = new Set(lk);
          const shore = keys.filter(k => !lset.has(k) && !blocked(k) && !waterSet.has(k) && nbrs(k).some(n => lset.has(n.k))).sort((a, b) => elev[a] - elev[b])[0];
          if (!shore) continue; const ln = nbrs(shore).find(n => lset.has(n.k));
          sources.push({ k: shore, flow: 2, from: edgePt(shore, ln.dir), link: ln.dir, lake: lset }); }
      }
      // (c) the castle moat's stream, where it leaves the castle grounds onto the board
      for (const f of castleFeeds) sources.push({ k: f.k, flow: 1, from: edgePt(f.k, f.dir), link: f.dir, feed: true });
      // (d) no mountains and no lakes: the stream enters from off the map on the high side (its source lies beyond the board)
      if (nRivers > 0 && !sources.some(s => !s.feed)) {
        const hi = border.filter(k => !blocked(k) && !waterSet.has(k)).sort((a, b) => elev[b] - elev[a])[0];
        if (hi) { const od = offDirs(hi); sources.push({ k: hi, flow: 1, from: edgePt(hi, od[0]), link: od[0], offSrc: true }); }
      }
      const down = {}, endOf = {}, flow = {}, srcCells = new Map();
      const route = (s) => {
        const dist = { [s.k]: 0 }, prev = {}, pq = [[0, s.k, null]];
        let hit = null;
        while (pq.length) {
          pq.sort((a, b) => a[0] - b[0]); const [d, k, fin] = pq.shift();
          if (fin) { hit = fin; break; }
          if (d > (dist[k] ?? Infinity)) continue;
          if (k !== s.k && riverSet.has(k)) { hit = { type: 'join', k }; break; }
          const od = offDirs(k);
          if (od.length && !(s.offSrc && (k === s.k || d2(k, s.k) < s.minOff)) && !s.mustJoin) pq.push([d + (s.joinPref ? 4 : 1) * (2 + 14 * eN(k)), k, { type: 'off', k, dir: od[(_jit[k] * od.length) | 0] }]);   // leaving the map is cheap only from low ground
          for (const { k: nk, dir } of nbrs(k)) {
            if (waterSet.has(nk)) { if (!(s.lake && s.lake.has(nk))) pq.push([d + 1, k, { type: 'lake', k, dir }]); continue; }
            if (blocked(nk)) continue;
            const c = 1 + 6 * Math.max(0, elev[nk] - elev[k]) + rng() * 0.9;      // water runs downhill; the jitter makes it meander
            const nd = d + c; if (nd < (dist[nk] ?? Infinity)) { dist[nk] = nd; prev[nk] = k; pq.push([nd, nk, null]); }
          }
        }
        if (!hit) return null;
        const path = [hit.k]; let q = hit.k; while (q !== s.k) { q = prev[q]; path.push(q); }
        return { path: path.reverse(), hit };
      };
      const order = sources.slice().sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || (a.feed ? 1 : 0) - (b.feed ? 1 : 0) || elev[b.k] - elev[a.k]);
      const tribWanted = wantRiver && nRivers > 0 && !sources.some(x => !x.main && !x.feed);        // 💧+🌊 and nothing else would feed it
      for (const s of order) {
        if (riverSet.has(s.k) || blocked(s.k)) continue;
        const tryRoute = () => { if (!s.offSrc) return route(s);
          for (const f of [0.9, 0.45, 0]) { s.minOff = Math.pow(span * f, 2); const r0 = route(s); if (r0) return r0; } return null; };
        let res = tryRoute(); if (!res && s.mustJoin) { s.mustJoin = false; res = tryRoute(); }
        while (!res && s.alts && s.alts.length) { const a = s.alts.shift(); if (riverSet.has(a) || blocked(a)) continue;           // hemmed in (castle / range) → try the next source
          const od = offDirs(a); s.k = a; s.link = od[0]; s.from = edgePt(a, od[0]); res = tryRoute(); }
        if (!res) continue;
        const { path, hit } = res, land = hit.type === 'join' ? path.slice(0, -1) : path;
        if (!land.length) continue;
        for (const k of land) { riverSet.add(k); if (biome[k] !== B.SAND && (!FILL || FILL === B.MOUNTAINS || FILL === B.FOREST)) biome[k] = B.PLAINS; if (feature[k] !== 'water') feature[k] = undefined; flow[k] = (flow[k] || 0) + s.flow; }
        for (let i = 0; i < land.length - 1; i++) { down[land[i]] = land[i + 1]; setEdge(land[i], dirTo(land[i], land[i + 1]), P.RIVER); }
        const last = land[land.length - 1];
        if (hit.type === 'join') { down[last] = hit.k; setEdge(last, dirTo(last, hit.k), P.RIVER);
          let q = hit.k, gd = 0; while (q && gd++ < 5000) { flow[q] = (flow[q] || 0) + s.flow; q = down[q]; } }   // the extra water swells everything downstream
        else { endOf[last] = edgePt(last, hit.dir); setEdge(last, hit.dir, P.RIVER); }
        setEdge(land[0], s.link, P.RIVER);                                          // emerges from the mountain / leaves the lake / enters from off-map
        srcCells.set(land[0], { from: s.from, flow: s.flow });
        if (s.main && tribWanted) { const rv = [...riverSet], far = (k) => nearBlob(k, rv) >= 9 && d2(k, s.k) >= Math.pow(span * 0.45, 2);
          const t = border.filter(k => !riverSet.has(k) && !blocked(k) && !waterSet.has(k) && far(k)).sort((a, b) => (elev[b] + _jit[b]) - (elev[a] + _jit[a]))[0];
          if (t) { const od = offDirs(t).filter(d => edges[t][d] === P.NONE); if (od.length) order.push({ k: t, flow: 1, from: edgePt(t, od[0]), link: od[0], offSrc: true, mustJoin: true }); } }
      }
      // REACHES: split the network at sources + confluences; each reach = one swept stroke with its own width
      const ups = {}; for (const k in down) ups[down[k]] = (ups[down[k]] || 0) + 1;
      const isConf = (k) => (ups[k] || 0) + (srcCells.has(k) ? 1 : 0) >= 2;
      const wOf = (f) => f >= 3 ? 3 : f >= 2 ? 2 : 1;
      const P2 = (k) => [pos[k].x, pos[k].z];
      const walk = (k, pts, f) => { let gd = 0;
        while (gd++ < 5000) { const nx = down[k];
          if (nx === undefined) { if (endOf[k]) pts.push(endOf[k]); break; }
          pts.push(P2(nx)); if (isConf(nx)) break; k = nx; }
        if (pts.length >= 2) riverStrokes.push({ type: 'river', pts, w: wOf(f) }); };
      for (const [k, s] of srcCells) { const pts = [s.from, P2(k)];
        if (isConf(k)) { riverStrokes.push({ type: 'river', pts, w: wOf(s.flow) }); continue; }
        walk(k, pts, flow[k] || s.flow); }
      for (const k of riverSet) if (isConf(k)) walk(k, [P2(k)], flow[k] || 1);
    }

    /* ---- 4. settlements on good ground, well spread: a walled TOWN (9–64 cells) + open VILLAGES (4–12 cells) ---- */
    const onShore = (k) => nbrs(k).some(n => waterSet.has(n.k));
    const nearLocked = (k) => locked.has(k) || nbrs(k).some(n => locked.has(n.k));
    const buildable = (k) => !waterSet.has(k) && !mtnSet.has(k) && !riverSet.has(k) && !onShore(k) && !locked.has(k)
      && biome[k] !== B.SNOW && biome[k] !== B.ROCKS && biome[k] !== B.WATER;
    const cand = (opts.wild || FILL) ? [] : keys.filter(k => buildable(k) && !nearLocked(k) && !nbrs(k).some(n => mtnSet.has(n.k)));   // wild = natural land only (the Modern Pack develops it)   // villages don't abut mountains (no natural pair)
    const nSet = Math.max(1, clamp(opts.settlements != null ? opts.settlements : Math.round(NC / 26), 2, 4) - (structure ? 1 : 0));
    // SIZES (Paul): towns 9–64 cells, villages 4–12, castles 64+ (§2). Tiny mats (<50 cells) keep compact symbols.
    const battle = !!opts.battle, roomy = NC >= 50;
    const forceTown = Math.max(0, Math.round(opts.townSize || 0));
    const townTarget = !roomy ? (NC >= 30 ? 3 : 2)
      : forceTown > 0 ? clamp(forceTown, 9, 64)
      : clamp(9 + ri(Math.max(1, Math.min(64, Math.round(NC * (battle ? 0.12 : 0.1))) - 8)), 9, 64);
    const villageSize = () => roomy ? 4 + ri(9) : 1;
    const settlements = [];
    if (cand.length) {
      // the TOWN goes near the centre, but only where a compact, roughly round town of its size actually FITS (open,
      // buildable ground all round) — otherwise it gets squeezed into a thin strip between a river and the castle.
      const rad = Math.sqrt(townTarget / Math.PI) * 1.25 + 0.5, rad2 = rad * rad;
      const fits = (k) => { let n = 0; for (const j of keys) if (d2(j, k) <= rad2 && buildable(j) && !nearLocked(j)) n++; return Math.min(1, n / (townTarget * 1.25)); };
      const near = cand.slice().sort((a, b) => (Math.hypot(pos[a].x - cx, pos[a].z - cz)) - (Math.hypot(pos[b].x - cx, pos[b].z - cz))).slice(0, 80);
      let tBest = near[0], tS = -Infinity;
      for (const k of near) { const sc = fits(k) * 10 - Math.hypot(pos[k].x - cx, pos[k].z - cz) / span * 3; if (sc > tS) { tS = sc; tBest = k; } }
      settlements.push(tBest); // one central
      const spreadFrom = castleAnchor ? [castleAnchor] : [];
      while (settlements.length < nSet && settlements.length < cand.length) {
        let best = null, bestD = -1;
        for (const k of cand) { if (settlements.includes(k)) continue; const md = Math.min(...settlements.concat(spreadFrom).map(s => d2(k, s))); if (md > bestD) { bestD = md; best = k; } }
        if (best == null) break; settlements.push(best);
      }
    }
    const settleSet = new Set(settlements);
    function growBlob(seed, target, claimed){ const blob = new Set([seed]); claimed.add(seed);
      while (blob.size < target){ const ring = [];
        for (const k of blob){ const c = cellOf[k];
          for (let d = 0; d < N; d++){ const nk = keyOf(g.step(c, d)); if (blob.has(nk) || claimed.has(nk) || !cellOf[nk] || !buildable(nk) || nearLocked(nk) || nbrs(nk).some(m => mtnSet.has(m.k))) continue; ring.push(nk); } }   // cellOf guard = stay on the board
        if (!ring.length) break;
        ring.sort((a, b) => (d2(a, seed) + _jit[a] * 1.5) - (d2(b, seed) + _jit[b] * 1.5));   // compact, roughly round (a little ragged) blob
        for (const nk of ring){ if (blob.size >= target) break; if (blob.has(nk) || claimed.has(nk)) continue; blob.add(nk); claimed.add(nk); } }
      return blob; }
    const claimed = new Set(settlements);
    // TOWN: the central settlement grows into a cluster that gets a ringed city WALL (built after roads, §5b)
    const townCells = new Set();
    if (settlements.length) growBlob(settlements[0], townTarget, claimed).forEach(k => townCells.add(k));
    // VILLAGES: every other settlement grows an open cluster of cottages
    for (const vk of settlements.slice(1)) {
      const blob = growBlob(vk, villageSize(), claimed);
      if (roomy && blob.size < 4) { settlements.splice(settlements.indexOf(vk), 1); settleSet.delete(vk); continue; }   // too cramped for a real (4+ cottage) village → leave it as countryside
      for (const k of blob) { biome[k] = B.VILLAGE; feature[k] = 'houses'; } }

    /* ---- 5. sparse road network: a spanning tree over settlements + castle gates + 1 edge exit ---- */
    const roadCost = (nk, from) => {
      if (from !== undefined && edges[from][dirTo(from, nk)] === P.RIVER) return Infinity;           // cross a river, never run along it
      if (waterSet.has(nk) || mtnSet.has(nk) || locked.has(nk) || biome[nk] === B.WATER) return Infinity;   // roads route around mountains, water & the castle grounds
      let c = 1;
      const bm = biome[nk];
      if (bm === B.FOREST) c = 2.6; else if (bm === B.ROCKS || bm === B.SNOW) c = 1.6; else if (bm === B.VILLAGE || bm === B.CITY) c = 0.6;
      if (edges[nk].includes(P.ROAD)) c = 0.35;                     // reuse roads → merge into junctions, not parallels
      if (riverSet.has(nk)) c += 3;                                 // a bridge
      return c;
    };
    // one road exit to a board edge (a border plains/forest cell away from the settlements)
    const exitPool = border.filter(k => buildable(k) && !settleSet.has(k) && !nearLocked(k));
    const exit = exitPool.length ? exitPool.sort((a, b) => (settlements.length ? nearBlob(b, settlements) - nearBlob(a, settlements) : 0))[0] : null;
    const gates = castleExits.filter(k => roadCost(k) !== Infinity || edges[k].includes(P.ROAD));
    // FILL map: one through-road from a board edge to (roughly) the opposite edge — a pass through the range
    let fillExits = [];
    if (FILL && doRoads) { const ok = border.filter(k => roadCost(k) !== Infinity && !riverSet.has(k));
      if (ok.length >= 2) { const a = ok[ri(ok.length)], b = ok.slice().sort((x, y) => (d2(y, a) + _jit[y] * 8) - (d2(x, a) + _jit[x] * 8))[0]; if (b !== a) fillExits = [a, b]; } }
    const terminals = FILL ? fillExits : settlements.concat(exit ? [exit] : [], gates);
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
      if (exit && roadCells.has(exit) && !FILL) { const od = offDirs(exit); if (od.length) setEdge(exit, od[ri(od.length)], P.ROAD); }
      for (const e of fillExits) if (roadCells.has(e)) { const od = offDirs(e).filter(d => edges[e][d] === P.NONE); if (od.length) setEdge(e, od[ri(od.length)], P.ROAD); }
    }
    // a plains road leaf (a dead-end that isn't a village/castle gate/exit) becomes a farm
    const gateSet = new Set(castleExits);
    roadCells.forEach(k => {
      if (settleSet.has(k) || townCells.has(k) || k === exit || gateSet.has(k)) return;
      const roadN = edges[k].filter(p => p === P.ROAD).length;
      if (roadN === 1 && biome[k] === B.PLAINS && !riverSet.has(k)) feature[k] = 'farm';
    });

    /* ---- 5b. walled TOWN: ring the town cluster with a city wall, leaving a gate where a road enters ---- */
    const walls = [];   // freeform draw strokes {type:'wall', pts:[[x,z]…]} in g.world frame
    if (townCells.size) {
      for (const k of townCells) { biome[k] = B.CITY; feature[k] = 'buildings'; }
      ringWall(townCells, k => cellOf[k], k => pos[k], g, k => edges[k], N).forEach(w => walls.push(w));
    }

    /* ---- 6. one or two trails off to a lone feature (forest / mountain pass) ---- */
    const trailCost = (nk, from) => {
      if (from !== undefined && edges[from][dirTo(from, nk)] === P.RIVER) return Infinity;
      if (waterSet.has(nk) || locked.has(nk) || biome[nk] === B.WATER) return Infinity;
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
      if (!doRoads || FILL || trailsLaid >= 2 || !tgt || !trailStarts.length) break;
      const start = trailStarts.slice().sort((a, b) => d2(a, tgt) - d2(b, tgt))[0];
      if (start === tgt) continue;
      const path = dijkstra(start, tgt, trailCost);
      if (!path || path.length < 2) continue;
      for (let i = 0; i < path.length - 1; i++) setEdge(path[i], dirTo(path[i], path[i + 1]), P.TRAIL);
      trailsLaid++;
    }

    /* ---- 6a. retract any TRAIL that dead-ends on bare open ground — a footpath must reach somewhere:
       a destination (forest / mountain / rocks / snow / water / settlement), a road it joins, or off the
       map (a trailhead). A tip left in an empty plains/sand field reads as a "path to nowhere", so we trim
       it back cell-by-cell until it meets a justified cell. ---- */
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
        for (const k of keys) { if (locked.has(k)) continue;
          let one = -1, cnt = 0;
          for (let d=0; d<N; d++) if (edges[k][d]===P.TRAIL){ cnt++; one=d; }
          if (cnt===1 && !trailJustified(k)) { setEdge(k, one, P.NONE); changed = true; }   // trim the pointless tip
        }
      }
    }

    /* ---- 6b. farmland: patches of crop rows / orchards / centre-pivot circles on open plains ("farms
       from the air") near settlements & irrigation water. Painted top-down tiles, mixed per-cell for a patchwork. */
    const farmVar = {};                                   // per-cell field variant (crops 0–2, orchard 0–1, pivot 0–1)
    if (opts.farms !== false && !FILL) {
      const anchor = settlements.concat([...townCells]);
      const canFarm = (k) => biome[k] === B.PLAINS && !riverSet.has(k) && !settleSet.has(k) && !townCells.has(k) && !locked.has(k)
        && feature[k] === undefined && k !== exit && !gateSet.has(k);
      let seeds = keys.filter(canFarm);
      if (anchor.length) { const near = seeds.filter(k => nearBlob(k, anchor) <= 9); if (near.length) seeds = near; }   // prefer within ~3 tiles of a settlement
      const nClusters = seeds.length ? 1 + ri(3) : 0;    // 1–3 farm districts
      for (let s = 0; s < nClusters && seeds.length; s++) {
        const start = seeds[ri(seeds.length)];
        const size = 3 + ri(5), grown = [start], gset = new Set(grown);   // 3–7 fields per district
        while (grown.length < size) {
          const cand2 = nbrs(grown[ri(grown.length)]).map(n => n.k).filter(k => canFarm(k) && !gset.has(k));
          if (!cand2.length) break; const nk = cand2[ri(cand2.length)]; gset.add(nk); grown.push(nk);
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

    /* ---- 5d. ALL-MOUNTAIN FILL: a road through the range runs on a rocky PASS; and clusters of flat high ground —
       PLATEAUS (rock, or snowfields) that the host raises above the valleys — break up the sea of peaks
       (Paul: "an all mountains map should also have some plateau squares … representing high mountain areas"). ---- */
    const rockVar = {};                                   // rocky_ground variant: 0 grey · 1 red desert · 2 mossy alpine
    if (FILL === B.MOUNTAINS) {
      roadCells.forEach(k => { if (!riverSet.has(k) && biome[k] === B.MOUNTAINS) { biome[k] = B.ROCKS; rockVar[k] = 0; } });
      if (opts.plateaus !== false) {
        const pathy = (k) => edges[k].some(p => p !== P.NONE);
        const free = (k) => biome[k] === B.MOUNTAINS && !pathy(k) && !nbrs(k).some(n => pathy(n.k) || feature[n.k] === 'plateau');
        const target = Math.round(NC * 0.14); let made = 0, tries = 0;
        while (made < target && tries++ < 80) {
          const pool = keys.filter(free); if (!pool.length) break;
          const blob = grow(pool[ri(pool.length)], 2 + ri(5), k => !free(k)), snowy = rng() < 0.35, rv = rng() < 0.5 ? 0 : 2;
          for (const k of blob) { biome[k] = snowy ? B.SNOW : B.ROCKS; feature[k] = 'plateau'; if (!snowy) rockVar[k] = rv; made++; } }
      }
    }

    /* ---- 6c. mountain-massif depth (0 = fringe/foothill, 1 = range core) so peaks grow toward the heart of
       the range and taper to foothills at its edge — no more a uniform grid of identical spikes. ---- */
    const mtnMass = {};
    { const dist = {}, front = [];
      const isM = (k) => biome[k] === B.MOUNTAINS || feature[k] === 'plateau';
      keys.forEach(k => { if (!isM(k)) { dist[k] = 0; front.push(k); } else if (isBorder(k)) { dist[k] = 1; front.push(k); } });
      let head = 0; while (head < front.length) { const k = front[head++];
        for (const { k: nk } of nbrs(k)) if (dist[nk] === undefined && isM(nk)) { dist[nk] = dist[k] + 1; front.push(nk); } }
      let maxd = 2; keys.forEach(k => { if (biome[k] === B.MOUNTAINS && dist[k] > maxd) maxd = dist[k]; });
      keys.forEach(k => { if (biome[k] === B.MOUNTAINS) mtnMass[k] = Math.min(1, (dist[k] || 1) / maxd); });
    }

    /* ---- 7. realise every cell as a connector-exact tile ---- */
    const defaultFeature = (bm) => ({ plains: 'tufts', forest: 'trees', mountains: 'peaks', village: 'houses', city: 'buildings', water: 'water' })[bm];
    board.clear();
    let placed = 0;
    for (const k of keys) {
      const sig = edges[k], bm = biome[k];
      let feat = feature[k] !== undefined ? feature[k] : defaultFeature(bm);
      if (!locked.has(k) && sig.includes(P.ROAD) && sig.includes(P.RIVER)) feat = 'bridge';     // a road bridging the river
      const id = registerGen(defs, gridKind, bm, sig, feat);
      const rec = { defId: id, rot: 0 };
      if (mtnMass[k] !== undefined) rec.mass = mtnMass[k];
      if (farmVar[k] !== undefined) rec.variant = farmVar[k];
      if (rockVar[k] !== undefined) rec.variant = rockVar[k];
      board.set(k, rec);
      placed++;
    }
    // roads/trails as CONTINUOUS swept strokes (the castle grounds draw their own — `structure.draw`, which the
    // host clips to whatever part of the castle is on the board); rivers come from the drainage network above.
    const pathStrokes = tracePathStrokes(keys.filter(k => !locked.has(k)), k => cellOf[k], k => pos[k], k => edges[k], g, [P.TRAIL, P.ROAD]);
    return { placed, draw: walls.concat(riverStrokes, pathStrokes), structure,
      settlements: settlements.length + (structure ? 1 : 0), town: townCells.size, castle: structure ? structure.w * structure.h : 0,
      rivers: riverStrokes.length, roads: roadCells.size, water: water.length, mountains: mtn.length, forest: forest.length };
  }

  /* ================= CASTLE + OUTSKIRTS =================================================================
     A castle rarely stands alone: outside the moat/curtain wall lie the hamlets, farmsteads and fields that feed
     it. `opts.outskirts` = R rings around the region's edge are kept OUT of the castle proper; the castle is
     built on the core (so the moat/wall sit R rings in), then every castle road is carried straight out through
     the outskirts to the region edge, a small village (4–6 cottages) grows beside each road, a few lone
     farmsteads + fields/orchards/copses dot the rest, and (with a moat + opts.feedDir) the moat's feed stream
     runs out toward the nearest lake / downhill. Same tile/stroke output as generateSettlement. ---- */
  function _castleWithOutskirts(gridKind, board, cells, defs, opts) {
    const R = Math.max(1, opts.outskirts | 0);
    const g = gridFor(gridKind), N = g.N;
    const rng = TE.mulberry32((((opts.seed || 1) * 9973) + 17) >>> 0), ri = (n) => Math.floor(rng() * n);
    const keys = cells.map(keyOf), cset = new Set(keys), cellOf = {}, pos = {};
    cells.forEach(c => { const k = keyOf(c); cellOf[k] = c; pos[k] = g.world(c); });
    const nbrs = (k) => { const c = cellOf[k], out = []; for (let d = 0; d < N; d++) { const nk = keyOf(g.step(c, d)); if (cset.has(nk)) out.push({ k: nk, dir: d }); } return out; };
    // ring depth from the region's edge (0 = outermost ring)
    const depth = {}, q = [];
    for (const k of keys) { const c = cellOf[k]; for (let d = 0; d < N; d++) if (!cset.has(keyOf(g.step(c, d)))) { depth[k] = 0; q.push(k); break; } }
    for (let h = 0; h < q.length; h++) { const k = q[h]; for (const { k: nk } of nbrs(k)) if (depth[nk] === undefined) { depth[nk] = depth[k] + 1; q.push(nk); } }
    const core = cells.filter(c => (depth[keyOf(c)] ?? 99) >= R);
    if (core.length < 16) return generateSettlement(gridKind, board, cells, defs, Object.assign({}, opts, { outskirts: 0 }));
    const tmp = new Map();
    const rc = generateSettlement(gridKind, tmp, core, defs, Object.assign({}, opts, { outskirts: 0 }));
    const coreSet = new Set(core.map(keyOf));
    const biome = {}, edges = {}, feature = {};
    for (const k of coreSet) { const d = defs[tmp.get(k).defId]; biome[k] = d.biome; edges[k] = d.edges.map(e => e.path); feature[k] = d.feature; }
    const outer = keys.filter(k => !coreSet.has(k));
    for (const k of outer) { biome[k] = B.PLAINS; edges[k] = new Array(N).fill(P.NONE); feature[k] = undefined; }
    function setEdge(k, dir, path) { edges[k][dir] = path; const nk = keyOf(g.step(cellOf[k], dir)); if (cset.has(nk)) edges[nk][g.opposite(dir)] = path; }
    let cx = 0, cz = 0; keys.forEach(k => { cx += pos[k].x; cz += pos[k].z; }); cx /= keys.length; cz /= keys.length;

    // straight run from a core-edge cell out through the outskirts in direction d, off the region edge
    const road = new Set(), stream = new Set(), spokes = [];
    function runOut(k0, d, path) {
      const run = []; let cur = keyOf(g.step(cellOf[k0], d)); if (!cset.has(cur) || coreSet.has(cur)) return run;
      edges[cur][g.opposite(d)] = path; let guard = 0;
      while (guard++ < 200) { run.push(cur); (path === P.ROAD ? road : stream).add(cur);
        const nx = keyOf(g.step(cellOf[cur], d));
        if (!cset.has(nx)) { edges[cur][d] = path; break; }                       // leaves the region → carried on beyond
        if (coreSet.has(nx)) break;
        setEdge(cur, d, path); cur = nx; }
      return run; }
    // 1. carry every castle road (drawbridge spoke) out to the region edge
    for (const k of coreSet) { for (let d = 0; d < N; d++) { if (edges[k][d] !== P.ROAD) continue;
      const nk = keyOf(g.step(cellOf[k], d)); if (coreSet.has(nk) || !cset.has(nk)) continue;
      spokes.push(runOut(k, d, P.ROAD)); } }
    // 2. the moat's FEED STREAM toward opts.feedDir (a lake / downhill) — from a plain moat cell, never a drawbridge
    if (opts.moat && Array.isArray(opts.feedDir)) {
      const [fx, fz] = opts.feedDir, fl = Math.hypot(fx, fz) || 1;
      let best = null, bs = -Infinity;
      for (const k of coreSet) { if (biome[k] !== B.WATER || edges[k].includes(P.ROAD)) continue;
        for (let d = 0; d < N; d++) { const nk = keyOf(g.step(cellOf[k], d)); if (coreSet.has(nk) || !cset.has(nk) || road.has(nk)) continue;
          const em = g.edgeMid(d), s = ((pos[k].x - cx) * fx + (pos[k].z - cz) * fz) / fl + 2 * (em[0] * fx + em[1] * fz) / fl;
          if (s > bs) { bs = s; best = [k, d]; } } }
      if (best) { edges[best[0]][best[1]] = P.RIVER; runOut(best[0], best[1], P.RIVER); }
    }
    // 3. HAMLETS — a small village (4–6 cottages) beside each road, alternating sides; plus a few lone farmsteads
    const free = (k) => cset.has(k) && !coreSet.has(k) && !road.has(k) && !stream.has(k) && biome[k] === B.PLAINS && feature[k] === undefined;
    const hamlet = [];
    spokes.forEach((run, si) => {
      if (!run.length) return;
      const at = run[Math.min(run.length - 1, ri(Math.max(1, run.length)))];
      const side = nbrs(at).map(n => n.k).filter(free);
      if (!side.length) return;
      const seed = side[(si + ri(2)) % side.length], blob = [seed], bset = new Set(blob), want = 4 + ri(3);
      while (blob.length < want) { const nx = [];
        for (const k of blob) for (const { k: nk } of nbrs(k)) if (free(nk) && !bset.has(nk)) nx.push(nk);
        if (!nx.length) break; const pick = nx[ri(nx.length)]; bset.add(pick); blob.push(pick); }
      for (const k of blob) { biome[k] = B.VILLAGE; feature[k] = 'houses'; hamlet.push(k); } });
    const lone = outer.filter(free); const nFarm = Math.min(lone.length, 2 + ri(3));
    for (let i = 0; i < nFarm; i++) { const k = lone[ri(lone.length)]; if (!free(k)) continue;
      biome[k] = B.VILLAGE; feature[k] = 'houses'; hamlet.push(k);
      const fld = nbrs(k).map(n => n.k).filter(free); if (fld.length) { const f = fld[ri(fld.length)]; biome[f] = B.CROPS; feature[f] = 'field'; } }
    // 4. countryside: kitchen fields + orchards near the cottages, the odd copse, meadow elsewhere (coherent noise)
    const nearH = (k) => hamlet.some(h => (pos[h].x - pos[k].x) ** 2 + (pos[h].z - pos[k].z) ** 2 <= 2.3 * 2.3);
    for (const k of outer) { if (!free(k)) continue;
      const w = pos[k], n = (Math.sin(w.x * 0.61 + (opts.seed || 1)) + Math.cos(w.z * 0.53) + Math.sin((w.x + w.z) * 0.33)) / 3, v = (n + 1) / 2 + (rng() - 0.5) * 0.2;
      if (nearH(k) && v > 0.45) { biome[k] = v > 0.7 ? B.ORCHARD : B.CROPS; feature[k] = 'field'; }
      else if (v < 0.22) { biome[k] = B.FOREST; feature[k] = 'trees'; } }
    // realise
    const defFeat = (bm) => ({ plains: 'tufts', forest: 'trees', mountains: 'peaks', village: 'houses', city: 'buildings', water: 'water' })[bm];
    board.clear(); let placed = 0;
    for (const k of keys) { const sig = edges[k], bm = biome[k];
      let feat = feature[k] !== undefined ? feature[k] : defFeat(bm);
      if (!coreSet.has(k) && sig.includes(P.ROAD) && sig.includes(P.RIVER)) feat = 'bridge';
      board.set(k, { defId: registerGen(defs, gridKind, bm, sig, feat), rot: 0 }); placed++; }
    const walls = (rc.draw || []).filter(s => s.type === 'wall');
    const strokes = tracePathStrokes(keys, k => cellOf[k], k => pos[k], k => edges[k], g).map(s => s.type === 'river' ? Object.assign(s, { w: 1 }) : s);   // the moat's feed is a narrow stream
    return { placed, draw: walls.concat(strokes), settlementType: 'castle', keepSize: rc.keepSize,
             buildings: keys.filter(k => biome[k] === B.CITY || biome[k] === B.VILLAGE).length };
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
    if ((opts.outskirts | 0) > 0 && opts.settlementType === 'castle') return _castleWithOutskirts(gridKind, board, cells, defs, opts);
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
    function clearRoadEdge(k, dir){ if (edges[k][dir] !== P.ROAD) return; edges[k][dir] = P.NONE; const nk = keyOf(g.step(cellOf[k], dir)); if (cset.has(nk)) edges[nk][g.opposite(dir)] = P.NONE; }
    function dirTo(a, b){ for (let d = 0; d < N; d++) if (keyOf(g.step(cellOf[a], d)) === b) return d; return -1; }
    function dj(src, dst){ const dist = { [src]: 0 }, prev = {}, pq = [[0, src]];
      while (pq.length){ pq.sort((a, b) => a[0] - b[0]); const [d, k] = pq.shift(); if (k === dst) break; if (d > (dist[k] ?? 1e9)) continue;
        for (const { k: nk } of nbrs(k)){ if (keepN > 1 && keepBlock.has(nk)) continue;             // roads stop AT a big keep, never run over it
          const c = (edges[nk].includes(P.ROAD) ? 0.4 : 1) + (nk !== dst && isBorder(nk) ? 6 : 0);   // avenues avoid the boundary ring so they cross it only at their gate, not run along the moat
          const nd = d + c; if (nd < (dist[nk] ?? 1e9)){ dist[nk] = nd; prev[nk] = k; pq.push([nd, nk]); } } }
      if (dist[dst] == null) return null; const path = [dst]; let k = dst; while (k !== src){ k = prev[k]; path.push(k); } return path.reverse(); }

    if (!keys.length) { board.clear(); return { placed: 0, draw: [], settlementType: type }; }
    const centerK = keys.slice().sort((a, b) => dCentre(a) - dCentre(b))[0];
    const border = keys.filter(isBorder);
    // KEEP SIZE (castle): 1×1 … 4×4 squares on a square grid (hex: 1 / 7 / 19 / 37 hexes) — the whole block is the
    // keep's footprint. The anchor carries 'keep<N>' (square: its top-left cell, hex: the centre) and the rest
    // 'keepyard' (ground only), so the renderer draws ONE big keep over the block. Shrinks to fit if the castle is small.
    const keepBlock = new Set([centerK]); let keepAnchor = centerK, keepN = 1;
    if (type === 'castle'){
      const inner = (k) => cset.has(k) && !isBorder(k) && nbrs(k).every(n => !isBorder(n.k));   // leave room for the curtain wall
      const c0 = cellOf[centerK];
      const kWant = !opts.battle ? clamp((opts.keepSize | 0) || 1, 1, 4)               // world scale: 1–4 cells
        : gridKind === 'hex' ? clamp(((opts.keepSize | 0) || 1) + 2, 3, 4) : clamp(((opts.keepSize | 0) || 1) * 2 + 2, 4, 8);   // 5-ft battle: a 20–40 ft keep
      for (let want = kWant; want > 1; want--){
        const blk = [];
        if (gridKind === 'hex'){ const R0 = want - 1;
          for (let dq = -R0; dq <= R0; dq++) for (let dr = -R0; dr <= R0; dr++){ if ((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 > R0) continue; blk.push(keyOf({ q: c0.q + dq, r: c0.r + dr })); } }
        else { const off = Math.floor((want - 1) / 2); for (let dq = 0; dq < want; dq++) for (let dr = 0; dr < want; dr++) blk.push(keyOf({ q: c0.q - off + dq, r: c0.r - off + dr })); }
        if (blk.every(inner)){ blk.forEach(k => keepBlock.add(k)); keepN = want;
          keepAnchor = gridKind === 'hex' ? centerK : keyOf({ q: c0.q - Math.floor((want - 1) / 2), r: c0.r - Math.floor((want - 1) / 2) }); break; } }
    }
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
      // castles keep FEWER avenues (each becomes a gated drawbridge road leaving the map — too many looks like a starburst).
      const nSpokes = type === 'castle' ? clamp(Math.round(keys.length / 150), 1, 2) : clamp(2 + Math.round(keys.length / 40), 3, 6);
      const byAngle = border.slice().sort((a, b) => Math.atan2(pos[a].z - cz, pos[a].x - cx) - Math.atan2(pos[b].z - cz, pos[b].x - cx));
      const targets = new Set([gate]);
      for (let i = 0; i < nSpokes && byAngle.length; i++) targets.add(byAngle[Math.floor(i * byAngle.length / nSpokes)]);
      for (const t of targets){ if (keepBlock.has(t)) continue;
        if (keepN > 1){ let src = null, bd = Infinity;                                   // start just outside the big keep, nearest the target
          for (const b of keepBlock) for (const { k: o } of nbrs(b)) if (!keepBlock.has(o)){ const dd = d2(o, t); if (dd < bd){ bd = dd; src = o; } }
          if (src) layRoad(src === t ? [t] : dj(src, t)); }
        else if (t !== centerK) layRoad(dj(centerK, t)); }
    }
    // EVERY avenue that reaches the boundary continues OFF THE MAP (outward direction) so no road dead-ends at
    // the wall or in the moat — the settlement sits at a crossroads with real roads leaving the board edge.
    // (For a castle these boundary cells are the moat, so each crossing reads as a drawbridge with a road beyond.)
    function spillOffMap(k){ const od = offDirs(k); if (!od.length) return;
      if (od.some(d => edges[k][d] === P.ROAD)) return;                    // already leaves the board here
      let best = od[0], bd = -Infinity;
      for (const d of od){ const em = g.edgeMid(d), dot = em[0] * (pos[k].x - cx) + em[1] * (pos[k].z - cz); if (dot > bd){ bd = dot; best = d; } }
      setEdge(k, best, P.ROAD); }
    for (const k of border){ if (street.has(k)) spillOffMap(k); }
    street.add(gate);

    // centre: castle keep, or an open plaza for a town/village
    biome[centerK] = (type === 'castle') ? B.CITY : B.GREEN;
    if (type === 'castle'){ for (const k of keepBlock){ biome[k] = B.CITY; feature[k] = 'keepyard'; } feature[keepAnchor] = keepN > 1 ? 'keep' + keepN : 'keep'; }

    // 5-ft BATTLE scale: lay out real building PLOTS (rectangles sized like houses, fronting the streets, a yard /
    // alley between buildings, a clear lane inside the curtain wall) instead of per-cell scatter — so every
    // building the renderer makes has sensible walls, rooms and floors. World scale keeps the per-cell look below.
    if (opts.battle){ battlePlots(); }
    else
    // building lots on every non-street, non-centre cell
    for (const k of keys){ if (k === centerK || keepBlock.has(k)) continue;
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

    function battlePlots(){
      const hexG = gridKind === 'hex', moatE = opts.moat && type !== 'village';
      const ix = (k) => { const c = cellOf[k]; return { c: c.q, w: hexG ? c.r + Math.floor(c.q / 2) : c.r }; };
      const kx = (c, w) => keyOf({ q: c, r: hexG ? w - Math.floor(c / 2) : w });
      const lane = (k) => type !== 'village' && (isBorder(k) || (moatE && nbrs(k).some(n => isBorder(n.k))));
      const plaza = (k) => type === 'town' && dCentre(k) < 1.6;
      const courtyard = (k) => type === 'castle' && dCentre(k) / maxR < 0.32;
      const avail = new Set(keys.filter(k => k !== centerK && !keepBlock.has(k) && !street.has(k) && !lane(k) && !plaza(k) && !courtyard(k)));
      const sd = {}, qu = []; for (const k of street){ sd[k] = 0; qu.push(k); }      // steps to the nearest street
      while (qu.length){ const k = qu.shift(); for (const { k: n } of nbrs(k)) if (sd[n] == null){ sd[n] = sd[k] + 1; qu.push(n); } }
      const tie = {}; for (const k of avail) tie[k] = rng();
      const SZ = type === 'village' ? { w: [2, 4], d: [3, 5] } : type === 'town' ? { w: [3, 5], d: [3, 6] } : { w: [3, 5], d: [4, 7] };
      const budget = Math.round(avail.size * (type === 'village' ? 0.42 : type === 'town' ? 0.8 : 0.5));
      const built = new Set(), spare = new Set();
      for (const a of [...avail].sort((p, q) => ((sd[p] ?? 99) - (sd[q] ?? 99)) || (tie[p] - tie[q]))){
        if (built.size >= budget) break; if (built.has(a) || spare.has(a)) continue; const A = ix(a);
        for (let t = 0; t < 14; t++){
          let W = SZ.w[0] + ri(SZ.w[1] - SZ.w[0] + 1), D = SZ.d[0] + ri(SZ.d[1] - SZ.d[0] + 1); if (rng() < 0.5){ const s = W; W = D; D = s; }
          if (t >= 9){ W = 2 + ri(2); D = 2 + ri(2); }                               // squeeze in a small one
          const c0 = A.c - ri(W), w0 = A.w - ri(D); let ok = true; const rect = [];
          for (let c = c0; c < c0 + W && ok; c++) for (let w = w0; w < w0 + D; w++){ const k = kx(c, w); if (!avail.has(k) || built.has(k) || spare.has(k)){ ok = false; break; } rect.push(k); }
          if (!ok) continue;
          rect.forEach(k => built.add(k));
          for (let c = c0 - 1; c <= c0 + W; c++) for (let w = w0 - 1; w <= w0 + D; w++){ const k = kx(c, w); if (!built.has(k)) spare.add(k); }   // yard / alley ring
          break; } }
      const near2 = new Set(); for (const k of built){ const P0 = ix(k); for (let dc = -2; dc <= 2; dc++) for (let dw = -2; dw <= 2; dw++) near2.add(kx(P0.c + dc, P0.w + dw)); }
      for (const k of keepBlock){ const P0 = ix(k); for (let dc = -2; dc <= 2; dc++) for (let dw = -2; dw <= 2; dw++) near2.add(kx(P0.c + dc, P0.w + dw)); }
      const TREES = B.FOREST;
      for (const k of keys){ if (k === centerK || keepBlock.has(k)) continue;
        if (street.has(k) || lane(k) || plaza(k)){ biome[k] = B.GREEN; continue; }
        const treeOK = !near2.has(k); B.FOREST = treeOK ? TREES : B.GREEN;       // (restored right after this cell)
        if (built.has(k)){ if (type === 'village'){ biome[k] = B.VILLAGE; feature[k] = 'houses'; } else { biome[k] = B.CITY; feature[k] = 'buildings'; } continue; }
        const rv = rng(), rr = dCentre(k) / maxR;
        if (type === 'castle'){
          if (rr < 0.32){ if (rv < 0.18){ biome[k] = B.FOREST; feature[k] = 'trees'; } else if (rv < 0.24){ biome[k] = B.WATER; feature[k] = 'water'; } else biome[k] = B.GREEN; }
          else if (rr > 0.66){ if (rv < 0.3){ biome[k] = B.ORCHARD; feature[k] = undefined; } else if (rv < 0.5){ biome[k] = B.CROPS; feature[k] = undefined; } else biome[k] = B.GREEN; }
          else { if (rv < 0.25){ biome[k] = B.FOREST; feature[k] = 'trees'; } else biome[k] = B.GREEN; }
        } else if (type === 'village'){ if (rv < 0.14){ biome[k] = B.FOREST; feature[k] = 'trees'; } else if (rv < 0.26 && !spare.has(k)){ biome[k] = B.CROPS; feature[k] = undefined; } else biome[k] = B.GREEN; }
        else { if (rv < 0.07){ biome[k] = B.FOREST; feature[k] = 'trees'; } else biome[k] = B.GREEN; }
        B.FOREST = TREES; if (!treeOK && biome[k] === B.GREEN && feature[k] === 'trees') feature[k] = undefined; }
      B.FOREST = TREES;
    }

    // MOAT + DRAWBRIDGE (toggle) — the OUTERMOST ring of the plan becomes the water moat, which sits OUTSIDE the
    // curtain wall (the wall is moved one ring in, below). So it reads castle → wall → moat → countryside, not a
    // pool inside the keep. Where the gate road crosses the moat the road rides over water = a drawbridge.
    const moatOn = opts.moat && type !== 'village';
    if (moatOn){
      // the plan's outer ring becomes the water moat. A boundary cell that an avenue crosses = a DRAWBRIDGE
      // (its road continues off the map, spilled above); every other boundary cell is solid water. Nothing is
      // stripped, so the castle's roads run keep → drawbridge → off the board edge with no dead-ends.
      for (const k of border){
        biome[k] = B.WATER;
        feature[k] = street.has(k) ? undefined : 'water';                // road-over-water = drawbridge; else plain moat
      }
    }

    // perimeter WALL with a gate gap (castle + town; villages stay open). With a moat the wall rings the INNER
    // cells (one in from the edge) so the moat sits OUTSIDE the wall; otherwise it rings the whole plan.
    const walls = [];
    if (type !== 'village'){ const wallSet = moatOn ? new Set(keys.filter(k => !isBorder(k))) : new Set(keys);
      ringWall(wallSet, k => cellOf[k], k => pos[k], g, k => edges[k], N).forEach(w => walls.push(w));
      // GATEHOUSE where a road passes through the curtain wall ('gate<dir>' = the wall edge it sits on), and a
      // DRAWBRIDGE on the moat cell outside it ('drawbridge<dir>' = the edge it's hinged on, facing the gate).
      for (const k of wallSet){ if (k === centerK || keepBlock.has(k)) continue; const c = cellOf[k];
        for (let d = 0; d < N; d++){ if (edges[k][d] !== P.ROAD) continue; const nk = keyOf(g.step(c, d));
          if (wallSet.has(nk)) continue;
          feature[k] = 'gate' + d;
          if (moatOn && cellOf[nk] && biome[nk] === B.WATER) feature[nk] = 'drawbridge' + g.opposite(d);
          break; } }
    }

    // realise every cell as a connector-exact tile
    const defFeat = (bm) => ({ plains: 'tufts', forest: 'trees', mountains: 'peaks', village: 'houses', city: 'buildings', water: 'water' })[bm];
    board.clear(); let placed = 0;
    for (const k of keys){ const sig = edges[k], bm = biome[k];
      let feat = feature[k] !== undefined ? feature[k] : defFeat(bm);
      const id = registerGen(defs, gridKind, bm, sig, feat);
      board.set(k, { defId: id, rot: 0 }); placed++;
    }
    const pathStrokes = tracePathStrokes(keys, k => cellOf[k], k => pos[k], k => edges[k], g);
    return { placed, draw: walls.concat(pathStrokes), settlementType: type, keepSize: keepN,
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
    water:       { dom:B.WATER,     snow:false, rocks:0, lakes:0, river:false, big:false },   // solid ocean — surround a map with water (seam gives a natural shoreline)
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
        // lakes are 16–400 cells (Paul) — fewer, real lakes sized to the new land, biased toward the small end
        const nL = clamp(Math.round(newKeys.length/60 * (T.lakes/3)), 1, 8), maxL = Math.min(400, Math.max(16, Math.round(newKeys.length*0.35)));
        for (let i=0;i<nL;i++){ const s=newKeys[(rng()*newKeys.length)|0]; if(decided[s]===B.WATER) continue;
          const sz = Math.round(16 + rng()*rng()*(maxL-16));
          growNew(s, sz, k=>decided[k]===B.WATER).forEach(k=>{ decided[k]=B.WATER; featOf[k]='water'; }); } }
      if (T.big){ growNew(centerCell, Math.min(400, Math.max(16, Math.round(newKeys.length*0.5))), null).forEach(k=>{ decided[k]=B.WATER; featOf[k]='water'; }); }
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
    if (feature==='lake'){ growNew(anchor, Math.min(400, Math.max(16, Math.round(newKeys.length*0.28))), null).forEach(k=>{ decided[k]=B.WATER; featOf[k]='water'; }); }

    /* ---- 2b. natural MINIMUM SIZES: a mountain range ≥5 cells, a lake ≥16 — counting the part already on the
       map, so continuing an existing range/lake across the seam is fine but no lone 1-square peaks or ponds ---- */
    if (!(T && T.dom === B.WATER)){
      const kc = (k)=>{ const [q,r]=k.split(',').map(Number); return {q,r}; };
      enforceTerrainSizes({ keys:newKeys, rng, get:(k)=>decided[k],
        set:(k,bm)=>{ decided[k]=bm; featOf[k]= bm===B.WATER ? 'water' : undefined; },
        fixed:(k)=>{ const pl=board.get(k); return pl && defs[pl.defId] ? defs[pl.defId].biome : null; },
        nbrs:(k)=>{ const c=cellOfNew[k]||kc(k), out=[]; for(let d=0;d<N;d++) out.push(keyOf(g.step(c,d))); return out; } });
    }
    if (decided[anchor]===B.WATER || decided[anchor]===B.MOUNTAINS)
      anchor = newKeys.filter(k=>decided[k]!==B.WATER && decided[k]!==B.MOUNTAINS).sort((a,b)=> (depth[b]-depth[a]) || (d2N(a,centerCell)-d2N(b,centerCell)) )[0] || anchor;

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
    function carryStroke(startK, path, fromDir, w){
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
      if(pts.length>=2){ const st={ type: PNAME[path]||'road', pts }; if(w) st.w=w; walls.push(st); }
    }
    const priorW = (x,z,type)=>{ for(const ps of (opts.priorStrokes||[])) if(ps.type===type && ps.w && ps.end && Math.hypot(ps.end[0]-x, ps.end[1]-z)<0.14) return ps.w; return undefined; };
    const carriedAt = [];
    for (const c of newCellsSorted){ const ck=keyOf(c);
      for (let d=0; d<N; d++){ const nk=keyOf(g.step(c,d));
        if(isNew(nk) || !board.has(nk)) continue;
        const p=existingPath(nk, g.opposite(d));
        if((p===P.ROAD || p===P.RIVER || p===P.TRAIL) && (!opts.carry || opts.carry.indexOf(PNAME[p])>=0)){ const wc=g.world(c), em=g.edgeMid(d), mx=wc.x+em[0], mz=wc.z+em[1];
          carriedAt.push([mx,mz]); carryStroke(ck, p, d, priorW(mx,mz,PNAME[p])); }
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
          if(carriedAt.some(m=>Math.hypot(m[0]-ex, m[1]-ez)<0.14)) continue;  // already continued from the tile edge above (was carried TWICE → forked)
          for (let i=0;i<opts.priorStrokes.length;i++){ if(usedEnds.has(i)) continue; const ps=opts.priorStrokes[i], pt=_PT[ps.type]; if(!pt||!ps.end) continue;
            if(opts.carry && opts.carry.indexOf(ps.type)<0) continue;          // only carry the requested path kinds (Modern Pack lays its own streets)
            if(Math.hypot(ps.end[0]-ex, ps.end[1]-ez) < 0.14){ usedEnds.add(i); carryStroke(ck, pt, d, ps.w); break; }   // continue it into the new land
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
      if(pts.length>=2) walls.push({ type:'river', pts, w:2 });   // a valley-bottom RIVER (2× a stream)
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
    else if (feature==='village'){ // an open village of 4–12 cottages (Paul's sizes), grown on dry, level ground
      growNew(anchor, 4 + ((rng()*9)|0), k=>decided[k]===B.WATER||decided[k]===B.MOUNTAINS||decided[k]===B.SNOW).forEach(k=>{ decided[k]=B.VILLAGE; featOf[k]='houses'; });
      routeRoadFrom(anchor); }
    else if (feature==='town' || feature==='castle'){
      const townCells=new Set([anchor]);
      if (feature==='town'){ const want = clamp(9 + ((rng()*Math.max(1, Math.min(56, Math.round(newKeys.length*0.3))))|0), 9, 64);   // a walled town of 9–64 cells
        growNew(anchor, want, k=>decided[k]===B.WATER||decided[k]===B.MOUNTAINS||decided[k]===B.SNOW).forEach(k=>townCells.add(k)); }
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
  TE.regionCells = regionCells;
  TE.chainSegments = chainSegments;
  TE.tracePathStrokes = tracePathStrokes;
  TE.enforceTerrainSizes = enforceTerrainSizes;
  TE.registerGen = registerGen;
  TE.hydrateGenerated = hydrateGenerated;
  if (typeof module !== 'undefined' && module.exports) module.exports = TE;
  root.TileEngine = TE;
})(typeof self !== 'undefined' ? self : this);
