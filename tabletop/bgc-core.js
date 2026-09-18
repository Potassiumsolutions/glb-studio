/* ==========================================================================
   Board-Game Core (BGC) — the game-agnostic engine layer for the KSOL
   Board-Game Builder. It is driven entirely by an active **GameDef** and knows
   nothing about any specific game's rules. Extracted from the two working games
   (GLB Chess + GLB Checkers) per the plan's "rule of three" — chess and checkers
   become GameDefs that plug into this one core (see games/*.js).

   This file is the RULES/AI/flow half (framework-agnostic, dual-context
   window/worker/node). The three.js presentation half (board render, rig/skin,
   motions, travel/dust/kill-cam, cameras, export) is shared verbatim from the two
   apps and folds in on top of this — it consumes `movePlan()` to animate any move.

   ---------------------------------------------------------------------------
   GameDef interface (move-mode; race-mode adds dice/raceMoves — see plan §5/§6):
     {
       id, name, icon?, mode:'move',
       sides:            ['w','b', ...],          // 2+ players/colours
       roles:            [{ key, name, side?, count, motionCategory? }],  // rig slots
       board?:           { ... },                 // node-graph board (render hint)
       setup():          State,                   // initial position
       turnOf(state):    side,                    // whose move it is
       opp(side):        side,                    // next side (2-player: the other)
       legalMoves(state):        Move[],          // all legal moves for side-to-move
       legalFrom(state, nodeId): Move[],          // moves from one node (for click-select)
       applyMove(state, move):   State,           // pure; returns the next state
       status(state):    { over, winner?, draw?, turn, note? },   // normalised
       // move → presentation (what the renderer needs, game-agnostic):
       pathOf(move):        nodeId[],             // [from, ...waypoints, to]
       capturedNodes(state, move): nodeId[],      // squares that die (aligned to path segments if given)
       promoOf(move):       falsy | roleKey,      // crowning/promotion → new role at `to`
       extraMovers?(state, move): [{from,to,style}],  // e.g. the castling rook
       travelStyleFor?(role, move): style,        // walk/gallop/slide/hop/fly
       eval(state, side):   number,               // + = good for `side` (for the generic AI)
     }
   ========================================================================== */
