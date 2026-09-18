/* Generic Board-Game Core AI worker — one worker plays ANY GameDef.
   The main thread posts { gameId, state, level, id }; we run the core's generic
   negamax/alpha-beta (BGC.bestMove) on that game's GameDef and post back the move.
   Keeps the UI responsive during deep chess searches (same pattern as the chess app's
   ai-worker.js, but game-agnostic — the def, not the worker, knows the rules). */
self.window = self;   // some engines guard on window; alias it to the worker global
importScripts(
  'chess-engine.js', 'chess-ai.js',
  'checkers-engine.js', 'checkers-ai.js',
  'sternhalma-engine.js',
  'bgc-core.js',
  'games/chess-gamedef.js', 'games/checkers-gamedef.js', 'games/sternhalma-gamedef.js'
);

self.onmessage = (e)=>{
  const { gameId, state, level, id } = e.data || {};
  try {
    const def = self.BGC_GAMES[gameId];
    if (!def) { self.postMessage({ id, mv:{ error:'unknown game '+gameId } }); return; }
    const mv = self.BGC.bestMove(def, state, { level });
    self.postMessage({ id, mv });
  } catch (err) {
    self.postMessage({ id, mv:{ error: String(err && err.message || err) } });
  }
};
