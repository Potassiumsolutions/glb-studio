/* ==========================================================================
   Checkers GameDef — wraps checkers-engine.js as a BGC GameDef. Same pattern as
   chess: the verified rules stay untouched; this only maps the engine to the
   game-agnostic interface. Depends on window.Checkers + window.CheckersAI.
   ========================================================================== */
(function (root) {
  'use strict';
  const C = root.Checkers, AI = root.CheckersAI;

  const def = {
    id:'checkers', name:'Checkers', icon:'⛃', mode:'move',
    board:{ cols:8, rows:8, tile:'square', files:'abcdefgh' },   // node id = rank*8+file; only dark squares are playable
    sides:['w','b'],
    roles: ['m','k'].flatMap(k => ['w','b'].map(side =>
      ({ key:side+k, role:k, side, name:(k==='m'?'Man':'King'), count:(k==='m'?12:0), motionCategory:'move' }))),
    setup: ()=> C.initialState(),
    turnOf: (s)=> s.turn,
    opp: (c)=> C.opp(c),
    legalMoves: (s)=> C.legalMoves(s),
    legalFrom: (s, from)=> C.legalFrom(s, from),
    applyMove: (s, m)=> C.applyMove(s, m),
    status: (s)=>{ const st = C.status(s);           // engine returns an object already
      return { over:!!st.over, winner:st.winner, draw:!!st.draw, turn:s.turn, note:st.reason||'' };
    },
    pathOf: (m)=> (m.path && m.path.length>1) ? m.path : [m.from, m.to],
    capturedNodes: (s, m)=> (m.captures ? m.captures.slice() : []),   // aligned to path segments
    promoOf: (m)=> m.promo ? 'k' : null,             // a crowned man becomes a King
    extraMovers: ()=> [],
    travelStyleFor: ()=> 'walk',
    roleAt: (s, node)=>{ const p = s.board[node]; return p ? p.c + (p.k?'k':'m') : null; },
    eval: (s, side)=>{ const w = AI ? AI.evaluate(s) : 0; return side==='w' ? w : -w; }
  };

  root.BGC_GAMES = root.BGC_GAMES || {};
  root.BGC_GAMES.checkers = def;
  if (typeof module !== 'undefined' && module.exports) module.exports = def;
})(typeof self !== 'undefined' ? self : this);
