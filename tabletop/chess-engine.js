/* ==========================================================================
   GLB Chess — rules engine (pure JS, no three.js)
   Board index: 0..63, index = rank*8 + file.  a1 = 0 (file 0, rank 0).
   White = 'w' plays from rank 0 upward (+rank). Black = 'b' from rank 7 down.
   Piece: { t:'p|n|b|r|q|k', c:'w|b' }
   State: { board:Array(64), turn, castling:{wK,wQ,bK,bQ}, ep:sq|null,
            half, full }
   Exposed on window.Chess
   ========================================================================== */
(function (global) {
  'use strict';

  const FILES = 'abcdefgh';
  const sq = (f, r) => r * 8 + f;
  const fileOf = (s) => s % 8;
  const rankOf = (s) => (s / 8) | 0;
  const inb = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const algebraic = (s) => FILES[fileOf(s)] + (rankOf(s) + 1);
  const opp = (c) => (c === 'w' ? 'b' : 'w');

  const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING_D = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function initialState() {
    const b = new Array(64).fill(null);
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (let f = 0; f < 8; f++) {
      b[sq(f, 0)] = { t: back[f], c: 'w' };
      b[sq(f, 1)] = { t: 'p', c: 'w' };
      b[sq(f, 6)] = { t: 'p', c: 'b' };
      b[sq(f, 7)] = { t: back[f], c: 'b' };
    }
    return {
      board: b, turn: 'w',
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      ep: null, half: 0, full: 1
    };
  }

  function cloneState(s) {
    return {
      board: s.board.slice(),
      turn: s.turn,
      castling: { wK: s.castling.wK, wQ: s.castling.wQ, bK: s.castling.bK, bQ: s.castling.bQ },
      ep: s.ep, half: s.half, full: s.full
    };
  }

  function kingSquare(board, color) {
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (p && p.t === 'k' && p.c === color) return s;
    }
    return -1;
  }

  // Is square `s` attacked by color `by` ?
  function isAttacked(board, s, by) {
    const f = fileOf(s), r = rankOf(s);
    // pawns: a `by` pawn attacking s sits one rank "behind" s relative to its march
    const pr = by === 'w' ? r - 1 : r + 1; // rank of the attacking pawn
    for (const df of [-1, 1]) {
      const ff = f + df;
      if (inb(ff, pr)) {
        const p = board[sq(ff, pr)];
        if (p && p.c === by && p.t === 'p') return true;
      }
    }
    for (const [df, dr] of KNIGHT_D) {
      const ff = f + df, rr = r + dr;
      if (inb(ff, rr)) { const p = board[sq(ff, rr)]; if (p && p.c === by && p.t === 'n') return true; }
    }
    for (const [df, dr] of KING_D) {
      const ff = f + df, rr = r + dr;
      if (inb(ff, rr)) { const p = board[sq(ff, rr)]; if (p && p.c === by && p.t === 'k') return true; }
    }
    for (const [df, dr] of DIAG) {
      let ff = f + df, rr = r + dr;
      while (inb(ff, rr)) {
        const p = board[sq(ff, rr)];
        if (p) { if (p.c === by && (p.t === 'b' || p.t === 'q')) return true; break; }
        ff += df; rr += dr;
      }
    }
    for (const [df, dr] of ORTH) {
      let ff = f + df, rr = r + dr;
      while (inb(ff, rr)) {
        const p = board[sq(ff, rr)];
        if (p) { if (p.c === by && (p.t === 'r' || p.t === 'q')) return true; break; }
        ff += df; rr += dr;
      }
    }
    return false;
  }

  function inCheck(state, color) {
    const ks = kingSquare(state.board, color);
    return ks >= 0 && isAttacked(state.board, ks, opp(color));
  }

  // Apply a fully-formed move object to a NEW state (assumes move already legal-shaped)
  function applyMove(state, m) {
    const ns = cloneState(state);
    const b = ns.board;
    const piece = b[m.from];
    const color = piece.c;
    ns.half = (piece.t === 'p' || b[m.to]) ? 0 : ns.half + 1;

    // move the piece
    b[m.to] = piece;
    b[m.from] = null;

    if (m.flag === 'ep') {
      // captured pawn sits on the moving pawn's own rank, on the destination file
      b[sq(fileOf(m.to), rankOf(m.from))] = null;
    }
    if (m.flag === 'promo') {
      b[m.to] = { t: m.promo, c: color };
    }
    if (m.flag === 'castleK') {
      const r = rankOf(m.from);
      b[sq(5, r)] = b[sq(7, r)]; b[sq(7, r)] = null;
    }
    if (m.flag === 'castleQ') {
      const r = rankOf(m.from);
      b[sq(3, r)] = b[sq(0, r)]; b[sq(0, r)] = null;
    }

    // en-passant target for next move
    ns.ep = (m.flag === 'double') ? sq(fileOf(m.from), (rankOf(m.from) + rankOf(m.to)) / 2) : null;

    // castling rights
    if (piece.t === 'k') {
      if (color === 'w') { ns.castling.wK = false; ns.castling.wQ = false; }
      else { ns.castling.bK = false; ns.castling.bQ = false; }
    }
    const touch = (s) => {
      if (s === sq(0, 0)) ns.castling.wQ = false;
      if (s === sq(7, 0)) ns.castling.wK = false;
      if (s === sq(0, 7)) ns.castling.bQ = false;
      if (s === sq(7, 7)) ns.castling.bK = false;
    };
    touch(m.from); touch(m.to);

    if (color === 'b') ns.full += 1;
    ns.turn = opp(color);
    return ns;
  }

  function pushPawn(moves, from, to, promoRank, flag) {
    if (rankOf(to) === promoRank) {
      for (const pt of ['q', 'r', 'b', 'n']) moves.push({ from, to, flag: 'promo', promo: pt });
    } else {
      moves.push(flag ? { from, to, flag } : { from, to });
    }
  }

  // Pseudo-legal generation (does not test self-check)
  function pseudoMoves(state) {
    const { board, turn, castling, ep } = state;
    const moves = [];
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (!p || p.c !== turn) continue;
      const f = fileOf(s), r = rankOf(s);

      if (p.t === 'p') {
        const dir = turn === 'w' ? 1 : -1;
        const startRank = turn === 'w' ? 1 : 6;
        const promoRank = turn === 'w' ? 7 : 0;
        const r1 = r + dir;
        if (r1 >= 0 && r1 < 8 && !board[sq(f, r1)]) {
          pushPawn(moves, s, sq(f, r1), promoRank, null);
          const r2 = r + 2 * dir;
          if (r === startRank && !board[sq(f, r2)]) moves.push({ from: s, to: sq(f, r2), flag: 'double' });
        }
        for (const df of [-1, 1]) {
          const ff = f + df, rr = r + dir;
          if (!inb(ff, rr)) continue;
          const ts = sq(ff, rr), tp = board[ts];
          if (tp && tp.c !== turn) pushPawn(moves, s, ts, promoRank, null);
          else if (ep !== null && ts === ep) moves.push({ from: s, to: ts, flag: 'ep' });
        }
      } else if (p.t === 'n') {
        for (const [df, dr] of KNIGHT_D) {
          const ff = f + df, rr = r + dr;
          if (!inb(ff, rr)) continue;
          const tp = board[sq(ff, rr)];
          if (!tp || tp.c !== turn) moves.push({ from: s, to: sq(ff, rr) });
        }
      } else if (p.t === 'k') {
        for (const [df, dr] of KING_D) {
          const ff = f + df, rr = r + dr;
          if (!inb(ff, rr)) continue;
          const tp = board[sq(ff, rr)];
          if (!tp || tp.c !== turn) moves.push({ from: s, to: sq(ff, rr) });
        }
        // castling
        const home = turn === 'w' ? 0 : 7;
        if (r === home && f === 4 && !isAttacked(board, s, opp(turn))) {
          const kSide = turn === 'w' ? castling.wK : castling.bK;
          const qSide = turn === 'w' ? castling.wQ : castling.bQ;
          if (kSide && !board[sq(5, home)] && !board[sq(6, home)] &&
              board[sq(7, home)] && board[sq(7, home)].t === 'r' &&
              !isAttacked(board, sq(5, home), opp(turn)) &&
              !isAttacked(board, sq(6, home), opp(turn))) {
            moves.push({ from: s, to: sq(6, home), flag: 'castleK' });
          }
          if (qSide && !board[sq(1, home)] && !board[sq(2, home)] && !board[sq(3, home)] &&
              board[sq(0, home)] && board[sq(0, home)].t === 'r' &&
              !isAttacked(board, sq(3, home), opp(turn)) &&
              !isAttacked(board, sq(2, home), opp(turn))) {
            moves.push({ from: s, to: sq(2, home), flag: 'castleQ' });
          }
        }
      } else {
        const dirs = p.t === 'b' ? DIAG : p.t === 'r' ? ORTH : DIAG.concat(ORTH);
        for (const [df, dr] of dirs) {
          let ff = f + df, rr = r + dr;
          while (inb(ff, rr)) {
            const tp = board[sq(ff, rr)];
            if (!tp) moves.push({ from: s, to: sq(ff, rr) });
            else { if (tp.c !== turn) moves.push({ from: s, to: sq(ff, rr) }); break; }
            ff += df; rr += dr;
          }
        }
      }
    }
    return moves;
  }

  function legalMoves(state) {
    const turn = state.turn;
    return pseudoMoves(state).filter((m) => {
      const ns = applyMove(state, m);
      return !isAttacked(ns.board, kingSquare(ns.board, turn), opp(turn));
    });
  }

  function legalFrom(state, from) {
    return legalMoves(state).filter((m) => m.from === from);
  }

  // status: 'normal' | 'check' | 'checkmate' | 'stalemate'
  function status(state) {
    const legal = legalMoves(state);
    const checked = inCheck(state, state.turn);
    if (legal.length === 0) return checked ? 'checkmate' : 'stalemate';
    return checked ? 'check' : 'normal';
  }

  // Minimal but disambiguated SAN
  function toSAN(state, m) {
    if (m.flag === 'castleK') return decorate('O-O');
    if (m.flag === 'castleQ') return decorate('O-O-O');
    const p = state.board[m.from];
    const dest = algebraic(m.to);
    const capture = !!state.board[m.to] || m.flag === 'ep';
    let s;
    if (p.t === 'p') {
      s = capture ? FILES[fileOf(m.from)] + 'x' + dest : dest;
      if (m.flag === 'promo') s += '=' + m.promo.toUpperCase();
    } else {
      const L = p.t.toUpperCase();
      // disambiguation
      const others = legalMoves(state).filter((x) =>
        x.to === m.to && x.from !== m.from && state.board[x.from] && state.board[x.from].t === p.t);
      let dis = '';
      if (others.length) {
        const sameFile = others.some((x) => fileOf(x.from) === fileOf(m.from));
        const sameRank = others.some((x) => rankOf(x.from) === rankOf(m.from));
        if (!sameFile) dis = FILES[fileOf(m.from)];
        else if (!sameRank) dis = String(rankOf(m.from) + 1);
        else dis = algebraic(m.from);
      }
      s = L + dis + (capture ? 'x' : '') + dest;
    }
    function decorate(base) {
      const ns = applyMove(state, m);
      const st = status(ns);
      if (st === 'checkmate') return base + '#';
      if (st === 'check' || inCheck(ns, ns.turn)) return base + '+';
      return base;
    }
    return decorate(s);
  }

  // perft for self-verification
  function perft(state, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of legalMoves(state)) n += perft(applyMove(state, m), depth - 1);
    return n;
  }

  global.Chess = {
    initialState, cloneState, applyMove, legalMoves, legalFrom, status,
    inCheck, isAttacked, kingSquare, toSAN, perft,
    sq, fileOf, rankOf, algebraic, opp, FILES
  };
})(typeof window !== 'undefined' ? window : self);
