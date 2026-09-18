/* Sternhalma (Chinese Checkers) rules engine — the classic 121-hole hexagram, now 2–6 players.
   The six triangular POINTS of the star are the six home bases; each player starts in one point and
   races to fill the OPPOSITE point. Standard seatings: 2 = opposite pair, 3 = alternating, 4 = two
   opposite pairs, 6 = all six. A move is one step to an adjacent empty hole OR a chain of jumps over
   adjacent occupied holes (any colour) to the empty hole beyond — jumps do NOT capture.
   Sides are the point indices as 'p0'..'p5' so a player keeps its home colour whatever the count.
   Dual-context (window + worker + node). The board GEOMETRY (node x/z + point index) is exposed so the
   presentation host renders the star + colours each base. */
(function (root) {
  'use strict';
  const S3 = Math.sqrt(3) / 2;
  const ROWCOUNTS = [1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1];
  const NODES = [];
  const byRC = {};
  (function build(){
    let id = 0;
    for (let r=0; r<17; r++){ const n = ROWCOUNTS[r];
      for (let k=0; k<n; k++){ const col = -(n-1) + 2*k;
        const nd = { id:id++, row:r, col, x:col*0.5, z:r*S3 };
        NODES.push(nd); byRC[r+','+col] = nd; } }
    const meanZ = 8*S3; NODES.forEach(nd => nd.z -= meanZ);
    const DIRS = [[2,0],[-2,0],[1,1],[-1,1],[1,-1],[-1,-1]];
    NODES.forEach(nd => { nd.adj = []; nd.jump = {};
      for (const [dc,dr] of DIRS){ const nb = byRC[(nd.row+dr)+','+(nd.col+dc)];
        if (nb){ nd.adj.push(nb.id);
          const land = byRC[(nd.row+2*dr)+','+(nd.col+2*dc)];
          if (land) nd.jump[nb.id] = land.id; } } });
  })();
  const N = NODES.length;                       // 121

  // ---- the six star POINTS (home bases) — nodes beyond the central hexagon, grouped by tip direction ----
  const TIP = [];                               // 6 tip directions, angle from +X toward +Z
  for (let i=0;i<6;i++) TIP.push((30 + 60*i) * Math.PI/180);   // 30,90,…,330°
  const angDiff = (a,b)=>{ let d=Math.abs(a-b)%(2*Math.PI); return d>Math.PI?2*Math.PI-d:d; };
  const POINTS = [[],[],[],[],[],[]];
  NODES.forEach(nd=>{
    const rho = Math.hypot(nd.x, nd.z);
    if (rho > 4.2){                             // central hexagon is rho<=4 (node units); beyond = a point
      const th = Math.atan2(nd.z, nd.x);
      let best=0, bd=1e9; for (let i=0;i<6;i++){ const d=angDiff(th, TIP[i]); if(d<bd){bd=d; best=i;} }
      POINTS[best].push(nd.id); nd.point = best;
    } else nd.point = -1;
  });
  const OPP_POINT = i => (i+3)%6;               // the point directly across the star
  // player seatings by count → which point indices are occupied
  const SEATS = { 1:[4], 2:[4,1], 3:[4,0,2], 4:[4,1,0,3], 6:[0,1,2,3,4,5] };
  const sideOfPoint = i => 'p'+i;
  const pointOfSide = s => +s.slice(1);

  function initialState(numPlayers){
    numPlayers = SEATS[numPlayers] ? numPlayers : 2;
    const seatPts = SEATS[numPlayers];
    const board = new Array(N).fill(null);
    const seats = seatPts.map(sideOfPoint);
    for (const pi of seatPts) for (const id of POINTS[pi]) board[id] = sideOfPoint(pi);
    return { board, turn: seats[0], seats, np:numPlayers, plies:0 };
  }
  const nextSeat = (state)=>{ const i=state.seats.indexOf(state.turn); return state.seats[(i+1)%state.seats.length]; };

  function stepsFrom(board, from){ const out=[]; for (const a of NODES[from].adj) if (board[a]==null) out.push({from, to:a, path:[from,a]}); return out; }
  function jumpsFrom(board, from){
    const out=[]; const b=board.slice(); b[from]=null; const seen=new Set([from]);
    (function dfs(cur, path){ const node=NODES[cur];
      for (const overId of node.adj){ if (b[overId]==null) continue; const land=node.jump[overId];
        if (land==null || b[land]!=null || seen.has(land)) continue;
        seen.add(land); const np=path.concat(land); out.push({from, to:land, path:np}); dfs(land, np); seen.delete(land); }
    })(from, [from]);
    return out;
  }
  function legalMoves(state){ const {board,turn}=state; const out=[];
    for (let i=0;i<N;i++){ if (board[i]!==turn) continue; out.push(...stepsFrom(board,i)); out.push(...jumpsFrom(board,i)); }
    return out; }
  const legalFrom = (state, from)=> legalMoves(state).filter(m=>m.from===from);

  function applyMove(state, m){ const board=state.board.slice(); const s=board[m.from];
    board[m.from]=null; board[m.to]=s;
    return { board, turn: nextSeat(state), seats:state.seats, np:state.np, plies:state.plies+1 }; }

  function won(board, side){ const tgt = OPP_POINT(pointOfSide(side)); let cnt=0;
    for (let i=0;i<N;i++){ if (board[i]===side){ if (NODES[i].point!==tgt) return false; cnt++; } }
    return cnt>0; }
  function status(state){ const b=state.board;
    for (const s of state.seats){ if (won(b,s)) return { turn:state.turn, over:true, winner:s, draw:false, reason:'home' }; }
    if (state.plies>=600) return { turn:state.turn, over:true, draw:true, reason:'ply cap' };
    if (legalMoves(state).length===0) return { turn:state.turn, over:true, winner:nextSeat(state), draw:false, reason:'no moves' };
    return { turn:state.turn, over:false };
  }

  const centroid = (ids)=>{ let x=0,z=0; ids.forEach(i=>{ x+=NODES[i].x; z+=NODES[i].z; }); return { x:x/ids.length, z:z/ids.length }; };
  const TC = {};                                // target centroid per side
  for (let i=0;i<6;i++) TC['p'+i] = centroid(POINTS[OPP_POINT(i)]);
  function progress(board, side){ const tc=TC[side]; const tgt=OPP_POINT(pointOfSide(side)); let sc=0, worst=0, home=0;
    for (let i=0;i<N;i++){ if (board[i]!==side) continue; const nd=NODES[i];
      const d = Math.hypot(nd.x-tc.x, nd.z-tc.z); sc -= d; if (d>worst) worst=d;
      if (nd.point===tgt) home++; }
    return sc - worst*1.6 + home*6; }
  const evaluate = (state, side)=> progress(state.board, side);
  // Greedy AI (works for ANY player count — negamax is only 2-player zero-sum): advance toward the target,
  // leaning on the worst-lagging piece, preferring longer jumps (progress already rewards distance closed).
  function greedyMove(state, level){
    const moves = legalMoves(state); if (!moves.length) return null;
    if (moves.length===1) return moves[0];
    const side = state.turn; let best=null, bestScore=-1e18;
    const jitter = level==='easy' ? 0.6 : level==='hard' ? 0.02 : 0.15;
    for (const m of moves){ const ns=applyMove(state,m);
      const sc = progress(ns.board, side) + Math.random()*jitter;
      if (sc>bestScore){ bestScore=sc; best=m; } }
    return best;
  }

  const API = { NODES, N, POINTS, TIP, OPP_POINT, SEATS, sideOfPoint, pointOfSide, nextSeat,
    initialState, legalMoves, legalFrom, applyMove, status, evaluate, greedyMove, algebraic:(id)=>'#'+id };
  if (typeof module!=='undefined' && module.exports) module.exports = API;
  root.Sternhalma = API;
})(typeof self!=='undefined' ? self : this);
