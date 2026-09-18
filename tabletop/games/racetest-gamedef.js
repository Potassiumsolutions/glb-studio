/* Race-mode TEST game — "Derby Loop". A minimal proof of the roll-and-advance loop (plan §5):
   an oval RACECOURSE ring both colours run around (same direction, opposite starts) so the whole
   ring is a contested lane — landing on an opponent sends it back to the paddock. Roll a d6, advance
   ONE piece; rosettes grant an extra roll; a colour's start square is safe. First colour to run all
   3 of its runners a full lap home wins. This is the engine test-bed, not a shipping game — it wires
   every race feature (dice, entering from the yard, capture/send-home, extra-roll, finishing) so the
   real race games (Royal Game of Ur / Ludo / horse race) drop onto the same host loop. Depends on
   window.RaceCore. */
(function (root) {
  'use strict';
  const RC = root.RaceCore;

  const RING = 20, PER = 3;
  const START = { w:0, b:10 };                 // opposite points of the ring
  const A = 5.4, Bz = 3.9;                     // ellipse radii (world units)

  // ---- build the board node graph: ring ids 0..RING-1, then yards + done parks per side ----
  const nodes = [];
  for (let i=0;i<RING;i++){ const ang = -Math.PI/2 + (i/RING)*2*Math.PI;   // start at "top", clockwise
    nodes.push({ id:i, x:Math.cos(ang)*A, z:Math.sin(ang)*Bz, kind:'ring', idx:i }); }
  const ringXZ = (i)=> nodes[i];
  function park(baseAng, r, n, kind, side){ const ids=[];
    for (let k=0;k<n;k++){ const a = baseAng + (k-(n-1)/2)*0.34;
      ids.push(nodes.length); nodes.push({ id:nodes.length, x:Math.cos(a)*r, z:Math.sin(a)*r, kind, side }); }
    return ids; }
  // yards sit OUTSIDE the ring by each start; done parks sit just INSIDE
  const angOf = (i)=> -Math.PI/2 + (i/RING)*2*Math.PI;
  const home = { w: park(angOf(START.w), 7.6, PER, 'home', 'w'), b: park(angOf(START.b), 7.6, PER, 'home', 'b') };
  const done = { w: park(angOf(START.w), 2.2, PER, 'done', 'w'), b: park(angOf(START.b), 2.2, PER, 'done', 'b') };

  const routeOf = (side)=>{ const r=[]; for (let k=0;k<RING;k++) r.push((START[side]+k)%RING); return r; };
  const routes = { w: routeOf('w'), b: routeOf('b') };

  const track = {
    sides:['w','b'], perSide:PER, routes, home, done,
    safe:   new Set([START.w % RING, START.b % RING]),   // your own start square is safe
    rosette:new Set([5, 15]),                            // two extra-roll squares
    exact:  false,                                       // overshoot finishes (keeps the loop lively)
    blockOwn:true, plyCap:2000
  };

  const SIDE_NAME = { w:'Red', b:'Blue' };
  const SIDE_COL  = { w:0xd8503a, b:0x4a90d6 };

  // find the (side,piece) sitting on a node id (≤1 at rest) — for click-to-move + occupancy
  function pieceAt(state, node){
    for (const s of track.sides) for (let i=0;i<PER;i++)
      if (RC.nodeOfStep(track, s, i, state.pos[s][i]) === node) return { side:s, piece:i };
    return null;
  }

  const def = {
    id:'derbyloop', name:'Derby Loop (race test)', icon:'🏁', mode:'race',
    board:{ layout:'track', ring:RING, nodes, theme:{ sideColors:SIDE_COL, ground:0x14301a, track:0xC9A24B, rail:0x5b3d22, infield:0x2f6f3a } },
    track,
    dice:{ kind:'d6' },
    sides:['w','b'],
    roles:[
      { key:'wr', side:'w', role:'runner', name:'Red',  count:PER, motionCategory:'locomotion' },
      { key:'br', side:'b', role:'runner', name:'Blue', count:PER, motionCategory:'locomotion' }
    ],
    setup:      ()=> RC.initialState(track),
    turnOf:     (s)=> s.turn,
    opp:        (s)=> s==='w'?'b':'w',
    activeSides:(s)=> s.seats || track.sides,
    raceMoves:  (s, total)=> RC.movesForRoll(track, s, s.turn, total),
    applyMove:  (s, m)=> RC.applyMove(track, s, m),
    status:     (s)=> RC.status(track, s),
    // presentation hooks
    pathOf:        (m)=> m.path,
    capturedNodes: (s,m)=> (m && m.capture!=null) ? [m.capture] : [],
    promoOf:       ()=> null,
    extraMovers:   ()=> [],
    travelStyleFor:()=> 'gallop',
    roleAt:        (s,node)=>{ const p=pieceAt(s,node); return p ? (p.side==='w'?'wr':'br') : null; },
    pieceAt,
    homeNodeFor:   (side,piece)=> track.home[side][piece],
    // race AI is greedy over the rolled moves (host calls this after rolling)
    raceBest:      (s, moves, level)=> RC.bestMove(track, s, moves, level),
    eval:          ()=> 0,
    sideNameOf:    (s)=> SIDE_NAME[s] || s
  };

  root.BGC_GAMES = root.BGC_GAMES || {};
  root.BGC_GAMES.derbyloop = def;
  if (typeof module!=='undefined' && module.exports) module.exports = { derbyloop:def };
})(typeof self!=='undefined' ? self : this);
