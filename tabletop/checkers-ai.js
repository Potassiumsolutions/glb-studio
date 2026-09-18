/* ==========================================================================
   GLB Checkers — computer player.  Negamax + alpha-beta with a material +
   positional evaluation.  Depends on window.Checkers (checkers-engine.js).
   Captures are mandatory, so the branching factor is small and search is deep.
   Runs on the main thread (fallback) or inside checkers-ai-worker.js.
   ========================================================================== */
(function (G) {
  'use strict';
  const C = G.Checkers;
  const MAN = 100, KING = 175, WIN = 1000000;

  // Positional bonus tables (white-oriented, flat 64, indexed by square). Encourage
  // advancing men toward the crowning row, holding the back rank early, and center control.
  // Only dark squares are ever occupied; the rest are dead entries.
  function evalWhite(state) {
    const b = state.board; let sc = 0, wp = 0, bp = 0;
    for (let s = 0; s < 64; s++) {
      const p = b[s]; if (!p) continue;
      const f = C.fileOf(s), r = C.rankOf(s);
      let v = p.k ? KING : MAN;
      if (p.c === 'w') {
        wp++;
        if (!p.k) v += r * 6;                       // advance toward rank 7 (crown)
        if (r === 0) v += 5;                        // guard own back rank
      } else {
        bp++;
        if (!p.k) v += (7 - r) * 6;                 // black advances toward rank 0
        if (r === 7) v += 5;
      }
      // center files are safer than the edges; edge men can't be captured but do little
      const centerF = 3.5 - Math.abs(f - 3.5);      // 0 (edge) .. 3.5 (center)
      v += centerF * 2;
      sc += p.c === 'w' ? v : -v;
    }
    // trading-down when ahead: reward fewer enemy pieces proportional to your lead
    if (wp !== bp) sc += (wp - bp) * 4;
    return sc;
  }

  // Prefer bigger captures first for better alpha-beta pruning.
  function order(moves) {
    return moves.map(m => ({ m, s: (m.captures ? m.captures.length * 100 : 0) + (m.promo ? 30 : 0) }))
                .sort((a, b) => b.s - a.s).map(x => x.m);
  }

  function search(state, depth, alpha, beta, ply) {
    const st = C.status(state);
    if (st.over) {
      if (st.draw) return 0;
      // side to move has lost (winner is the other side) → very bad for the side to move
      return -(WIN - ply);
    }
    if (depth <= 0) return evalWhite(state) * (state.turn === 'w' ? 1 : -1);
    const moves = order(C.legalMoves(state));
    // capture-extension: when the position is a forced capture, don't spend a depth ply on it
    // (settle the whole exchange) — but cap the extension so it can't recurse forever.
    const forced = moves.length && moves[0].captures && moves[0].captures.length;
    const nd = (forced && ply < 20) ? depth : depth - 1;
    let best = -Infinity;
    for (const m of moves) {
      const sc = -search(C.applyMove(state, m), nd, -beta, -alpha, ply + 1);
      if (sc > best) best = sc;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function bestMove(state, opts) {
    opts = opts || {};
    const depth = opts.depth || 5;
    const level = opts.level || 'medium';
    const moves = order(C.legalMoves(state));
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];           // forced single move — no need to think
    // Easy: sometimes play a random legal move so beginners can win
    if (level === 'easy' && Math.random() < 0.3) return moves[(Math.random() * moves.length) | 0];
    let best = -Infinity, bestMoves = [], alpha = -Infinity;
    for (const m of moves) {
      const forced = m.captures && m.captures.length;
      const sc = -search(C.applyMove(state, m), forced ? depth : depth - 1, -Infinity, -alpha, 1);
      if (sc > best + 1) { best = sc; bestMoves = [m]; }
      else if (Math.abs(sc - best) <= 1) bestMoves.push(m);
      if (best > alpha) alpha = best;
    }
    return bestMoves[(Math.random() * bestMoves.length) | 0];
  }

  G.CheckersAI = { bestMove, evaluate: evalWhite };
})(typeof window !== 'undefined' ? window : self);
