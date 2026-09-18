/* Checkers / Draughts rules engine — American (English) rules:
   - 8x8, pieces on dark squares (file+rank odd), 12 per side. White (w) starts ranks 0-2 moving +rank; Black (b) 5-7 moving -rank.
   - Men move/capture diagonally FORWARD one; Kings move/capture any diagonal one (non-flying).
   - Captures are MANDATORY; multi-jumps chain and are mandatory; a man that reaches the king row (mid-jump too) is crowned and stops.
   - Loss = no pieces or no legal move on your turn. Draw = 40 plies with no capture and no man advance.
   Dual-context (window + web worker). Mirrors the chess-engine.js API shape the app expects. */
(function(root){
  const FILES = ['a','b','c','d','e','f','g','h'];
  const sq  = (f,r)=> r*8+f;
  const fileOf = s=> s%8, rankOf = s=> (s/8)|0;
  const inb = (f,r)=> f>=0&&f<8&&r>=0&&r<8;
  const dark = (f,r)=> ((f+r)&1)===1;                     // playable squares
  const opp = c=> c==='w'?'b':'w';
  const MAN_DIRS = { w:[[1,1],[-1,1]], b:[[1,-1],[-1,-1]] };
  const KING_DIRS = [[1,1],[-1,1],[1,-1],[-1,-1]];
  const algebraic = s=> FILES[fileOf(s)] + (rankOf(s)+1);

  function initialState(){
    const board = new Array(64).fill(null);
    for(let r=0;r<8;r++) for(let f=0;f<8;f++){ if(!dark(f,r)) continue;
      if(r<=2) board[sq(f,r)] = {c:'w',k:false};
      else if(r>=5) board[sq(f,r)] = {c:'b',k:false};
    }
    return { board, turn:'w', idle:0 };                   // idle = plies since last capture/man-advance (draw counter)
  }

  const dirsFor = p => p.k ? KING_DIRS : MAN_DIRS[p.c];
  const willCrown = (p,r)=> !p.k && ((p.c==='w'&&r===7)||(p.c==='b'&&r===0));

  // All jump sequences for the piece at `from`. Board is the live array; we lift the mover so a chain can pass its origin.
  function jumpsFrom(board, from, piece, captured){
    const out=[]; const f0=fileOf(from), r0=rankOf(from);
    for(const [df,dr] of dirsFor(piece)){
      const mf=f0+df, mr=r0+dr, lf=f0+2*df, lr=r0+2*dr;
      if(!inb(lf,lr)) continue;
      const mid=sq(mf,mr), land=sq(lf,lr), midP=board[mid];
      if(!midP || midP.c===piece.c || captured.has(mid)) continue;   // must jump an un-captured opponent
      if(board[land]) continue;                                       // landing must be empty (captured pieces still block)
      const crown = willCrown(piece, lr);
      if(crown){ out.push({path:[from,land], captures:[mid], promo:true}); continue; }  // crowning ends the move
      const next = jumpsFrom(board, land, piece, new Set([...captured, mid]));
      if(next.length){ for(const n of next) out.push({path:[from,...n.path], captures:[mid,...n.captures], promo:n.promo}); }
      else out.push({path:[from,land], captures:[mid], promo:false});
    }
    return out;
  }

  function simpleMovesFrom(board, from, piece){
    const out=[]; const f0=fileOf(from), r0=rankOf(from);
    for(const [df,dr] of dirsFor(piece)){
      const f=f0+df, r=r0+dr; if(!inb(f,r)) continue; const to=sq(f,r);
      if(board[to]) continue;
      out.push({ from, to, path:[from,to], captures:[], promo:willCrown(piece,r) });
    }
    return out;
  }

  function legalMoves(state){
    const { board, turn } = state;
    const jumps=[], quiet=[];
    // lift-and-scan: for jumps we lift the mover so the DFS can traverse its own origin square
    for(let s=0;s<64;s++){ const p=board[s]; if(!p||p.c!==turn) continue;
      const lifted = board.slice(); lifted[s]=null;
      const js = jumpsFrom(lifted, s, p, new Set());
      for(const j of js) jumps.push({ from:j.path[0], to:j.path[j.path.length-1], path:j.path, captures:j.captures, promo:j.promo });
    }
    if(jumps.length) return jumps;                          // captures are MANDATORY
    for(let s=0;s<64;s++){ const p=board[s]; if(!p||p.c!==turn) continue; quiet.push(...simpleMovesFrom(board,s,p)); }
    return quiet;
  }
  const legalFrom = (state, from)=> legalMoves(state).filter(m=>m.from===from);

  function applyMove(state, m){
    const board = state.board.slice();
    const p = { ...board[m.from] };
    board[m.from] = null;
    for(const c of m.captures) board[c] = null;
    if(m.promo) p.k = true;
    board[m.to] = p;
    const progressed = m.captures.length>0 || !state.board[m.from].k;   // a man moved, or a capture happened
    return { board, turn: opp(state.turn), idle: progressed ? 0 : state.idle+1 };
  }

  function status(state){
    const has = legalMoves(state).length>0;
    if(!has) return { turn:state.turn, over:true, winner:opp(state.turn), draw:false, reason:'no moves' };
    if(state.idle>=80) return { turn:state.turn, over:true, draw:true, reason:'40-move rule' };  // 80 plies
    return { turn:state.turn, over:false };
  }

  const count = (state,c)=> state.board.reduce((n,p)=> n + (p&&p.c===c?1:0), 0);

  const API = { FILES, sq, fileOf, rankOf, algebraic, dark, opp, initialState, legalMoves, legalFrom, applyMove, status, count };
  if(typeof module!=='undefined' && module.exports) module.exports = API;
  root.Checkers = API;
})(typeof self!=='undefined' ? self : this);
