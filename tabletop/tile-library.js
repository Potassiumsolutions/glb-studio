/* ==========================================================================
   Board Tile Engine — tile library (declarative prototypes, designer-editable).
   A tile = { id, biome, transition?, feature?, edges:[{path,biome} ...] }.
   SQUARE edges are ordered N,E,S,W; HEX edges E,NE,NW,W,SW,SE.
   Depends on window.TileEngine (tile-engine.js) for PATH / BIOME constants.
   ========================================================================== */
(function (root) {
  'use strict';
  const TE = root.TileEngine;
  const P = TE.PATH, B = TE.BIOME;

  // edge helper: e(path) uses the tile biome; e(path, biome) overrides (for transitions)
  const mk = (id, biome, paths, opts) => {
    opts = opts || {};
    const edges = paths.map(p => Array.isArray(p) ? { path:p[0], biome:p[1] } : { path:p, biome:biome });
    return Object.assign({ id, biome, edges }, opts);
  };

  /* ---------------- SQUARE tiles (edges N,E,S,W) ---------------- */
  const N=P.NONE, RD=P.ROAD, TR=P.TRAIL, RV=P.RIVER, WL=P.WALL;
  const square = {};
  const addS = (t)=> square[t.id]=t;
  // plains
  addS(mk('plains',           B.PLAINS, [N,N,N,N], {feature:'tufts'}));
  addS(mk('plains_road_I',    B.PLAINS, [RD,N,RD,N], {feature:'tufts'}));
  addS(mk('plains_road_L',    B.PLAINS, [RD,RD,N,N], {feature:'tufts'}));
  addS(mk('plains_road_T',    B.PLAINS, [RD,RD,RD,N], {feature:'tufts'}));
  addS(mk('plains_road_X',    B.PLAINS, [RD,RD,RD,RD], {feature:'tufts'}));
  addS(mk('plains_road_end',  B.PLAINS, [RD,N,N,N], {feature:'farm'}));       // road ends at a farmhouse
  addS(mk('plains_trail_I',   B.PLAINS, [TR,N,TR,N], {feature:'tufts'}));
  addS(mk('plains_trail_L',   B.PLAINS, [TR,TR,N,N], {feature:'tufts'}));
  addS(mk('plains_trail_T',   B.PLAINS, [TR,TR,TR,N], {feature:'tufts'}));
  addS(mk('plains_road_trail',B.PLAINS, [RD,TR,N,N], {feature:'tufts'}));     // road turns to trail inside the tile
  // village (sits on roads)
  addS(mk('village',          B.VILLAGE,[N,N,N,N], {feature:'houses'}));
  addS(mk('village_road_I',   B.VILLAGE,[RD,N,RD,N], {feature:'houses'}));
  addS(mk('village_road_X',   B.VILLAGE,[RD,RD,RD,RD], {feature:'houses'}));
  addS(mk('village_trail_I',  B.VILLAGE,[TR,N,TR,N], {feature:'houses'}));
  // town-ground bases (blank colored ground — build a town with the 🌲 Props tool)
  addS(mk('town_plaza',       B.PLAZA,  [N,N,N,N]));
  addS(mk('town_dirt',        B.DIRT,   [N,N,N,N]));
  addS(mk('town_green',       B.GREEN,  [N,N,N,N]));
  addS(mk('town_plaza_road',  B.PLAZA,  [RD,N,RD,N]));
  addS(mk('town_dirt_road',   B.DIRT,   [RD,N,RD,N]));
  // city + walls + castle
  addS(mk('city_wall_I',      B.CITY,   [WL,N,WL,N], {feature:'buildings'}));  // wall runs through N–S
  addS(mk('city_wall_L',      B.CITY,   [WL,WL,N,N], {feature:'buildings'}));  // wall corner
  addS(mk('city_gate',        B.CITY,   [WL,WL,RD,WL], {feature:'buildings'}));// walls on 3 sides, gate (road) to the S
  addS(mk('castle',           B.CITY,   [N,N,RD,N], {feature:'keep', transition:true}));// keep ringed by wall, gate S, sits in a field
  // forest
  addS(mk('forest',           B.FOREST, [N,N,N,N], {feature:'trees'}));
  addS(mk('forest_trail_I',   B.FOREST, [TR,N,TR,N], {feature:'trees'}));
  addS(mk('forest_trail_L',   B.FOREST, [TR,TR,N,N], {feature:'trees'}));
  // mountains
  addS(mk('mountains',        B.MOUNTAINS,[N,N,N,N], {feature:'peaks'}));
  addS(mk('mtn_pass_I',       B.MOUNTAINS,[TR,N,TR,N], {feature:'peaks'}));    // a trail pass through the range
  // snow
  addS(mk('snow',             B.SNOW,   [N,N,N,N]));
  addS(mk('snow_road_I',      B.SNOW,   [RD,N,RD,N]));
  addS(mk('snow_trail_I',     B.SNOW,   [TR,N,TR,N]));
  addS(mk('snow_road_L',      B.SNOW,   [RD,RD,N,N]));
  // rocks
  addS(mk('rocks',            B.ROCKS,  [N,N,N,N]));
  addS(mk('rocks_trail_I',    B.ROCKS,  [TR,N,TR,N]));
  addS(mk('rocks_road_I',     B.ROCKS,  [RD,N,RD,N]));
  // water / rivers / bridge
  addS(mk('water',            B.WATER,  [N,N,N,N], {feature:'water'}));
  addS(mk('river_I',          B.PLAINS, [RV,N,RV,N], {feature:'tufts'}));
  addS(mk('river_L',          B.PLAINS, [RV,RV,N,N], {feature:'tufts'}));
  addS(mk('bridge',           B.PLAINS, [RV,RD,RV,RD], {feature:'bridge'}));   // road bridges the river
  // transitions (biome bridges — a themed strip on the N edge, host biome elsewhere)
  addS(mk('trans_city_plains',  B.PLAINS, [[N,B.CITY],     N,N,N], {feature:'citywall', transition:true}));
  addS(mk('trans_forest_plains',B.PLAINS, [[N,B.FOREST],   N,N,N], {feature:'treeline', transition:true}));
  addS(mk('trans_mtn_plains',   B.PLAINS, [[N,B.MOUNTAINS],N,N,N], {feature:'foothills', transition:true}));
  addS(mk('trans_water_plains', B.PLAINS, [[N,B.WATER],    N,N,N], {feature:'shore', transition:true}));

  /* ---------------- HEX tiles (edges E,NE,NW,W,SW,SE) ---------------- */
  const hex = {};
  const addH = (t)=> hex[t.id]=t;
  const h6 = (a)=>a;   // readability
  // plains + roads (edges E,NE,NW,W,SW,SE)
  addH(mk('plains',          B.PLAINS,   h6([N,N,N,N,N,N]), {feature:'tufts'}));
  addH(mk('plains_road_I',   B.PLAINS,   h6([RD,N,N,RD,N,N]), {feature:'tufts'}));   // E–W straight
  addH(mk('plains_road_C',   B.PLAINS,   h6([RD,RD,N,N,N,N]), {feature:'tufts'}));   // E–NE curve
  addH(mk('plains_road_T',   B.PLAINS,   h6([RD,N,N,RD,N,RD]), {feature:'tufts'}));  // straight + a branch (SE)
  addH(mk('plains_road_Y',   B.PLAINS,   h6([RD,N,RD,N,RD,N]), {feature:'tufts'}));  // 3-way
  addH(mk('plains_road_star',B.PLAINS,   h6([RD,RD,RD,RD,RD,RD]), {feature:'tufts'}));// 6-way hub
  addH(mk('plains_road_end', B.PLAINS,   h6([RD,N,N,N,N,N]), {feature:'farm'}));     // road ends at a farm
  // trails
  addH(mk('plains_trail_I',  B.PLAINS,   h6([TR,N,N,TR,N,N]), {feature:'tufts'}));
  addH(mk('plains_trail_C',  B.PLAINS,   h6([TR,TR,N,N,N,N]), {feature:'tufts'}));
  addH(mk('plains_trail_Y',  B.PLAINS,   h6([TR,N,TR,N,TR,N]), {feature:'tufts'}));
  addH(mk('plains_road_trail',B.PLAINS,  h6([RD,N,N,TR,N,N]), {feature:'tufts'}));   // road turns to trail inside
  // village
  addH(mk('village',         B.VILLAGE,  h6([N,N,N,N,N,N]), {feature:'houses'}));
  addH(mk('village_road_I',  B.VILLAGE,  h6([RD,N,N,RD,N,N]), {feature:'houses'}));
  addH(mk('village_road_Y',  B.VILLAGE,  h6([RD,N,RD,N,RD,N]), {feature:'houses'}));
  addH(mk('village_trail_I', B.VILLAGE,  h6([TR,N,N,TR,N,N]), {feature:'houses'}));
  // forest
  addH(mk('forest',          B.FOREST,   h6([N,N,N,N,N,N]), {feature:'trees'}));
  addH(mk('forest_trail_I',  B.FOREST,   h6([TR,N,N,TR,N,N]), {feature:'trees'}));
  addH(mk('forest_trail_C',  B.FOREST,   h6([TR,TR,N,N,N,N]), {feature:'trees'}));
  // mountains
  addH(mk('mountains',       B.MOUNTAINS,h6([N,N,N,N,N,N]), {feature:'peaks'}));
  addH(mk('mtn_pass_I',      B.MOUNTAINS,h6([TR,N,N,TR,N,N]), {feature:'peaks'}));
  addH(mk('mtn_pass_C',      B.MOUNTAINS,h6([TR,TR,N,N,N,N]), {feature:'peaks'}));
  // snow
  addH(mk('snow',            B.SNOW,    h6([N,N,N,N,N,N])));
  addH(mk('snow_road_I',     B.SNOW,    h6([RD,N,N,RD,N,N])));
  addH(mk('snow_trail_I',    B.SNOW,    h6([TR,N,N,TR,N,N])));
  addH(mk('snow_road_C',     B.SNOW,    h6([RD,RD,N,N,N,N])));
  // rocks
  addH(mk('rocks',           B.ROCKS,   h6([N,N,N,N,N,N])));
  addH(mk('rocks_trail_I',   B.ROCKS,   h6([TR,N,N,TR,N,N])));
  addH(mk('rocks_road_I',    B.ROCKS,   h6([RD,N,N,RD,N,N])));
  // town-ground bases (blank colored ground — build a town with the 🌲 Props tool)
  addH(mk('town_plaza',      B.PLAZA,    h6([N,N,N,N,N,N])));
  addH(mk('town_dirt',       B.DIRT,     h6([N,N,N,N,N,N])));
  addH(mk('town_green',      B.GREEN,    h6([N,N,N,N,N,N])));
  addH(mk('town_plaza_road', B.PLAZA,    h6([RD,N,N,RD,N,N])));
  addH(mk('town_dirt_road',  B.DIRT,     h6([RD,N,N,RD,N,N])));
  // city + walls + gate + castle
  addH(mk('city_wall_I',     B.CITY,     h6([WL,N,N,WL,N,N]), {feature:'buildings'}));
  addH(mk('city_wall_C',     B.CITY,     h6([WL,WL,N,N,N,N]), {feature:'buildings'}));
  addH(mk('city_gate',       B.CITY,     h6([RD,WL,WL,N,WL,WL]), {feature:'buildings'}));// walls around, road gate to E
  addH(mk('castle',          B.CITY,     h6([RD,N,N,N,N,N]), {feature:'keep', transition:true}));
  // water / rivers / bridge
  addH(mk('water',           B.WATER,    h6([N,N,N,N,N,N]), {feature:'water'}));
  addH(mk('river_I',         B.PLAINS,   h6([RV,N,N,RV,N,N]), {feature:'tufts'}));
  addH(mk('river_C',         B.PLAINS,   h6([RV,RV,N,N,N,N]), {feature:'tufts'}));
  addH(mk('bridge',          B.PLAINS,   h6([RV,RD,N,RV,RD,N]), {feature:'bridge'}));   // road bridges the river
  // transitions (biome bridge on the E edge)
  addH(mk('trans_forest_plains', B.PLAINS, h6([[N,B.FOREST],   N,N,N,N,N]), {feature:'treeline',  transition:true}));
  addH(mk('trans_city_plains',   B.PLAINS, h6([[N,B.CITY],     N,N,N,N,N]), {feature:'citywall',  transition:true}));
  addH(mk('trans_mtn_plains',    B.PLAINS, h6([[N,B.MOUNTAINS],N,N,N,N,N]), {feature:'foothills', transition:true}));
  addH(mk('trans_water_plains',  B.PLAINS, h6([[N,B.WATER],    N,N,N,N,N]), {feature:'shore',     transition:true}));

  root.TileLibrary = { square, hex };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TileLibrary;
})(typeof self !== 'undefined' ? self : this);
