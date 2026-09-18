/* Chinese Checkers (Sternhalma) GameDef — 2–6 players on the 121-hex star. The six triangular POINTS
   are the six home BASES, each its own colour; a player races to the OPPOSITE base. It's generic
   Chinese Checkers — you roster whatever characters you like into the colour slots (default piece = a
   coloured marble). The board is built out of hexagon tiles: water hexes carry a lily pad, brier hexes
   carry a rock, and each home base is tinted its player's colour (distinct from the field). Terrain is
   configurable (split / pond / brier / mixed). Player count is a setup option (def.numPlayers).
   Depends on window.Sternhalma. */
(function (root) {
  'use strict';
  const S = root.Sternhalma;
  const BOARD_NODES = S.NODES.map(n => ({ id:n.id, x:n.x, z:n.z, point:n.point }));

  // one colour + name per star point (a player keeps its home colour at any count)
  const POINT_COLORS = [0xd8503a, 0x5fbf6a, 0x4a90d6, 0xe6c250, 0xe08a3c, 0xa96fd0];
  const POINT_NAMES  = ['Red', 'Green', 'Blue', 'Yellow', 'Orange', 'Purple'];

  const theme = {
    pointColors: POINT_COLORS,
    water: { hex:0x2f6f93, pad:0x54b06a, padRim:0x2f7d4a, flower:0xf3d0e6 },
    brier: { hex:0x5c4026, rock:0x969ba4, thorn:0x3e2c19 },
    plain: { hex:0xb8945f, cup:0x6b4a2e },              // Classic Marbles: wood board + dark holes
    frame: 0x6b4a2e, frameTop: 0x8a663c, frameText: 0xf3e6c6,
    ground: 0x0c141a,
    terrainMode: 'split',
    // center designs (chess-style board-design list): lily pads / briers / marbles / split / mixed
    terrainAt: function (node, mode) {
      mode = mode || theme.terrainMode;
      if (mode === 'pond')   return 'water';             // 🐸 Lily Pond (frogs)
      if (mode === 'brier')  return 'brier';             // 🐰 Brier Patch (rabbits)
      if (mode === 'marble') return 'marble';            // ⚫ Classic Marbles (plain holes)
      const nd = BOARD_NODES[node] || {};
      if (mode === 'mixed') { const col = Math.round(nd.x*2), row = Math.round(nd.z/0.8660254); return ((col+row)&2) ? 'water' : 'brier'; }
      return (nd.z <= 0.001) ? 'water' : 'brier';         // split: near half lily pads, far half briers
    }
  };

  const sides = [0,1,2,3,4,5].map(i => 'p'+i);
  const roles = [0,1,2,3,4,5].map(i => ({ key:'p'+i+'m', side:'p'+i, role:'m', name:POINT_NAMES[i], count:10, motionCategory:'move' }));

  const def = {
    id:'frograbbit', name:'Chinese Checkers', icon:'✦', mode:'move',
    numPlayers: 2,                                        // setup option — the host's Players selector changes it
    board:{ layout:'graph', tile:'hex', star:true, nodes:BOARD_NODES, theme, seatFrac:0.52 },
    sides,
    roles,
    setup:      ()=> S.initialState(def.numPlayers),
    turnOf:     (s)=> s.turn,
    opp:        (s)=> S.sideOfPoint((S.pointOfSide(s)+1)%6),   // interface stub; turn advance uses S.nextSeat
    activeSides:(s)=> s.seats,                            // who's actually playing this game
    legalMoves: (s)=> S.legalMoves(s),
    legalFrom:  (s,f)=> S.legalFrom(s,f),
    applyMove:  (s,m)=> S.applyMove(s,m),
    status:     (s)=>{ const st=S.status(s); return { over:!!st.over, winner:st.winner, draw:!!st.draw, turn:s.turn, note:st.reason||'' }; },
    pathOf:        (m)=> (m.path && m.path.length>1) ? m.path : [m.from, m.to],
    capturedNodes: ()=> [],
    promoOf:       ()=> null,
    extraMovers:   ()=> [],
    travelStyleFor:()=> 'hop',
    roleAt:        (s,node)=> s.board[node] ? s.board[node]+'m' : null,
    ai:            (s,level)=> S.greedyMove(s, level),    // greedy works for 2–6 players (negamax is 2-only)
    eval:          (s,side)=> S.evaluate(s, side)
  };

  root.BGC_GAMES = root.BGC_GAMES || {};
  root.BGC_GAMES.frograbbit = def;
  if (typeof module!=='undefined' && module.exports) module.exports = { frograbbit:def };
})(typeof self!=='undefined' ? self : this);
