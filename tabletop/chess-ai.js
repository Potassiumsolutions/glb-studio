/* ==========================================================================
   GLB Chess — computer player.  Negamax + alpha-beta + quiescence, with a
   material + piece-square evaluation.  Depends on window.Chess (chess-engine.js).
   Runs on the main thread (fallback) or inside ai-worker.js. Exposes ChessAI.
   ========================================================================== */
(function (G) {
  'use strict';
  const C = G.Chess;
  const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
  const MATE = 1000000;

  // Piece-square tables (Michniewski), flat 64, row 0 = rank 8 (black's back rank).
  const PST = {
    p: [ 0,0,0,0,0,0,0,0,  50,50,50,50,50,50,50,50,  10,10,20,30,30,20,10,10,
         5,5,10,25,25,10,5,5,  0,0,0,20,20,0,0,0,  5,-5,-10,0,0,-10,-5,5,
         5,10,10,-20,-20,10,10,5,  0,0,0,0,0,0,0,0 ],
    n: [ -50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40,
         -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
         -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30,
         -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50 ],
    b: [ -20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10,
         -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
         -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10,
         -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20 ],
    r: [ 0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5,
         -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
         -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0 ],
    q: [ -20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10,
         -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10,
         -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20 ],
    k: [ -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
         -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
         -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
         20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20 ]
  };
  function pst(t, s, color) {
    const r = color === 'w' ? 7 - C.rankOf(s) : C.rankOf(s);
    return t[r * 8 + C.fileOf(s)];
  }
  // white-positive centipawn score
  function evalWhite(board) {
    let sc = 0;
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (!p) continue;
      const v = VAL[p.t] + pst(PST[p.t], s, p.c);
      sc += p.c === 'w' ? v : -v;
    }
    return sc;
  }
  const isCap = (state, m) => !!state.board[m.to] || m.flag === 'ep' || m.flag === 'promo';
  function order(state, moves) {
    return moves.map((m) => {
      let s = 0;
      const vic = state.board[m.to];
      if (vic) s = 10 * VAL[vic.t] - VAL[state.board[m.from].t];
      if (m.flag === 'promo') s += 800;
      if (m.flag === 'ep') s += 90;
      return { m, s };
    }).sort((a, b) => b.s - a.s).map((x) => x.m);
  }
  function quiesce(state, alpha, beta, ply) {
    const stand = evalWhite(state.board) * (state.turn === 'w' ? 1 : -1);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (ply > 6) return alpha;
    const caps = order(state, C.legalMoves(state).filter((m) => isCap(state, m)));
    for (const m of caps) {
      const sc = -quiesce(C.applyMove(state, m), -beta, -alpha, ply + 1);
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  function search(state, depth, alpha, beta, ply, useQ) {
    const moves = C.legalMoves(state);
    if (moves.length === 0) return C.inCheck(state, state.turn) ? -(MATE - ply) : 0;
    if (depth === 0) return useQ ? quiesce(state, alpha, beta, ply)
                                 : evalWhite(state.board) * (state.turn === 'w' ? 1 : -1);
    let best = -Infinity;
    for (const m of order(state, moves)) {
      const sc = -search(C.applyMove(state, m), depth - 1, -beta, -alpha, ply + 1, useQ);
      if (sc > best) best = sc;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  function bestMove(state, opts) {
    opts = opts || {};
    const depth = opts.depth || 3;
    const level = opts.level || 'medium';
    const useQ = level !== 'easy';
    const moves = order(state, C.legalMoves(state));
    if (!moves.length) return null;
    // Easy: occasional random move so beginners can win
    if (level === 'easy' && Math.random() < 0.3) return moves[(Math.random() * moves.length) | 0];
    let best = -Infinity, bestMoves = [], alpha = -Infinity;
    for (const m of moves) {
      const sc = -search(C.applyMove(state, m), depth - 1, -Infinity, -alpha, 1, useQ);
      if (sc > best + 1) { best = sc; bestMoves = [m]; }
      else if (Math.abs(sc - best) <= 1) bestMoves.push(m);
      if (best > alpha) alpha = best;
    }
    return bestMoves[(Math.random() * bestMoves.length) | 0];
  }
  G.ChessAI = { bestMove, evaluate: evalWhite };
})(typeof window !== 'undefined' ? window : self);
