/* ==========================================================================
   Race-mode core (BGC) — the roll-and-advance play loop, game-agnostic.
   Move-mode games (chess/checkers/Chinese Checkers) are select-and-move; race
   games (Royal Game of Ur, Ludo/Pachisi, Snakes & Ladders, horse race…) are
   ROLL a die, then advance ONE piece along a declared TRACK. This module owns
   the dice, the declarative track model, legal-move generation for a roll,
   apply, win/status, and a light race heuristic AI. It is engine-only
   (framework-agnostic, dual-context window/worker/node); the presentation host
   walks a move's `path` with the same travelGroup used for move-mode, and sends
   a captured piece HOME instead of killing it.

   ---------------------------------------------------------------------------
   The declarative TRACK a race GameDef supplies (all node ids reference the
   board's node graph so the host can render + position everything):
     track = {
       sides:   ['w','b', ...],
       perSide: N,                              // pieces per side
       routes:  { side: [nodeId, ...] },        // entry→goal ordered lane per side
                                                //   (SHARED node ids across sides = a contested lane → capture)
       home:    { side: [nodeId, ...] },        // yard parking (unentered pieces), length perSide
       done:    { side: [nodeId, ...] },        // finished parking, length perSide
       safe?:   Set|[nodeId],                   // squares where NO capture happens
       rosette?:Set|[nodeId],                   // squares that grant an extra roll
       exact?:  bool,                           // must reach the goal by exact count (Ur/Ludo) — else overshoot finishes
       blockOwn?: bool,                         // two of your own pieces can't share a route node (default true)
     }
   A piece's position is a STEP index per side: -1 = home yard, 0..L-1 = on
   route[step], L = finished. A roll r moves step → step+r (from home: -1+r).

   State: { mode:'race', turn, sides, pos:{side:[step,...]}, roll:null|{values,total,used},
            plies, seats? }  — pos[side][i] is piece i's step.
   Move:  { side, piece, from, to, path:[nodeId...], capture:nodeId|null,
            capSide, capPiece, extraTurn:bool, roll }
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---------------- dice ---------------- */
  // Each kind returns { values:[...perDie], total }. Ur = 4 binary pyramids (0..4, triangular dist);
  // d6 = one six-sided; binaryN = N coins; dN = `count` dice of `sides`.
  const rint = (n)=> (Math.random()*n)|0;
  const DICE = {
    ur(){ const v=[0,0,0,0].map(()=>rint(2)); return { values:v, total:v.reduce((a,b)=>a+b,0) }; },
    d6(){ const v=[1+rint(6)]; return { values:v, total:v[0] }; },
    binary(n){ n=n||4; const v=[]; for(let i=0;i<n;i++) v.push(rint(2)); return { values:v, total:v.reduce((a,b)=>a+b,0) }; },
    dN(sides,count){ sides=sides||6; count=count||1; const v=[]; for(let i=0;i<count;i++) v.push(1+rint(sides)); return { values:v, total:v.reduce((a,b)=>a+b,0) }; }
  };
  function rollDice(diceCfg){
    if (typeof diceCfg === 'function') return diceCfg();
    diceCfg = diceCfg || { kind:'d6' };
    const fn = DICE[diceCfg.kind] || DICE.d6;
    return fn(diceCfg.n || diceCfg.count, diceCfg.count);
  }

  const asSet = (x)=> x instanceof Set ? x : new Set(x||[]);

  /* ---------------- track queries ---------------- */
  function routeLen(track, side){ return track.routes[side].length; }
  // node id a piece of `side`/`piece` sits on for a given step
  function nodeOfStep(track, side, piece, step){
    const L = routeLen(track, side);
    if (step < 0)  return track.home[side][piece];
    if (step >= L) return (track.done[side][piece] != null) ? track.done[side][piece] : track.done[side][track.done[side].length-1];
    return track.routes[side][step];
  }
  // current node of a specific piece
  const pieceNode = (track, state, side, piece)=> nodeOfStep(track, side, piece, state.pos[side][piece]);

  /* ---------------- initial state ---------------- */
  function initialState(track, opts){
    opts = opts || {};
    const sides = track.seats || track.sides;
    const pos = {};
    for (const s of track.sides) pos[s] = new Array(track.perSide).fill(-1);   // everyone in the yard
    return { mode:'race', turn: sides[0], sides: track.sides, seats: sides.slice(),
             pos, roll:null, plies:0 };
  }
  const nextSeat = (state)=>{ const seats = state.seats || state.sides; const i = seats.indexOf(state.turn); return seats[(i+1)%seats.length]; };

  /* ---------------- move generation for a roll ---------------- */
  // Given the side to move and a rolled total, list the legal single-piece advances.
  function movesForRoll(track, state, side, total){
    const out = [];
    if (total <= 0) return out;                         // a 0 forfeits the turn (handled by the loop)
    const L = routeLen(track, side);
    const exact = !!track.exact;
    const blockOwn = track.blockOwn !== false;
    const safe = asSet(track.safe), rosette = asSet(track.rosette);
    // where do this side's own pieces currently sit (by node id) so we can block self-stacking
    const ownAt = {};
    for (let i=0;i<track.perSide;i++){ const st=state.pos[side][i]; if (st>=0 && st<L) ownAt[track.routes[side][st]] = i; }

    for (let piece=0; piece<track.perSide; piece++){
      const step = state.pos[side][piece];
      if (step >= L) continue;                          // already finished
      let to = step + total;
      // finishing rules
      if (to >= L){
        if (exact && to > L) continue;                  // overshoot not allowed under exact-finish
        to = L;                                          // finished
      }
      const destNode = nodeOfStep(track, side, piece, to);
      // block landing on your own piece (on-route only)
      if (to < L && blockOwn && ownAt[destNode] != null && ownAt[destNode] !== piece) continue;
      // capture? an opponent sitting on the same on-route node, unless it's safe
      let capture=null, capSide=null, capPiece=null;
      if (to < L && !safe.has(destNode)){
        for (const os of track.sides){ if (os===side) continue;
          for (let j=0;j<track.perSide;j++){ const ost=state.pos[os][j];
            if (ost>=0 && ost<routeLen(track,os) && track.routes[os][ost]===destNode){ capture=destNode; capSide=os; capPiece=j; break; } }
          if (capture!=null) break; }
      }
      // path: current node → each intermediate route node → destination
      const path = [ nodeOfStep(track, side, piece, step) ];
      for (let k=Math.max(step+1,0); k<Math.min(to,L); k++) path.push(track.routes[side][k]);
      if (path[path.length-1] !== destNode) path.push(destNode);
      const extraTurn = (to<L) && rosette.has(destNode);
      out.push({ side, piece, from:step, to, path, capture, capSide, capPiece, extraTurn, roll:total });
    }
    return out;
  }

  /* ---------------- apply ---------------- */
  function applyMove(track, state, m){
    const pos = {}; for (const s of track.sides) pos[s] = state.pos[s].slice();
    pos[m.side][m.piece] = m.to;
    if (m.capture != null && m.capSide != null) pos[m.capSide][m.capPiece] = -1;   // sent home
    const keepTurn = !!m.extraTurn;
    const ns = { mode:'race', turn: keepTurn ? state.turn : (function(){ const seats=state.seats||state.sides; const i=seats.indexOf(state.turn); return seats[(i+1)%seats.length]; })(),
                 sides: state.sides, seats: state.seats, pos, roll:null, plies: state.plies+1 };
    return ns;
  }

  /* ---------------- status ---------------- */
  const sideFinished = (track, state, side)=> state.pos[side].every(st => st >= routeLen(track, side));
  function status(track, state){
    for (const s of (state.seats||state.sides)) if (sideFinished(track, state, s))
      return { over:true, winner:s, draw:false, turn:state.turn, note:'home' };
    if (state.plies >= (track.plyCap||2000)) return { over:true, draw:true, turn:state.turn, note:'ply cap' };
    return { over:false, turn:state.turn };
  }

  /* ---------------- race heuristic AI ----------------
     Score a move: finishing > capturing > landing on a rosette/safe > raw advance,
     with a small preference for advancing the most-behind piece and for entering
     new pieces. Works for any player count (race is not zero-sum negamax). */
  function scoreMove(track, state, m){
    const L = routeLen(track, m.side);
    let s = 0;
    if (m.to >= L)        s += 1000;                 // finish a piece
    if (m.capture != null) s += 600;                 // send an opponent home
    if (m.extraTurn)      s += 250;                  // land on a rosette (extra roll)
    if (m.from < 0)       s += 40;                   // get a new piece onto the board
    s += (m.to - Math.max(m.from,0)) * 8;            // distance advanced
    s += m.to * 4;                                   // overall progress
    return s;
  }
  function bestMove(track, state, moves, level){
    if (!moves.length) return null;
    if (moves.length===1) return moves[0];
    const jitter = level==='easy' ? 300 : level==='hard' ? 8 : 60;
    let best=null, bs=-1e18;
    for (const m of moves){ const sc = scoreMove(track, state, m) + Math.random()*jitter; if (sc>bs){ bs=sc; best=m; } }
    return best;
  }

  /* ---------------- headless driver (tests / CPU-vs-CPU) ---------------- */
  function playOut(def, opts){
    opts = opts || {}; const track = def.track;
    let state = opts.state || def.setup();
    let plies=0, caps=0, fins=0, rolls=0; const max = opts.maxPlies || 4000;
    while (plies < max){
      const st = def.status(state); if (st.over) return { state, result:st, plies, caps, fins, rolls };
      const side = def.turnOf(state);
      const roll = rollDice(def.dice); rolls++;
      const moves = def.raceMoves(state, roll.total);
      if (!moves.length){ state = passTurn(track, state); plies++; continue; }   // no legal move → forfeit
      const mv = (opts.pick || bestMove)(track, state, moves, opts.level);
      if (mv.capture!=null) caps++; if (mv.to>=routeLen(track,side)) fins++;
      state = def.applyMove(state, mv); plies++;
    }
    return { state, result: def.status(state), plies, caps, fins, rolls, note:'maxPlies' };
  }
  function passTurn(track, state){
    const pos={}; for(const s of track.sides) pos[s]=state.pos[s].slice();
    return { mode:'race', turn:nextSeat(state), sides:state.sides, seats:state.seats, pos, roll:null, plies:state.plies+1 };
  }

  const API = { DICE, rollDice, initialState, movesForRoll, applyMove, status, nodeOfStep, pieceNode,
                routeLen, nextSeat, passTurn, scoreMove, bestMove, playOut };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.RaceCore = API;
})(typeof self !== 'undefined' ? self : this);
