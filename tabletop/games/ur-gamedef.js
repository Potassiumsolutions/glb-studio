/* The Royal Game of Ur (Finkel reconstruction) — the flagship race game on the BGC race loop.
   A 20-square board in three rows: each player owns a private 4-square entry strip and a private
   2-square exit strip on their own row, and both share the 8-square middle lane (the contested
   battlefield — land on an opponent there and it goes back to the yard). 7 pieces per side; roll
   four binary "pyramid" dice (0..4, triangular distribution); rosette squares (🌸) grant an extra
   roll and the central rosette is SAFE from capture; you must reach the end by EXACT count to bear
   a piece off. First to bear off all 7 wins. Rules live in race-core.js; this file is pure data +
   the presentation hooks the host reads. Depends on window.RaceCore. */
(function (root) {
  'use strict';
  const RC = root.RaceCore;
  const PER = 7;

  // ---- board grid: 3 rows (0 top / 1 middle-shared / 2 bottom), 8 cols; cols 4,5 exist only mid-row ----
  const present = (r,c)=> (r===1) || (c<4 || c>5);          // top/bottom rows skip the two bridge cols
  const COLW = 1.16, ROWH = 1.16;
  const xOf = (c)=> (c-3.5)*COLW, zOf = (r)=> (r-1)*ROWH;   // middle row on z=0, centred in x

  const nodes = [];
  const cell = {};                                         // "r,c" -> node id
  for (let r=0;r<3;r++) for (let c=0;c<8;c++){ if(!present(r,c)) continue;
    const id = nodes.length; cell[r+','+c] = id;
    nodes.push({ id, x:xOf(c), z:zOf(r), kind:'ring', idx:id, row:r, col:c }); }
  const nid = (r,c)=> cell[r+','+c];

  // ---- yards (unentered) + winner's parks (finished), 7 spots each, above/below the board ----
  function park(z, kind, side){ const ids=[];
    for (let k=0;k<PER;k++){ const id=nodes.length;
      nodes.push({ id, x:(k-(PER-1)/2)*0.62, z, kind, side }); ids.push(id); }
    return ids; }
  const home = { w: park(-2.75,'home','w'), b: park( 2.75,'home','b') };
  const done = { w: park(-3.75,'done','w'), b: park( 3.75,'done','b') };

  // ---- each side's 14-square route: private entry (4) → shared middle (8) → private exit (2) ----
  const route = (r)=> [
    nid(r,3), nid(r,2), nid(r,1), nid(r,0),                 // entry strip, running toward the far edge
    nid(1,0), nid(1,1), nid(1,2), nid(1,3), nid(1,4), nid(1,5), nid(1,6), nid(1,7),   // SHARED middle lane
    nid(r,7), nid(r,6)                                      // exit strip
  ];
  const routes = { w: route(0), b: route(2) };              // w = top row, b = bottom row

  // ---- rosettes 🌸 (extra roll): four private + the central shared one; central is the only capture-safe square ----
  const ROSETTES = [ nid(0,0), nid(2,0), nid(1,3), nid(0,6), nid(2,6) ];
  const track = {
    sides:['w','b'], perSide:PER, routes, home, done,
    rosette:new Set(ROSETTES),
    safe:   new Set([ nid(1,3) ]),                          // central rosette shields whoever stands on it
    exact:  true,                                           // must bear off by exact roll
    blockOwn:true, plyCap:4000
  };

  const SIDE_NAME = { w:'Ivory', b:'Lapis' };
  const SIDE_COL  = { w:0xEAD9B0, b:0x2f6bb0 };

  function pieceAt(state, node){
    for (const s of track.sides) for (let i=0;i<PER;i++)
      if (RC.nodeOfStep(track, s, i, state.pos[s][i]) === node) return { side:s, piece:i };
    return null;
  }

  const def = {
    id:'ur', name:'Royal Game of Ur', icon:'𒀭', mode:'race',
    board:{ layout:'track', nodes,
      theme:{ style:'grid', sideColors:SIDE_COL,
              ground:0x0c0f16, board:0x14202f, boardRim:0x0a3a5a,
              track:0xE7D8AE, trackAlt:0xCFA85F, rosette:0x3d7bbf, rail:0x0a3a5a } },
    track,
    dice:{ kind:'ur' },
    sides:['w','b'],
    roles:[
      { key:'wr', side:'w', role:'runner', name:'Ivory', count:PER, motionCategory:'locomotion' },
      { key:'br', side:'b', role:'runner', name:'Lapis', count:PER, motionCategory:'locomotion' }
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
    travelStyleFor:()=> 'walk',
    roleAt:        (s,node)=>{ const p=pieceAt(s,node); return p ? (p.side==='w'?'wr':'br') : null; },
    pieceAt,
    homeNodeFor:   (side,piece)=> track.home[side][piece],
    raceBest:      (s, moves, level)=> RC.bestMove(track, s, moves, level),
    eval:          ()=> 0,
    sideNameOf:    (s)=> SIDE_NAME[s] || s
  };

  root.BGC_GAMES = root.BGC_GAMES || {};
  root.BGC_GAMES.ur = def;
  if (typeof module!=='undefined' && module.exports) module.exports = { ur:def };
})(typeof self!=='undefined' ? self : this);
