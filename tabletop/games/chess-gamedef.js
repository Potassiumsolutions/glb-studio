/* ==========================================================================
   Chess GameDef — wraps the perft-verified chess-engine.js as a BGC GameDef.
   The rules are NOT rewritten (they're provably correct); this only normalises the
   engine's API to the game-agnostic interface the Board-Game Core drives.
   Depends on window.Chess (chess-engine.js) + window.ChessAI (chess-ai.js, for eval).
   ========================================================================== */
(function (root) {
  'use strict';
  const C = root.Chess, AI = root.ChessAI;
  const ROLE_NAME = { p:'Pawn', n:'Knight', b:'Bishop', r:'Rook', q:'Queen', k:'King' };
  const TRAVEL = { p:'walk', n:'hop', b:'slide', r:'slide', q:'slide', k:'walk' };

  const def = {
    id:'chess', name:'Chess', icon:'♞', mode:'move',
    board:{ cols:8, rows:8, tile:'square', files:'abcdefgh' },   // node id = rank*8+file (matches chess-engine.js sq())
    sides:['w','b'],
    roles: ['p','n','b','r','q','k'].flatMap(k => ['w','b'].map(side =>
      ({ key:side+k, role:k, side, name:ROLE_NAME[k], count:(k==='p'?8:k==='q'||k==='k'?1:2), motionCategory:'move' }))),
    setup: ()=> C.initialState(),
    turnOf: (s)=> s.turn,
    opp: (c)=> C.opp(c),
    legalMoves: (s)=> C.legalMoves(s),
    legalFrom: (s, from)=> C.legalFrom(s, from),
    applyMove: (s, m)=> C.applyMove(s, m),
    status: (s)=>{ const st = C.status(s);           // engine returns a string
      if (st==='checkmate') return { over:true, winner:C.opp(s.turn), draw:false, turn:s.turn, note:'checkmate' };
      if (st==='stalemate') return { over:true, draw:true, turn:s.turn, note:'stalemate' };
      return { over:false, turn:s.turn, note: st==='check' ? 'check' : '' };
    },
    pathOf: (m)=> [m.from, m.to],                    // chess pieces teleport one hop (rook handled as an extra mover)
    capturedNodes: (s, m)=>{                          // normal capture OR en-passant target
      if (m.flag==='ep') return [C.sq(C.fileOf(m.to), C.rankOf(m.from))];
      return s.board[m.to] ? [m.to] : [];
    },
    promoOf: (m)=> m.flag==='promo' ? (m.promo || 'q') : null,
    extraMovers: (s, m)=>{                            // the castling rook travels too
      if (m.flag!=='castleK' && m.flag!=='castleQ') return [];
      const r = C.rankOf(m.from);
      const rookFrom = m.flag==='castleK' ? C.sq(7,r) : C.sq(0,r);
      const rookTo   = m.flag==='castleK' ? C.sq(5,r) : C.sq(3,r);
      return [{ from: rookFrom, to: rookTo, style:'slide' }];
    },
    travelStyleFor: (role, m)=> TRAVEL[(role||'').replace(/^[wb]/,'')] || 'walk',
    roleAt: (s, node)=>{ const p = s.board[node]; return p ? p.c + p.t : null; },
    eval: (s, side)=>{ const w = AI ? AI.evaluate(s.board) : 0; return side==='w' ? w : -w; }
  };

  root.BGC_GAMES = root.BGC_GAMES || {};
  root.BGC_GAMES.chess = def;
  if (typeof module !== 'undefined' && module.exports) module.exports = def;
})(typeof self !== 'undefined' ? self : this);
