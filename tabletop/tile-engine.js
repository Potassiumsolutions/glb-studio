/* ==========================================================================
   Board Tile Engine — core (framework-agnostic, dual-context window/worker/node)
   ------------------------------------------------------------------------------
   A Carcassonne-style edge-matching tile system for the KSOL Board-Game Builder.
   Tiles carry a BIOME (theme) and, on each edge, a PATH connector (road / trail /
   river / wall / none). A tile may only be placed where every shared edge's PATH
   matches its neighbour EXACTLY (strict): road meets road, trail meets trail, a
   plain edge meets a plain edge — a road can never dead-end into a field and a
   trail can never touch a road. Different BIOMES may only abut when they are a
   natural pair (e.g. plains/forest) or when a TRANSITION tile bridges them
   (e.g. a city wall tile between city and plains). Works on SQUARE (4-edge) and
   HEX (6-edge) grids from the same data model.
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---- connector (path) types carried on a tile edge ---- */
  const PATH = { NONE:0, ROAD:1, TRAIL:2, RIVER:3, WALL:4, RAIL:5 };            // RAIL = railway (Modern Pack)
  const PATH_NAME = ['none','road','trail','river','wall','rail'];
  const PATH_COLOR = { none:0x000000, road:0xC9A24B, trail:0x8a6a44, river:0x3d7fb0, wall:0x8b8b93, rail:0x5a5048 };

  /* ---- biomes (themes) ---- */
  const BIOME = { PLAINS:'plains', VILLAGE:'village', CITY:'city', FOREST:'forest', MOUNTAINS:'mountains', WATER:'water', SNOW:'snow', ROCKS:'rocks',
    SAND:'sand', PLAZA:'plaza', DIRT:'dirt', GREEN:'green',
    CROPS:'crops', ORCHARD:'orchard', PIVOT:'pivot',
    URBAN:'urban', SUBURB:'suburb', LOT:'lot', PARK:'park' };   // MODERN PACK: city pavement · suburban lawn lots · asphalt parking · parkland   // sand = desert dune; town-ground bases: cobble plaza, packed dirt, town green; farmland: crop rows, fruit-tree orchard, centre-pivot circle
  const BIOME_COLOR = {
    plains:0x8Fae55, village:0x9c9464, city:0x9a9298, forest:0x3f6d3a, mountains:0x8a8172, water:0x3d7fb0,
    snow:0xdfe9f2, rocks:0x8d8577, sand:0xd9c48f,
    plaza:0x9a927e, dirt:0x8a6a44, green:0x6f9a45,
    crops:0x9caa4a, orchard:0x517b39, pivot:0x86a24e,
    urban:0x9c9ea3, suburb:0x7fa44e, lot:0x4a4c50, park:0x6f9a45
  };
  // biome pairs that may abut directly with no transition tile (symmetric).
  // NOTE: keys MUST be in canonical pairKey order (alphabetical, a<b) or they never
  // match — the two biomes are joined smallest-name-first below.
  const pairKey = (a,b)=> a<b ? a+'|'+b : b+'|'+a;
  const NATURAL = new Set([
    'forest|plains','mountains|plains','plains|village','plains|water',
    'forest|mountains','forest|village','mountains|water','forest|water',
    'mountains|snow','plains|snow','forest|snow','mountains|rocks','plains|rocks','rocks|snow','forest|rocks','rocks|village',
    // sand (desert dune) abuts open ground, rocks, beaches, dirt & desert settlements
    'plains|sand','rocks|sand','sand|water','sand|village','dirt|sand','city|sand',
    // town-ground bases sit among plains/village/city and each other
    'plaza|plains','plaza|village','city|plaza','plaza|dirt','plaza|green',
    'dirt|plains','dirt|village','dirt|green','dirt|city',
    'green|plains','green|village','green|forest','city|green',
    // farmland (crops / orchard / centre-pivot) sits on open ground, by settlements & irrigation water, and against each other
    'crops|plains','crops|dirt','crops|village','crops|water','crops|green',
    'orchard|plains','orchard|village','orchard|green','orchard|forest','orchard|dirt',
    'pivot|plains','pivot|dirt','pivot|water','pivot|village','pivot|green',
    'crops|orchard','crops|pivot','orchard|pivot',
    // modern development sits on (almost) anything that isn't high mountain
    ...['urban','suburb','lot','park'].flatMap(m=>['plains','forest','water','rocks','sand','green','dirt','crops','orchard','pivot','village','city','plaza','urban','suburb','lot','park'].filter(o=>o!==m).map(o=>m+'|'+o)),
  ].map(k=>{ const [a,b]=k.split('|'); return pairKey(a,b); }));

  /* ================= grids ================= */
  // Each grid knows its edge count, neighbour stepping, the opposite edge, a world
  // position for a cell, and — for rendering — the local (x,z) midpoint of each edge
  // on a unit tile plus the tile's polygon corners.
  const SQ3 = Math.sqrt(3);
  const GRIDS = {
    square: {
      kind:'square', N:4, dirNames:['N','E','S','W'],
      // edge order N,E,S,W → neighbour deltas in (col q, row r)
      _d:[[0,-1],[1,0],[0,1],[-1,0]],
      step(p,dir){ const d=this._d[dir]; return { q:p.q+d[0], r:p.r+d[1] }; },
      opposite(dir){ return (dir+2)%4; },
      world(p){ return { x:p.q, z:p.r }; },
      // unit tile of side 1; edge midpoints (local x,z) and square corners
      edgeMid(dir){ return [[0,-0.5],[0.5,0],[0,0.5],[-0.5,0]][dir]; },
      edgeAngle(dir){ return [0, Math.PI/2, Math.PI, -Math.PI/2][dir]; },   // outward normal heading (atan2(x,z))
      corners(){ return [[-0.5,-0.5],[0.5,-0.5],[0.5,0.5],[-0.5,0.5]]; }
    },
    hex: {
      kind:'hex', N:6, dirNames:['ESE','ENE','N','WNW','WSW','S'],
      // FLAT-TOP axial (q,r) — flat edges on top & bottom, vertices left & right — to MATCH The Game Crafter's
      // hex tiles/mats so what's designed on screen prints in the same orientation. 6 neighbour directions.
      _d:[[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]],
      step(p,dir){ const d=this._d[dir]; return { q:p.q+d[0], r:p.r+d[1] }; },
      opposite(dir){ return (dir+3)%6; },
      // flat-top axial → world; tile "radius" (centre→corner) = 0.5. Columns (q) step 1.5R in x; rows (r) step
      // √3R in z; each q shears z by half a row. (Point-to-point width 2R=1.0, flat-to-flat height √3R≈0.866.)
      world(p){ const R=0.5; return { x:R*1.5*p.q, z:R*SQ3*(p.r + p.q/2) }; },
      // edge midpoint toward neighbour `dir` = HALF the centre→centre vector for that _d step. Deriving it
      // straight from _d keeps every edge locked to its neighbour (no hand-tuned angle can drift out of step).
      edgeMid(dir){ const R=0.5, d=this._d[dir]; return [ R*1.5*d[0]/2, R*SQ3*(d[1] + d[0]/2)/2 ]; },
      edgeAngle(dir){ const e=this.edgeMid(dir); return Math.atan2(e[0], e[1]); },
      corners(){ const R=0.5, out=[]; for(let i=0;i<6;i++){ const a=i*Math.PI/3; out.push([R*Math.cos(a), R*Math.sin(a)]); } return out; }   // flat-top: vertices L/R, flats top/bottom
    }
  };
  const gridFor = (kind)=> GRIDS[kind] || GRIDS.square;
  const keyOf = (p)=> p.q+','+p.r;

  /* ================= tiles ================= */
  // A tile definition: { id, biome, transition?, edges:[ {path, biome} x N ], feature? }
  // edgeAt() reads the edge now facing `dir` after the tile has been rotated `rot`
  // clockwise steps (edge originally at index i ends up facing (i+rot) mod N).
  function edgeAt(def, rot, dir){
    const N = def.edges.length;
    const e = def.edges[((dir - rot) % N + N) % N];
    // an edge is a "transition" edge if the whole tile bridges biomes, or this edge's
    // biome differs from the tile's centre biome (so a mixed tile can join two biomes)
    return { path:e.path, biome:e.biome, trans: !!def.transition || e.biome !== def.biome };
  }

  const _FARM = { crops:'plains', orchard:'plains', pivot:'plains' };   // farmland is plains ground → inherits plains' adjacency
  function biomeOk(a, b, aTrans, bTrans){
    a = _FARM[a] || a; b = _FARM[b] || b;
    if (a === b) return true;
    if (aTrans || bTrans) return true;      // a transition edge bridges any two biomes
    return NATURAL.has(pairKey(a,b));       // otherwise only natural neighbours may touch
  }

  /* Can `def` (rotated `rot`) be placed at `pos` on `board`? Strict path matching on
     every shared edge + biome compatibility. Returns {ok, reason?, touched}. */
  function canPlace(gridKind, board, pos, def, rot, defs){
    const g = gridFor(gridKind);
    if (board.has(keyOf(pos))) return { ok:false, reason:'occupied', touched:0 };
    let touched = 0;
    for (let dir=0; dir<g.N; dir++){
      const np = g.step(pos, dir);
      const nb = board.get(keyOf(np));
      if (!nb) continue;                       // empty neighbour → that edge is free
      touched++;
      const me = edgeAt(def, rot, dir);
      const nd = defs[nb.defId];
      const th = edgeAt(nd, nb.rot, g.opposite(dir));
      if (me.path !== th.path)
        return { ok:false, reason:'path '+PATH_NAME[me.path]+' ✗ '+PATH_NAME[th.path], touched };
      if (!biomeOk(me.biome, th.biome, me.trans, th.trans))
        return { ok:false, reason:'biome '+me.biome+' ✗ '+th.biome, touched };
    }
    return { ok:true, touched };
  }

  // Every legal (def,rot) for a cell, most-connected first (roads/trails that link up rank higher).
  function legalPlacements(gridKind, board, pos, defs){
    const out = [];
    for (const id in defs){ const def = defs[id];
      const rots = def.edges.length;
      for (let rot=0; rot<rots; rot++){
        const r = canPlace(gridKind, board, pos, def, rot, defs);
        if (r.ok){
          // score: prefer tiles that actively continue a path into a neighbour
          let link = 0; const g = gridFor(gridKind);
          for (let dir=0; dir<g.N; dir++){ const nb=board.get(keyOf(g.step(pos,dir)));
            if (nb && edgeAt(def,rot,dir).path!==PATH.NONE) link++; }
          out.push({ defId:id, rot, link });
        }
      }
    }
    return out.sort((a,b)=> b.link-a.link);
  }

  // A tiny deterministic RNG so a generated board is reproducible from a seed.
  function mulberry32(seed){ let a=seed>>>0; return function(){ a|=0; a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

  /* Auto-fill: place a connector-valid tile in each empty cell of `cells` (array of
     {q,r}). Grows outward so every tile abuts something already placed. Falls back to
     the most permissive tile; leaves a cell empty only if NOTHING fits. */
  function autoFill(gridKind, board, cells, defs, opts){
    opts = opts || {}; const rng = mulberry32(opts.seed||1); const g = gridFor(gridKind);
    const remaining = cells.filter(c=>!board.has(keyOf(c)));
    // if the board is empty, seed the first cell with a plains blank (or opts.seedDef)
    if (board.size === 0 && remaining.length){
      const c = remaining.shift(); board.set(keyOf(c), { defId: opts.seedDef || firstBlank(defs), rot:0 });
    }
    let placed = 0, guard = remaining.length * 6;
    while (remaining.length && guard-- > 0){
      // pick the empty cell with the most already-placed neighbours (frontier first)
      remaining.sort((a,b)=> nbCount(g,board,b) - nbCount(g,board,a));
      const c = remaining[0];
      if (nbCount(g, board, c) === 0){ remaining.shift(); continue; } // disconnected — skip for now
      const opts2 = legalPlacements(gridKind, board, c, defs);
      if (!opts2.length){ remaining.shift(); continue; }              // nothing fits — leave empty
      // weighted-random: strongly prefer continuing a path into a neighbour (link), but also
      // give some weight to STARTING a path (road/trail edges dangling into empty cells) so
      // networks actually grow instead of the board flooding with blanks.
      for (const o of opts2){ const d=defs[o.defId];
        let starts=0; for(let dir=0; dir<g.N; dir++){ if(d.edges[((dir-o.rot)%g.N+g.N)%g.N].path!==PATH.NONE && !board.has(keyOf(g.step(c,dir)))) starts++; }
        o.w = 1 + o.link*8 + Math.min(starts,2)*2; }
      const pick = weightedPick(opts2, rng);
      board.set(keyOf(c), { defId:pick.defId, rot:pick.rot }); placed++;
      remaining.shift();
    }
    return placed;
  }
  function weightedPick(list, rng){ let tot=0; for(const o of list) tot+=o.w||1; let x=rng()*tot;
    for(const o of list){ x-=(o.w||1); if(x<=0) return o; } return list[list.length-1]; }
  function nbCount(g, board, p){ let n=0; for(let d=0; d<g.N; d++) if(board.has(keyOf(g.step(p,d)))) n++; return n; }
  function firstBlank(defs){ for(const id in defs){ if(defs[id].edges.every(e=>e.path===PATH.NONE)) return id; } return Object.keys(defs)[0]; }

  /* ================= board → game node graph =================
     Turns a placed board into the plan's node-graph board model (§4): one node per
     placed tile, with world position, biome, optional zone, and an adjacency list.
     Each adjacency link carries the connector PATH crossing that shared edge and a
     `walkable` flag (road/trail/river = a route a piece can travel; wall/none = not).
     Also returns connected components of the walkable path network (for movement/race
     games) and of the road-only network. Consumed by the Board-Game Builder. */
  function boardToGraph(gridKind, board, defs, zones){
    const g = gridFor(gridKind); zones = zones || new Map();
    const nodes = {}; const order = [];
    for (const [k, pl] of board){
      const [q,r] = k.split(',').map(Number); const def = defs[pl.defId];
      const w = g.world({q,r});
      nodes[k] = { id:k, q, r, x:+w.x.toFixed(4), z:+w.z.toFixed(4), kind:g.kind,
                   biome:def.biome, tile:pl.defId, rot:pl.rot,
                   zone: zones.get(k) || null, edges:[] };
      order.push(k);
    }
    let links = 0;
    for (const k of order){ const n = nodes[k]; const pl = board.get(k);
      for (let dir=0; dir<g.N; dir++){
        const nk = keyOf(g.step({q:n.q,r:n.r}, dir)); const nb = nodes[nk]; if(!nb) continue;
        const path = edgeAt(defs[pl.defId], pl.rot, dir).path;
        const walkable = path===PATH.ROAD || path===PATH.TRAIL || path===PATH.RIVER;
        n.edges.push({ to:nk, dir, path:PATH_NAME[path], walkable });
        links++;
      }
    }
    const walkNet = components(nodes, e=>e.walkable);
    const roadNet = components(nodes, e=>e.path==='road');
    return { grid:gridKind, nodeCount:order.length, linkCount:links/2,
             nodes, order, walkNetworks:walkNet, roadNetworks:roadNet };
  }
  // connected components of the node graph using only edges that pass `keep`
  function components(nodes, keep){
    const seen = new Set(); const comps = [];
    for (const k in nodes){ if(seen.has(k)) continue;
      const stack=[k], comp=[]; seen.add(k);
      while(stack.length){ const c=stack.pop(); comp.push(c);
        for (const e of nodes[c].edges){ if(keep(e) && !seen.has(e.to)){ seen.add(e.to); stack.push(e.to); } } }
      if (comp.length>1) comps.push(comp);      // singletons aren't a "network"
    }
    return comps.sort((a,b)=>b.length-a.length);
  }

  /* ---- save / load a board (portable JSON the Game Designer can store) ---- */
  function serializeBoard(gridKind, board, zones, meta){
    const tiles = []; for (const [k,pl] of board){ const [q,r]=k.split(',').map(Number); const t={q,r,tile:pl.defId,rot:pl.rot}; if(typeof pl.variant==='number') t.variant=pl.variant; if(typeof pl.mass==='number') t.mass=pl.mass; if(pl.tree===0||pl.tree===1) t.tree=pl.tree; if(pl.img) t.img=pl.img; tiles.push(t); }
    const z = []; if(zones) for (const [k,name] of zones){ const [q,r]=k.split(',').map(Number); z.push({q,r,zone:name}); }
    return { format:'ksol-board', version:1, grid:gridKind, meta:meta||{}, tiles, zones:z };
  }
  function deserializeBoard(data){
    if(!data || data.format!=='ksol-board') throw new Error('not a ksol-board file');
    const board = new Map(), zones = new Map();
    for (const t of (data.tiles||[])){ const rec={ defId:t.tile, rot:t.rot||0 }; if(typeof t.variant==='number') rec.variant=t.variant; if(typeof t.mass==='number') rec.mass=t.mass; if(t.tree===0||t.tree===1) rec.tree=t.tree; if(t.img) rec.img=t.img; board.set(t.q+','+t.r, rec); }
    for (const zn of (data.zones||[])) zones.set(zn.q+','+zn.r, zn.zone);
    return { grid:data.grid||'square', board, zones, meta:data.meta||{} };
  }

  const API = { PATH, PATH_NAME, PATH_COLOR, BIOME, BIOME_COLOR, NATURAL, pairKey,
                GRIDS, gridFor, keyOf, edgeAt, biomeOk, canPlace, legalPlacements, autoFill, mulberry32,
                boardToGraph, serializeBoard, deserializeBoard };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.TileEngine = API;
})(typeof self !== 'undefined' ? self : this);