(function (root) {
  'use strict';

  const WIN = 1e7;

  /* ---- generic negamax + alpha-beta, driven only by the GameDef ---- */
  // Move ordering: captures / promotions first (helps pruning across any game).
  function orderMoves(def, state, moves){
    return moves.map(m => {
      let s = 0;
      const caps = def.capturedNodes(state, m); if (caps && caps.length) s += 100 * caps.length;
      if (def.promoOf(m)) s += 40;
      return { m, s };
    }).sort((a,b)=>b.s-a.s).map(x=>x.m);
  }
  function negamax(def, state, depth, alpha, beta, ply){
    const st = def.status(state);
    if (st.over) return st.draw ? 0 : -(WIN - ply);   // side-to-move has no move / is lost
    if (depth <= 0) return def.eval(state, def.turnOf(state));
    const moves = orderMoves(def, state, def.legalMoves(state));
    if (!moves.length) return def.eval(state, def.turnOf(state));
    let best = -Infinity;
    for (const m of moves){
      const sc = -negamax(def, def.applyMove(state, m), depth-1, -beta, -alpha, ply+1);
      if (sc > best) best = sc;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  // Best move for the side to move. level → search depth; 'easy' also plays random sometimes.
  function bestMove(def, state, opts){
    opts = opts || {};
    if (def.ai) return def.ai(state, opts.level);            // the game supplies its own AI (e.g. multiplayer greedy)
    let depth = opts.depth || (opts.level==='easy'?2 : opts.level==='hard'?4 : 3);
    if (def.aiDepth) depth = Math.min(depth, def.aiDepth);   // graph/high-branching games cap the search
    const moves = orderMoves(def, state, def.legalMoves(state));
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];
    if (opts.level==='easy' && Math.random() < 0.3) return moves[(Math.random()*moves.length)|0];
    let best = -Infinity, bestMoves = [], alpha = -Infinity;
    for (const m of moves){
      const sc = -negamax(def, def.applyMove(state, m), depth-1, -Infinity, -alpha, 1);
      if (sc > best + 1){ best = sc; bestMoves = [m]; }
      else if (Math.abs(sc - best) <= 1) bestMoves.push(m);
      if (best > alpha) alpha = best;
    }
    return bestMoves[(Math.random()*bestMoves.length)|0];
  }

  /* ---- movePlan: the unified animation script the renderer walks for ANY game ----
     Turns one Move into ordered segments (each an optional capture), plus promotion
     and any extra movers (castling rook). GLB Chess/Checkers' performMove becomes a
     single loop over this, so one renderer drives every game. */
  function movePlan(def, state, move){
    const path = def.pathOf(move);
    const caps = def.capturedNodes(state, move) || [];
    // Align captures to segments: multi-jump games hand back caps[i] between path[i]/path[i+1];
    // single-step capture games hand back one cap that lands on the final segment.
    const segs = [];
    const perSegment = caps.length === path.length - 1;   // checkers-style chain
    for (let i=0; i<path.length-1; i++){
      const cap = perSegment ? (caps[i] ?? null)
                             : (i === path.length-2 ? (caps[0] ?? null) : null);
      segs.push({ from: path[i], to: path[i+1], capture: cap });
    }
    // captures not tied to the mover's own path (e.g. en passant target off the destination)
    const segCaps = new Set(segs.map(s=>s.capture).filter(c=>c!=null));
    const looseCaps = caps.filter(c => !segCaps.has(c));
    return {
      from: path[0], to: path[path.length-1], segments: segs,
      captures: caps, looseCaptures: looseCaps,
      promo: def.promoOf(move) || null,
      extraMovers: def.extraMovers ? (def.extraMovers(state, move) || []) : [],
      turn: def.turnOf(state)
    };
  }

  /* ---- headless driver: play a whole game with the generic AI (for tests/CPU-vs-CPU) ---- */
  function playOut(def, opts){
    opts = opts || {}; let state = opts.state || def.setup();
    const trace = []; let plies = 0, caps = 0, promos = 0;
    const max = opts.maxPlies || 1000;
    while (plies < max){
      const st = def.status(state);
      if (st.over) return { state, result: st, plies, caps, promos, trace };
      const mv = (opts.pick || bestMove)(def, state, { depth: opts.depth, level: opts.level });
      if (!mv) return { state, result: def.status(state), plies, caps, promos, trace, note:'no move but not over' };
      const plan = movePlan(def, state, mv);
      caps += plan.captures.length; if (plan.promo) promos++;
      if (opts.trace) trace.push({ from: plan.from, to: plan.to, caps: plan.captures.length, promo: !!plan.promo });
      state = def.applyMove(state, mv); plies++;
    }
    return { state, result: def.status(state), plies, caps, promos, trace, note:'maxPlies' };
  }

  /* ---- board topology helpers (the presentation host walks these, game-agnostic) ----
     A GameDef's `board` declares the node graph; for a plain grid it's {cols,rows} and the
     node id is rank*cols+file (matching both engines' sq()). boardNodes lists every node id
     the renderer may place a tile/piece on; piecesMap is the authoritative occupancy of a
     state (node -> roleKey) via def.roleAt — the host compares its own piece bookkeeping to
     this after every move, and test-host.js proves the two stay identical. */
  function boardNodes(def){
    const b = def.board || { cols:8, rows:8 };
    if (b.nodes) return b.nodes.map(n => (n && typeof n === 'object') ? n.id : n);  // graph nodes are {id,x,z,..}
    const cols = b.cols||8, rows = b.rows||8, a=[];
    for (let i=0;i<cols*rows;i++) a.push(i);
    return a;
  }
  function nodeXZ(def, node){                         // node id -> {f,r} grid coords (centred by the host)
    const b = def.board || { cols:8, rows:8 }; const cols = b.cols||8;
    if (b.xz) return b.xz(node);                       // custom layouts (hex/track) can override
    return { f: node % cols, r: (node / cols) | 0 };
  }
  function piecesMap(def, state){                     // node -> roleKey for every occupied node
    const m = new Map();
    for (const nd of boardNodes(def)){ const role = def.roleAt ? def.roleAt(state, nd) : null; if (role) m.set(nd, role); }
    return m;
  }

  /* ---- validate a GameDef implements the interface (dev aid) ---- */
  function validateDef(def){
    const common = ['id','sides','setup','turnOf','opp','applyMove','status','pathOf','capturedNodes'];
    const need = def.mode==='race'
      ? common.concat(['track','dice','raceMoves','raceBest'])          // race-mode interface
      : common.concat(['legalMoves','legalFrom','promoOf','eval']);     // move-mode interface
    const missing = need.filter(k => def[k] === undefined);
    return { ok: missing.length===0, missing };
  }

  const API = { bestMove, negamax, orderMoves, movePlan, playOut, validateDef, boardNodes, nodeXZ, piecesMap, WIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.BGC = API;
  root.BGC_GAMES = root.BGC_GAMES || {};
})(typeof self !== 'undefined' ? self : this);
