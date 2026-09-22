/* ==========================================================================
   Board Tile Engine — procedural tile renderer (three.js ES module).
   buildTileMesh(def, gridKind, seed) → THREE.Group in the tile's rot=0 local frame
   (a unit tile: square side 1, hex centre→corner 0.5). The editor world-places the
   group and rotates it by rot·stepAngle. Geometry is built from the SAME corner /
   edge-midpoint data the engine matches on, so paths always meet at the borders.
   Everything is generated (no art assets) and seeded so a tile looks stable.
   ========================================================================== */
import * as THREE from 'three';

const TE = self.TileEngine;
const P = TE.PATH;
const D_H = 0.12;              // tile slab thickness
const TOP = D_H;              // top surface y

function rng32(seed){ let a=(seed>>>0)||1; return ()=>{ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

/* ---- painted terrain textures (Gemini top-down board-game art) ----
   A biome's ground is a painted PNG mapped onto the tile top; roads/trails/walls are still
   drawn by code on top (see below) so they always exit at the exact edge midpoint and connect. */
// each biome can offer several painted variants (Gemini top-down art); index 0 is the original.
const BIOME_TEXTURE = {
  plains:    ['grass_plains.jpg','grass_plains_2.jpg','grass_plains_3.jpg'],
  forest:    ['forest_canopy.jpg','forest_canopy_2.jpg','forest_canopy_3.jpg'],
  rocks:     ['rocky_ground.jpg','rocky_ground_2.jpg','rocky_ground_3.jpg'],
  mountains: ['mountains_rocky.jpg'],
  snow:      ['snow_field.jpg'],
  sand:      ['sand_dune.jpg','sand_dune_2.jpg','sand_dune_3.jpg'] };   // Gemini-painted: golden dunes + cracked hardpan + red desert (v0.19)
export function biomeVariantCount(biome){ if(biome && biome.indexOf('custom:')===0) return 1; if(biome==='mountains') return 2; const a=BIOME_TEXTURE[biome]; if(a) return a.length; return PROC_VARIANTS[biome]||0; }   // mountains: 0 rocky · 1 snow-capped (paint snowcaps deliberately)

// ---- USER CUSTOM TILE TEXTURES (Tile Builder) --------------------------------------------------------------
// A custom tile is a user-uploaded image tiled onto a tile at a chosen scale. Registered by id ('custom:<uid>')
// with its data-URL, a scale (how many times the image repeats across ONE tile: >1 = smaller/tighter pattern,
// <1 = zoomed in), and an average colour used for the slab/edge tint. Rendered by biomeTexture below.
const _CUSTOM = {};
export function registerCustomTile(id, dataURL, scale, color){
  _CUSTOM[id] = { img:dataURL, scale:(scale||1), color:(color!=null?color:0x808080) };
  try{ TE.BIOME_COLOR[id] = _CUSTOM[id].color; }catch(e){}                 // slab + edge tint use the biome colour table
  for(const k in _texCache) if(k.indexOf(':'+id+':')>=0) delete _texCache[k];   // bust any cached texture for this id
}
export function unregisterCustomTile(id){ delete _CUSTOM[id]; for(const k in _texCache) if(k.indexOf(':'+id+':')>=0) delete _texCache[k]; }
export function customTileImageScaled(dataURL, scale, shape, size){        // 2-D preview: image tiled on a hex/square, returns a canvas
  const S=size||160, cv=document.createElement('canvas'); cv.width=cv.height=S; const cx=cv.getContext('2d');
  const img=new Image();
  const draw=()=>{ cx.clearRect(0,0,S,S); cx.save();
    const path=new Path2D(); const g=TE.gridFor(shape==='hex'?'hex':'square'), c=g.corners();
    const sc=S*0.46; path.moveTo(S/2+c[0][0]*sc, S/2+c[0][1]*sc); for(let i=1;i<c.length;i++) path.lineTo(S/2+c[i][0]*sc, S/2+c[i][1]*sc); path.closePath();
    cx.clip(path);
    const rep=Math.max(0.1, scale||1), cell=Math.max(2, Math.round(S/rep));
    const oc=document.createElement('canvas'); oc.width=oc.height=cell; oc.getContext('2d').drawImage(img,0,0,cell,cell);
    const pat=cx.createPattern(oc,'repeat'); cx.fillStyle=pat; cx.fillRect(0,0,S,S); cx.restore();
    cx.strokeStyle='rgba(0,0,0,.4)'; cx.lineWidth=2; cx.stroke(path);
    cv.dispatchEvent(new Event('tiledraw')); };
  img.onload=draw; img.src=dataURL; return {canvas:cv, redraw:draw, img};
}
// snow settled between the crags — soft white patches + a faint overall frost, painted over the rocky top for
// the snow-capped mountains variant (variant 1). Reads as an alpine snowy mountainside from above.
function _snowDust(x,S,amt){
  amt = (amt==null) ? 1 : amt;                                                                  // 1 = full alpine cap; <1 = light dusting (winter foliage)
  const n=Math.round(70*amt), a0=0.92*amt, a1=0.6*amt;
  for(let i=0;i<n;i++){ const px=Math.random()*S, py=Math.random()*S, r=6+Math.random()*26;
    const g=x.createRadialGradient(px,py,0,px,py,r);
    g.addColorStop(0,'rgba(246,250,255,'+a0.toFixed(2)+')'); g.addColorStop(0.6,'rgba(236,244,252,'+a1.toFixed(2)+')'); g.addColorStop(1,'rgba(236,244,252,0)');
    x.fillStyle=g; x.beginPath(); x.arc(px,py,r,0,6.28); x.fill(); }
  x.fillStyle='rgba(240,246,252,'+(0.14*amt).toFixed(2)+')'; x.fillRect(0,0,S,S); }             // faint overall frost
// Seasonal recolour for FOLIAGE biomes (forest / plains). Their texture "variants" are all summer-green art,
// so the Season control (variant 1 = Autumn, 2 = Winter) otherwise did nothing. We tint the green art toward
// autumn golds or winter frost with a canvas filter (variant 0 = Spring/Summer stays untouched). Winter also
// gets a snow dusting on top (added by the caller). Only foliage is seasoned — rock/sand/water look the same.
const _SEASON_FOLIAGE = { forest:1, plains:1, green:1 };
function _seasonFilter(biome, variant){
  if(!_SEASON_FOLIAGE[biome]) return null;
  if(variant===1) return 'saturate(1.35) sepia(0.55) hue-rotate(-18deg) brightness(1.02)';   // Autumn — greens → golds/oranges
  if(variant===2) return 'saturate(0.72) brightness(0.98) hue-rotate(6deg)';                  // Winter — cool & muted evergreen (snow dusted LIGHTLY after, trees stay visible)
  return null;                                                                                // Spring / Summer — leave the art as-is
}
const _texCache = {};
// town-ground bases get a PROCEDURAL top (no PNG) — a blank colored ground you build a town on with props.
// feather the painted top's rim to transparent so tiles blend — the mask follows the TILE SHAPE:
// a SQUARE-band feather on square grids (so the terrain fills the square and doesn't read round),
// a radial feather on hex (a hexagon is round enough that a disc mask matches it well).
function _featherMask(x,S,gridKind){ x.globalCompositeOperation='destination-in';
  if(gridKind==='hex'){
    const g=x.createRadialGradient(S/2,S/2,S*0.30, S/2,S/2,S*0.52);
    g.addColorStop(0,'rgba(0,0,0,1)'); g.addColorStop(0.7,'rgba(0,0,0,1)'); g.addColorStop(1,'rgba(0,0,0,0)');
    x.fillStyle=g; x.fillRect(0,0,S,S);
  } else {                                   // square: 4 edge ramps multiplied → opaque square centre, soft edge band
    const f=S*0.15;
    for(const [x0,y0,x1,y1] of [[0,0,f,0],[S,0,S-f,0],[0,0,0,f],[0,S,0,S-f]]){
      const g=x.createLinearGradient(x0,y0,x1,y1); g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,1)');
      x.fillStyle=g; x.fillRect(0,0,S,S); }
  }
  x.globalCompositeOperation='source-over'; }
// SOFT EDGE that reads as the painted TOP (not a translucent layer over a dark base): the art stays fully
// OPAQUE and covers the whole tile, but its outer rim is tinted toward the tile's own biome colour, so
// neighbouring tiles fade into a shared tone at the seam (a soft blend) with no see-through / dark groove.
function _hexRGB(hex){ return [(hex>>16)&255,(hex>>8)&255,hex&255]; }
function _edgeTint(x,S,gridKind,hex){ x.globalCompositeOperation='source-over';
  // keep the tint SUBTLE — just enough to soften the seam, not flood the tile edge with biome colour.
  const [r,g,b]=_hexRGB(hex), A=0.5;                              // max edge opacity (kept low so the art still shows)
  if(gridKind==='hex'){ const gr=x.createRadialGradient(S/2,S/2,S*0.36,S/2,S/2,S*0.52);
    gr.addColorStop(0,`rgba(${r},${g},${b},0)`); gr.addColorStop(1,`rgba(${r},${g},${b},${A})`); x.fillStyle=gr; x.fillRect(0,0,S,S); }
  else { const f=S*0.15; for(const [x0,y0,x1,y1] of [[0,0,f,0],[S,0,S-f,0],[0,0,0,f],[0,S,0,S-f]]){
    const gr=x.createLinearGradient(x0,y0,x1,y1); gr.addColorStop(0,`rgba(${r},${g},${b},${A})`); gr.addColorStop(1,`rgba(${r},${g},${b},0)`); x.fillStyle=gr; x.fillRect(0,0,S,S); } } }
// finish a tile-top canvas: an edge tint (soft blend, opaque top), a transparent feather, or nothing.
function _finishTop(x,S,gridKind,feather,edgeColor){ if(edgeColor!=null) _edgeTint(x,S,gridKind,edgeColor); else if(feather!==false) _featherMask(x,S,gridKind); }
function _groundTex(draw, gridKind, feather, edgeColor){ const S=256, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');
  draw(x,S); _finishTop(x,S,gridKind,feather,edgeColor); const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=8; t.needsUpdate=true; return t; }
const PROC_BIOME = {
  plaza: (gk,fe,ec)=>_groundTex((x,S)=>{ x.fillStyle='#8f8770'; x.fillRect(0,0,S,S);              // cobblestone plaza
    const cw=S/8; for(let r=0;r<9;r++){ const off=(r%2)*cw*0.5; for(let c=-1;c<9;c++){ const v=120+Math.random()*44|0;
      x.fillStyle=`rgb(${v},${v-6},${v-14})`; const rr=5,bx=c*cw+off+3,by=r*cw+3,bw=cw-6,bh=cw-6;
      x.beginPath(); x.moveTo(bx+rr,by); x.arcTo(bx+bw,by,bx+bw,by+bh,rr); x.arcTo(bx+bw,by+bh,bx,by+bh,rr); x.arcTo(bx,by+bh,bx,by,rr); x.arcTo(bx,by,bx+bw,by,rr); x.closePath(); x.fill(); } } }, gk, fe, ec),
  dirt: (gk,fe,ec)=>_groundTex((x,S)=>{ x.fillStyle='#8a6a44'; x.fillRect(0,0,S,S);                // packed earth
    for(let i=0;i<900;i++){ const v=Math.random(); x.fillStyle=v<0.5?`rgba(60,44,26,${0.10+Math.random()*0.25})`:`rgba(180,150,110,${0.10+Math.random()*0.2})`;
      x.beginPath(); x.arc(Math.random()*S,Math.random()*S,Math.random()*2.4+0.5,0,6.28); x.fill(); } }, gk, fe, ec),
  green: (gk,fe,ec)=>_groundTex((x,S)=>{ x.fillStyle='#6f9a45'; x.fillRect(0,0,S,S);               // town green / grass commons
    for(let i=0;i<1400;i++){ const g=90+Math.random()*90|0; x.strokeStyle=`rgba(${g-30},${g+20},${g-40},.5)`; x.lineWidth=1.2;
      const px=Math.random()*S,py=Math.random()*S; x.beginPath(); x.moveTo(px,py); x.lineTo(px+(Math.random()*2-1)*3,py-3-Math.random()*3); x.stroke(); } }, gk, fe, ec),
  // FARMLAND (top-down, "from the air") — the per-tile 90° top rotation flips row direction so a region reads
  // as a patchwork of fields. variant picks the crop; the generator assigns variants per cell for variety.
  crops: (gk,fe,ec,v)=>_groundTex((x,S)=>{                                                          // rows of crops on tilled earth
    const pal=[['#6f8f37','#587a2b'],['#cdae4d','#b5922f'],['#9a7a4a','#836237']][(v||0)%3];        // 0 young-green · 1 ripe-gold · 2 ploughed
    x.fillStyle='#7a6440'; x.fillRect(0,0,S,S);                                                     // bare-earth furrows show between rows
    const rows=17, rw=S/rows;
    for(let i=0;i<rows;i++){ const c=pal[i%2]; x.fillStyle=c; x.fillRect(i*rw+rw*0.16, -2, rw*0.68, S+4);
      x.fillStyle='rgba(0,0,0,.10)'; x.fillRect(i*rw+rw*0.16, -2, rw*0.14, S+4); }                  // furrow shadow on one side of each row
    for(let i=0;i<380;i++){ x.fillStyle=`rgba(${20+Math.random()*40|0},${30+Math.random()*40|0},10,.15)`;
      x.beginPath(); x.arc(Math.random()*S,Math.random()*S,Math.random()*2+0.6,0,6.28); x.fill(); }
    x.strokeStyle='rgba(52,60,32,.55)'; x.lineWidth=7; x.strokeRect(4,4,S-8,S-8);                    // hedgerow field border
  }, gk, fe, ec),
  orchard: (gk,fe,ec,v)=>_groundTex((x,S)=>{                                                        // regular grid of fruit-tree crowns
    x.fillStyle='#5c7a3a'; x.fillRect(0,0,S,S);                                                     // mown grass understory
    for(let i=0;i<600;i++){ const g=70+Math.random()*50|0; x.fillStyle=`rgba(${g-20},${g+18},${g-30},.4)`;
      x.beginPath(); x.arc(Math.random()*S,Math.random()*S,Math.random()*2+0.5,0,6.28); x.fill(); }
    const crown=(v||0)%2 ? ['#b5642a','#d98a3f','#8f4a1f'] : ['#3f7a34','#57964a','#2f5f27'];        // 0 green apple · 1 autumn
    const n=6, sp=S/n;
    for(let r=0;r<n;r++)for(let c=0;c<n;c++){ const cx=sp*(c+0.5)+(r%2?sp*0.12:0), cy=sp*(r+0.5), rr=sp*0.34;
      x.fillStyle='rgba(0,0,0,.22)'; x.beginPath(); x.arc(cx+3,cy+4,rr,0,6.28); x.fill();            // cast shadow
      x.fillStyle=crown[2]; x.beginPath(); x.arc(cx,cy,rr,0,6.28); x.fill();                          // dark rim
      x.fillStyle=crown[0]; x.beginPath(); x.arc(cx,cy,rr*0.82,0,6.28); x.fill();
      x.fillStyle=crown[1]; x.beginPath(); x.arc(cx-rr*0.28,cy-rr*0.28,rr*0.4,0,6.28); x.fill(); }    // sunlit highlight
  }, gk, fe, ec),
  pivot: (gk,fe,ec,v)=>_groundTex((x,S)=>{                                                          // centre-pivot irrigation circle in a square field
    x.fillStyle='#b89b5f'; x.fillRect(0,0,S,S);                                                     // dry unirrigated corners
    for(let i=0;i<500;i++){ x.fillStyle=`rgba(${120+Math.random()*60|0},${100+Math.random()*40|0},60,.2)`;
      x.beginPath(); x.arc(Math.random()*S,Math.random()*S,Math.random()*2+0.6,0,6.28); x.fill(); }
    const cx=S/2, cy=S/2, R=S*0.475;
    const g1=(v||0)%2 ? '#c2a63f' : '#5f8a34', g2=(v||0)%2 ? '#a88a2c' : '#4a7027';
    for(let i=6;i>=1;i--){ x.fillStyle=i%2?g1:g2; x.beginPath(); x.arc(cx,cy,R*i/6,0,6.28); x.fill(); } // concentric crop bands
    x.strokeStyle='rgba(255,255,255,.3)'; x.lineWidth=2.5; x.beginPath(); x.moveTo(cx,cy); x.lineTo(cx+R,cy); x.stroke(); // pivot arm
    x.fillStyle='#4a4a4a'; x.beginPath(); x.arc(cx,cy,S*0.028,0,6.28); x.fill();                      // centre hub
  }, gk, fe, ec),
};
const PROC_VARIANTS = { crops:3, orchard:2, pivot:2 };   // procedural-farmland variant counts (no PNGs)

/* ---- BATTLE (D&D-mini) SCALE: 1 square = 5 ft = the space one character occupies. The ground is redrawn
   CLOSE-UP (blades of grass, pebbles, flagstones) instead of a whole region's terrain per tile, and big
   features (trees, boulders, buildings) become PROPS that span several squares (see makeBattleProp + the
   board-level pass in the host). Toggled board-wide by setTileScale('battle'|'world'). ---- */
let _scale = 'world';
export function setTileScale(s){ _scale = (s==='battle') ? 'battle' : 'world'; }
export function tileScale(){ return _scale; }
const PROC_CLOSEUP = {                                   // top-down ground at ~5-ft-per-tile zoom (canvas S given)
  grass: (x,S)=>{ x.fillStyle='#5f8a37'; x.fillRect(0,0,S,S);
    for(let i=0;i<2600;i++){ const g=70+Math.random()*90|0, px=Math.random()*S, py=Math.random()*S, len=4+Math.random()*7, a=(Math.random()*0.6-0.3);
      x.strokeStyle=`rgba(${g-34},${g+26},${g-44},.7)`; x.lineWidth=1+Math.random(); x.beginPath(); x.moveTo(px,py); x.lineTo(px+Math.sin(a)*len,py-len); x.stroke(); }
    for(let i=0;i<7;i++){ x.fillStyle='rgba(150,120,60,.18)'; x.beginPath(); x.arc(Math.random()*S,Math.random()*S,10+Math.random()*24,0,6.28); x.fill(); } },
  forestfloor: (x,S)=>{ x.fillStyle='#4b3d28'; x.fillRect(0,0,S,S);
    for(let i=0;i<1400;i++){ const v=Math.random(); x.fillStyle=v<0.5?`rgba(90,64,36,${0.3+Math.random()*0.4})`:`rgba(60,84,40,${0.25+Math.random()*0.4})`;
      x.save(); x.translate(Math.random()*S,Math.random()*S); x.rotate(Math.random()*6.28); x.fillRect(0,0,4+Math.random()*7,2+Math.random()*3); x.restore(); }
    for(let i=0;i<40;i++){ x.strokeStyle='rgba(70,50,28,.5)'; x.lineWidth=2+Math.random()*3; const px=Math.random()*S,py=Math.random()*S;
      x.beginPath(); x.moveTo(px,py); x.lineTo(px+(Math.random()*60-30),py+(Math.random()*60-30)); x.stroke(); }
    for(let i=0;i<16;i++){ x.fillStyle='rgba(60,110,60,.3)'; x.beginPath(); x.arc(Math.random()*S,Math.random()*S,8+Math.random()*20,0,6.28); x.fill(); } },
  rock: (x,S)=>{ x.fillStyle='#867d6f'; x.fillRect(0,0,S,S);                                          // cracked flagstone / bedrock
    for(let i=0;i<26;i++){ const px=Math.random()*S,py=Math.random()*S,r=16+Math.random()*40, v=110+Math.random()*60|0;
      x.fillStyle=`rgb(${v},${v-8},${v-20})`; x.beginPath(); const n=5+(Math.random()*3|0);
      for(let j=0;j<=n;j++){ const a=j/n*6.28, rr=r*(0.7+Math.random()*0.5); const xx=px+Math.cos(a)*rr, yy=py+Math.sin(a)*rr; j?x.lineTo(xx,yy):x.moveTo(xx,yy);} x.closePath(); x.fill();
      x.strokeStyle='rgba(40,36,30,.5)'; x.lineWidth=1.5; x.stroke(); } },
  sandclose: (x,S)=>{ x.fillStyle='#d8c48c'; x.fillRect(0,0,S,S);
    for(let i=0;i<10;i++){ x.strokeStyle='rgba(150,124,72,.35)'; x.lineWidth=3+Math.random()*4; x.beginPath();
      const y0=Math.random()*S; x.moveTo(0,y0); for(let xx=0;xx<=S;xx+=16) x.lineTo(xx,y0+Math.sin(xx*0.06+i)*10); x.stroke(); }
    for(let i=0;i<800;i++){ x.fillStyle=`rgba(${180+Math.random()*50|0},${150+Math.random()*40|0},90,.3)`; x.fillRect(Math.random()*S,Math.random()*S,1.5,1.5); } },
  snowclose: (x,S)=>{ x.fillStyle='#e9f0f7'; x.fillRect(0,0,S,S);
    for(let i=0;i<20;i++){ x.fillStyle='rgba(180,200,220,.25)'; x.beginPath(); x.arc(Math.random()*S,Math.random()*S,12+Math.random()*30,0,6.28); x.fill(); }
    for(let i=0;i<900;i++){ x.fillStyle='rgba(255,255,255,.8)'; x.fillRect(Math.random()*S,Math.random()*S,1.5,1.5); } },
  snowyrock: (x,S)=>{ PROC_CLOSEUP.rock(x,S);                                                        // bedrock with settled snow between the stones
    for(let i=0;i<38;i++){ const px=Math.random()*S,py=Math.random()*S,r=10+Math.random()*30;
      const g=x.createRadialGradient(px,py,0,px,py,r); g.addColorStop(0,'rgba(246,250,255,.95)'); g.addColorStop(0.6,'rgba(236,244,252,.7)'); g.addColorStop(1,'rgba(236,244,252,0)');
      x.fillStyle=g; x.beginPath(); x.arc(px,py,r,0,6.28); x.fill(); }
    for(let i=0;i<500;i++){ x.fillStyle='rgba(255,255,255,.7)'; x.fillRect(Math.random()*S,Math.random()*S,1.5,1.5); } },
  dirtclose: (x,S)=>{ x.fillStyle='#8a6a44'; x.fillRect(0,0,S,S);
    for(let i=0;i<1600;i++){ const v=Math.random(); x.fillStyle=v<0.5?`rgba(60,44,26,${0.12+Math.random()*0.3})`:`rgba(180,150,110,${0.12+Math.random()*0.25})`;
      x.beginPath(); x.arc(Math.random()*S,Math.random()*S,Math.random()*3+0.6,0,6.28); x.fill(); }
    for(let i=0;i<24;i++){ x.fillStyle='rgba(120,120,120,.4)'; x.beginPath(); x.arc(Math.random()*S,Math.random()*S,2+Math.random()*4,0,6.28); x.fill(); } },   // pebbles
};
const CLOSEUP_FOR = { plains:'grass', green:'grass', crops:'grass', forest:'forestfloor', orchard:'grass',
  rocks:'rock', mountains:'rock', sand:'sandclose', snow:'snowclose', village:'dirtclose', city:'dirtclose',
  dirt:'dirtclose', plaza:'dirtclose', pivot:'grass' };
// A biome's painted PNG, drawn to a canvas with its EDGES FEATHERED to transparent so the texture
// fades before the tile border — adjacent tiles blend softly instead of clashing at the hex/grid line.
function biomeTexture(biome, variant, gridKind, feather, edgeColor){
  variant = variant || 0; gridKind = gridKind || 'square';
  const ckey = _scale+':'+biome+':'+variant+':'+gridKind+':'+(edgeColor!=null?('e'+edgeColor):(feather!==false?'f':'o'));
  if (ckey in _texCache) return _texCache[ckey];
  if (biome && biome.indexOf('custom:')===0){                                                                // USER custom-texture tile (Tile Builder)
    const rec=_CUSTOM[biome]; if(!rec) return (_texCache[ckey]=null);
    const S=384, cv=document.createElement('canvas'); cv.width=cv.height=S; const cx=cv.getContext('2d');
    const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=8;
    const base='#'+('000000'+((rec.color>>>0).toString(16))).slice(-6);
    const paintBase=()=>{ cx.fillStyle=base; cx.fillRect(0,0,S,S); _finishTop(cx,S,gridKind,feather,edgeColor); t.needsUpdate=true; };
    paintBase();
    const img=new Image();
    img.onload=()=>{ cx.clearRect(0,0,S,S);
      const rep=Math.max(0.1, rec.scale||1), cell=Math.max(2, Math.round(S/rep));                            // scale = repeats across ONE tile
      const oc=document.createElement('canvas'); oc.width=oc.height=cell; oc.getContext('2d').drawImage(img,0,0,cell,cell);
      const pat=cx.createPattern(oc,'repeat'); cx.fillStyle=pat; cx.fillRect(0,0,S,S);
      _finishTop(cx,S,gridKind,feather,edgeColor); t.needsUpdate=true; };
    img.onerror=paintBase; img.src=rec.img;
    return (_texCache[ckey]=t);
  }
  if (_scale==='battle' && CLOSEUP_FOR[biome]){                                                               // 5-ft close-up ground
    const cf = (biome==='mountains' && variant===1) ? 'snowyrock' : CLOSEUP_FOR[biome];                       // snow-capped mountains → snowy bedrock
    return (_texCache[ckey]=_groundTex(PROC_CLOSEUP[cf], gridKind, feather, edgeColor)); }
  if (PROC_BIOME[biome]) return (_texCache[ckey]=PROC_BIOME[biome](gridKind, feather, edgeColor, variant));   // town-ground / farmland procedural top
  const arr = BIOME_TEXTURE[biome]; if (!arr) return (_texCache[ckey]=null);
  const file = arr[Math.max(0, Math.min(arr.length-1, variant))];
  const S=384, cv=document.createElement('canvas'); cv.width=cv.height=S; const cx=cv.getContext('2d');
  const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=8;
  // paint a solid biome base IMMEDIATELY so the tile is never blank — even if the image is slow, blocked,
  // or fails to load on a given device (the async onload path was the only place anything was drawn, so a
  // failed/late image left the canvas transparent → "textures not rendering" on some machines). The image,
  // when it arrives, refines this; if it never arrives, the base colour stays.
  const _base = (edgeColor!=null ? edgeColor : (TE.BIOME_COLOR[biome]!=null ? TE.BIOME_COLOR[biome] : 0x808080));
  const _hex = '#'+('000000'+(_base>>>0).toString(16)).slice(-6);
  const _paintBase=()=>{ cx.fillStyle=_hex; cx.fillRect(0,0,S,S); _finishTop(cx,S,gridKind,feather,edgeColor); t.needsUpdate=true; };
  _paintBase();
  const img=new Image();
  img.onload=()=>{ cx.clearRect(0,0,S,S);
    const sf=_seasonFilter(biome,variant);                             // Autumn/Winter recolour for foliage (its art is all summer-green)
    if(sf){ cx.save(); cx.filter=sf; cx.drawImage(img,0,0,S,S); cx.restore(); try{ cx.filter='none'; }catch(e){} }
    else cx.drawImage(img,0,0,S,S);
    if(biome==='mountains' && variant===1) _snowDust(cx,S);             // snow-capped mountains variant → dust the rocky top with snow
    else if(_SEASON_FOLIAGE[biome] && variant===2) _snowDust(cx,S,0.5);  // Winter foliage → LIGHT snow between the trees (they stay visible, not a white blob)
    _finishTop(cx,S,gridKind,feather,edgeColor);                        // soft biome-colour edge (opaque top) / feather / hard
    t.needsUpdate=true; };
  img.onerror=_paintBase;                                              // image unavailable → keep the solid biome base (never blank)
  img.src='tile-textures/'+file;
  return (_texCache[ckey] = t);
}
// a flat tile-shaped polygon at y=0 with UVs remapped 0..1 over the tile's bounding box
const _topGeoCache = {};
function topGeo(gridKind){
  if (_topGeoCache[gridKind]) return _topGeoCache[gridKind];
  const g = TE.gridFor(gridKind);
  const shape = new THREE.Shape();
  g.corners().forEach((c,i)=> i ? shape.lineTo(c[0],c[1]) : shape.moveTo(c[0],c[1])); shape.closePath();
  const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI/2);
  geo.computeBoundingBox(); const bb = geo.boundingBox, pos = geo.attributes.position, uv = [];
  const dx = (bb.max.x-bb.min.x)||1, dz = (bb.max.z-bb.min.z)||1;
  for (let i=0;i<pos.count;i++){ uv.push((pos.getX(i)-bb.min.x)/dx, 1-(pos.getZ(i)-bb.min.z)/dz); }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  return (_topGeoCache[gridKind] = geo);
}
const col = (h)=> new THREE.Color(h);
function mat(hex, opts){ return new THREE.MeshStandardMaterial(Object.assign({ color:hex, roughness:0.9, metalness:0.0 }, opts||{})); }

// extruded polygon slab from (x,z) corners → geometry lying in the XZ plane, top at y=TOP
function slabGeo(corners, depth){
  const shape = new THREE.Shape();
  corners.forEach((c,i)=> i? shape.lineTo(c[0], c[1]) : shape.moveTo(c[0], c[1]));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled:false });
  g.rotateX(-Math.PI/2);          // shape-XY → world-XZ; the extrude already lands at y∈[0,depth]
  // (previously translated up by `depth`, which put the slab at [depth,2·depth] — so the painted top,
  //  paths and pawns, all placed at ~TOP=depth, ended up at the slab's BOTTOM with the dark block rising
  //  above them: the "texture is on the bottom" bug. The slab must sit on y=0 with its top at y=depth.)
  return g;
}

/* ---- painted-look path surfaces drawn on a canvas (no art assets, no Gemini) ----
   Each is a strip texture: canvas width = across the path (u, so darker SHOULDERS live at the
   left/right edges), canvas height = along the path (v, tiled with RepeatWrapping). Gives roads a
   packed-dirt/gravel surface + trails a worn footpath + rivers rippled water, instead of a flat bar. */
function makeStripTex(draw, w, h){
  const cv=document.createElement('canvas'); cv.width=w; cv.height=h; draw(cv.getContext('2d'), w, h);
  const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace;
  t.wrapT=THREE.RepeatWrapping; t.anisotropy=8; return t;
}
let _roadTex,_trailTex,_riverTex;
function roadTex(){ return _roadTex || (_roadTex = makeStripTex((x,w,h)=>{
  const g=x.createLinearGradient(0,0,w,0); g.addColorStop(0,'#6f5230'); g.addColorStop(.5,'#b58f57'); g.addColorStop(1,'#6f5230');
  x.fillStyle=g; x.fillRect(0,0,w,h);
  x.fillStyle='rgba(56,40,22,.6)'; x.fillRect(0,0,w*.15,h); x.fillRect(w*.85,0,w*.15,h);         // shoulders
  x.strokeStyle='rgba(74,54,30,.5)'; x.lineWidth=Math.max(1,w*.05);                               // wheel ruts (run along length)
  for(const cx of [w*.37,w*.63]){ x.beginPath(); x.moveTo(cx,0); x.lineTo(cx,h); x.stroke(); }
  for(let i=0;i<90;i++){ x.fillStyle=`rgba(${175+Math.random()*45|0},${145+Math.random()*40|0},${100+Math.random()*35|0},.6)`;
    x.beginPath(); x.arc(Math.random()*w,Math.random()*h,Math.random()*1.6+.4,0,6.28); x.fill(); } // gravel
},64,72)); }
// GREYSCALE worn-path strip for MultiplyBlending: it DARKENS the terrain it lies on (a beaten path the
// same colour, just darker), fading to white (= no darkening) at the side edges so it blends in softly.
function trailTex(){ return _trailTex || (_trailTex = makeStripTex((x,w,h)=>{
  const g=x.createLinearGradient(0,0,w,0);
  g.addColorStop(0,'#ffffff'); g.addColorStop(.22,'#8f857a'); g.addColorStop(.5,'#6f665c'); g.addColorStop(.78,'#8f857a'); g.addColorStop(1,'#ffffff');
  x.fillStyle=g; x.fillRect(0,0,w,h);                                                               // trodden centre, soft sides
  for(let i=0;i<60;i++){ const v=90+Math.random()*70|0; x.fillStyle=`rgba(${v},${v},${v},.4)`;      // mottled wear
    x.beginPath(); x.arc(w*.2+Math.random()*w*.6, Math.random()*h, Math.random()*2.4+.6,0,6.28); x.fill(); }
  for(let i=0;i<14;i++){ x.fillStyle='rgba(60,55,48,.5)'; x.beginPath(); x.arc(w*.25+Math.random()*w*.5, Math.random()*h, Math.random()*1.3+.5,0,6.28); x.fill(); } // dark scuffs
},52,72)); }
function riverTex(){ return _riverTex || (_riverTex = makeStripTex((x,w,h)=>{
  const g=x.createLinearGradient(0,0,w,0); g.addColorStop(0,'#255a78'); g.addColorStop(.5,'#4a94c4'); g.addColorStop(1,'#255a78');
  x.fillStyle=g; x.fillRect(0,0,w,h);
  x.strokeStyle='rgba(205,235,255,.32)'; x.lineWidth=1.4;
  for(let i=0;i<9;i++){ const yy=Math.random()*h; x.beginPath(); x.moveTo(0,yy); for(let xx=0;xx<=w;xx+=5) x.lineTo(xx,yy+Math.sin(xx*.35+i)*1.6); x.stroke(); }
},64,72)); }
// PAVED road: grey cobblestones set in mortar, with darker kerb shoulders — a made road vs the dirt one.
let _pavedTex;
function pavedTex(){ return _pavedTex || (_pavedTex = makeStripTex((x,w,h)=>{
  x.fillStyle='#5b5f66'; x.fillRect(0,0,w,h);                                                 // mortar base
  x.fillStyle='rgba(40,42,47,.7)'; x.fillRect(0,0,w*.13,h); x.fillRect(w*.87,0,w*.13,h);      // kerb shoulders
  const cols=4, rows=9, cw=w*0.74/cols, ch=h/rows;
  for(let r=0;r<rows;r++){ const off=(r%2)*cw*0.5;
    for(let c=-1;c<=cols;c++){ const cx0=w*0.13 + c*cw + off + cw*0.10, cy0=r*ch + ch*0.12;
      const v=118+Math.random()*46|0; x.fillStyle=`rgb(${v},${v-4},${v-10})`;
      const rr=2; const bw=cw*0.8, bh=ch*0.76;
      x.beginPath(); x.moveTo(cx0+rr,cy0); x.arcTo(cx0+bw,cy0,cx0+bw,cy0+bh,rr); x.arcTo(cx0+bw,cy0+bh,cx0,cy0+bh,rr);
      x.arcTo(cx0,cy0+bh,cx0,cy0,rr); x.arcTo(cx0,cy0,cx0+bw,cy0,rr); x.closePath(); x.fill(); } }
},64,80)); }

/* ---- CURVED painted paths (roads/trails/rivers) ----
   A path is a flat textured RIBBON that follows a smooth cubic-bezier curve, not a straight bar.
   Every path still starts EXACTLY at its edge midpoint and exits ~perpendicular to that edge (so it
   connects to the neighbour's path), but curves + a small per-tile random wobble in between make it
   look like a real road. Two path edges = one curve through the tile (a straight-through gets a gentle
   bend, an L gets a rounded corner); 3+ edges = a wobbled central hub with a curve to each edge. */
const _norm=(x,z)=>{ const d=Math.hypot(x,z)||1; return {x:x/d,z:z/d}; };
function ribbonMesh(curve, spec){
  const width=spec.w, y=spec.y, ro=spec.ro;
  const N=22, pos=[], uv=[], idx=[]; const hw=width/2;
  const len = (curve.getLength ? curve.getLength() : 1) || 1; const rep = Math.max(1, Math.round(len/0.5));
  for(let i=0;i<=N;i++){ const u=i/N; const p=curve.getPoint(u); const t=curve.getTangent(u);
    const px=-t.z, pz=t.x;                                   // perpendicular in XZ
    pos.push(p.x+px*hw, y, p.z+pz*hw,  p.x-px*hw, y, p.z-pz*hw);
    uv.push(0, u*rep, 1, u*rep); }
  for(let i=0;i<N;i++){ const a=i*2; idx.push(a,a+2,a+1, a+1,a+2,a+3); }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2)); g.setIndex(idx);
  const tt=spec.tex.clone(); tt.needsUpdate=true; tt.wrapT=THREE.RepeatWrapping;
  const mo={ map:tt, transparent:true, depthTest:false, depthWrite:false, side:THREE.DoubleSide };
  if(spec.blend==='multiply') mo.blending=THREE.MultiplyBlending;                 // trail: darken the terrain it's on
  const m=new THREE.Mesh(g, new THREE.MeshBasicMaterial(mo)); m.renderOrder=ro; return m;
}
const PATH_OVER = 0.06;   // overshoot each end PAST the tile edge so neighbour ribbons overlap (no seam gap)
function pathCurve(A, B, wob, toHub){
  const V=p=>new THREE.Vector3(p.x,0,p.z);
  const na=_norm(-A.x,-A.z), pa={x:-na.z,z:na.x};             // inward normal + its perpendicular
  const dist=Math.hypot(A.x-B.x,A.z-B.z), k=Math.max(0.16, dist*0.4);
  const oa=_norm(A.x,A.z);                                    // outward normal at A (A is an edge midpoint)
  const A2={ x:A.x+oa.x*PATH_OVER, z:A.z+oa.z*PATH_OVER };    // start just OUTSIDE the edge → overlaps the neighbour
  const P1={ x:A.x+na.x*k + pa.x*wob(), z:A.z+na.z*k + pa.z*wob() };   // exit A ~perpendicular, wobbled
  let P2, Bend=B;
  if(toHub){ P2={ x:B.x+(A.x-B.x)*0.28, z:B.z+(A.z-B.z)*0.28 }; }      // approach the hub from A's side
  else { const nb=_norm(-B.x,-B.z), pb={x:-nb.z,z:nb.x}; P2={ x:B.x+nb.x*k + pb.x*wob(), z:B.z+nb.z*k + pb.z*wob() };
    const ob=_norm(B.x,B.z); Bend={ x:B.x+ob.x*PATH_OVER, z:B.z+ob.z*PATH_OVER }; }   // overshoot the B edge too
  return new THREE.CubicBezierCurve3(V(A2), V(P1), V(P2), V(Bend));
}
function buildPaths(grp, def, gridKind, seed){
  const g=TE.gridFor(gridKind);
  const rng=rng32((((seed||1)*2246822519)>>>0)); const wob=()=> (rng()*2-1)*0.085;
  const SPEC={ [P.RIVER]:{tex:riverTex(),w:0.26,y:TOP+0.026,ro:3}, [P.TRAIL]:{tex:trailTex(),w:0.09,y:TOP+0.03,ro:3,blend:'multiply'}, [P.ROAD]:{tex:roadTex(),w:0.11,y:TOP+0.032,ro:3} };   // road/trail halved to match the thinner map-scale roads
  for(const type of [P.RIVER, P.TRAIL, P.ROAD]){             // river first (under), road last (on top)
    const spec=SPEC[type]; if(!spec) continue;
    const edges=[]; def.edges.forEach((e,dir)=>{ if(e.path===type){ const [ex,ez]=g.edgeMid(dir); edges.push({x:ex,z:ez}); } });
    if(!edges.length) continue;
    if(edges.length===1){ const H={x:wob()*0.6, z:wob()*0.6}; grp.add(ribbonMesh(pathCurve(edges[0],H,wob,true), spec)); }
    else if(edges.length===2){ grp.add(ribbonMesh(pathCurve(edges[0],edges[1],wob,false), spec)); }
    else { const H={x:wob()*0.34, z:wob()*0.34};
      for(const E of edges) grp.add(ribbonMesh(pathCurve(E,H,wob,true), spec));
      // a small dirt patch fills the meeting point so 3+ roads merge (only roads; trails/rivers overlap at the hub)
      if(type===P.ROAD){ const jt=spec.tex.clone(); jt.needsUpdate=true;
        const plate=new THREE.Mesh(new THREE.CircleGeometry(spec.w*0.52,16), new THREE.MeshBasicMaterial({map:jt,transparent:true,depthTest:false,depthWrite:false}));
        plate.rotation.x=-Math.PI/2; plate.position.set(H.x, spec.y+0.001, H.z); plate.renderOrder=spec.ro+1; grp.add(plate); }
    }
  }
}

// a wall segment running ALONG an edge (perpendicular to the centre→edge normal)
// A tile's painted top plane is drawn depth-test-OFF (so it always paints over its slab), which means it
// would also paint over an opaque 3-D wall standing on the tile — the wall then only peeks out at grazing
// angles ("ghost"/"post"). Flagging wall meshes transparent with a high renderOrder puts them in the pass
// that draws AFTER the tile tops, so the whole wall stays visible; depthWrite keeps them solid to each other.
function _overTiles(m){ m.renderOrder=9; if(m.material){ m.material.transparent=true; m.material.depthWrite=true; } return m; }
function wallSeg(group, ex, ez, edgeLen, hgt){
  const normal = Math.atan2(ex, ez);
  const m=new THREE.Mesh(new THREE.BoxGeometry(0.14, hgt||0.26, edgeLen*0.96), mat(0x8b8b93,{roughness:0.8}));
  m.position.set(ex, TOP + (hgt||0.26)/2, ez); m.rotation.y = normal + Math.PI/2;  // lie along the edge
  m.castShadow=true; group.add(_overTiles(m));
  // crenellations
  const merlon = mat(0x9a9aa2,{roughness:0.8});
  for(let i=-1;i<=1;i++){ const c=new THREE.Mesh(new THREE.BoxGeometry(0.15,0.08,0.12), merlon);
    const tang = normal + Math.PI/2; c.position.set(ex + Math.sin(tang)*i*edgeLen*0.3, TOP+(hgt||0.26)+0.04, ez + Math.cos(tang)*i*edgeLen*0.3);
    c.rotation.y=tang; group.add(_overTiles(c)); }
}

// an arched GATEWAY across a wall edge (where the road enters a castle/town) — two posts + a rounded arch.
function archGate(group, ex, ez, edgeLen, hgt){
  const normal=Math.atan2(ex,ez), tang=normal+Math.PI/2, H=hgt||0.24;
  const half=edgeLen*0.30, tube=0.05, stone=mat(0x8b8b93,{roughness:0.8});
  const px=(s)=>ex+Math.sin(tang)*s*half, pz=(s)=>ez+Math.cos(tang)*s*half;
  for(const s of [-1,1]){ const p=new THREE.Mesh(new THREE.BoxGeometry(0.09,H,0.09), stone); p.position.set(px(s),TOP+H/2,pz(s)); p.castShadow=true; group.add(_overTiles(p)); }
  // rounded top: voussoir boxes stepped along a semicircle spanning the two posts (in the tangent–vertical plane)
  const seg=6; for(let i=0;i<=seg;i++){ const a=Math.PI*i/seg, ax=Math.cos(a)*half, ay=Math.sin(a)*half*0.7;
    const v=new THREE.Mesh(new THREE.BoxGeometry(0.11,tube*2,0.09), stone);
    v.position.set(ex+Math.sin(tang)*ax, TOP+H+ay, ez+Math.cos(tang)*ax); v.rotation.set(0, tang, a-Math.PI/2); group.add(_overTiles(v)); }
}
const treeMat = mat(0x2f5d33), trunkMat = mat(0x6b4a2e,{roughness:1});
function tree(x,z,s){ const g=new THREE.Group();
  const tr=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.03,0.1), trunkMat); tr.position.y=TOP+0.05; g.add(tr);
  const cn=new THREE.Mesh(new THREE.ConeGeometry(0.09*s,0.24*s,7), treeMat); cn.position.y=TOP+0.22*s; g.add(cn);
  cn.castShadow=true; g.position.set(x,0,z); return g; }
function house(x,z,rot,tall,r){ r=r||Math.random; const g=new THREE.Group();   // castle 'buildings' (tall=true) are bigger + VARIED: footprint, wall height, roof height/shape/colour all jitter per building
  const big=!!tall;
  const bw=(big?0.21:0.14)*(0.8+r()*0.6);                                       // footprint width
  const bd=bw*(0.72+r()*0.6);                                                   // depth ≠ width → non-square footprints (halls vs towers)
  const bh=(big?0.26:0.15)*(0.68+r()*1.05);                                     // wall height jitters a lot → mixed roof heights
  const wallCols = big?[0xb9b2a6,0xc9bfa8,0xa89a86,0xbfae90,0xcdbd9b]:[0xcaa877,0xc7a06a,0xd8bd93];
  const b=new THREE.Mesh(new THREE.BoxGeometry(bw,bh,bd), mat(wallCols[(r()*wallCols.length)|0],{roughness:0.85})); b.position.y=TOP+bh/2; b.castShadow=true; g.add(b);
  const roofCols=[0x8a3b2f,0x7a3b30,0x6e4b32,0x8f5a34,0x5f4a34];
  const rh=(0.07+r()*0.14)*(big?1.5:1.0);                                        // roof height varies
  const sides=(r()<0.72)?4:3;                                                    // hip (4-sided) vs peaked (3-sided) → mixed roof shapes
  const roof=new THREE.Mesh(new THREE.ConeGeometry(Math.max(bw,bd)*0.82, rh*2, sides), mat(roofCols[(r()*roofCols.length)|0]));
  roof.position.y=TOP+bh+rh; roof.rotation.y=Math.PI/4; roof.castShadow=true; g.add(roof);
  g.position.set(x,0,z); g.rotation.y=rot; return g; }
// a mountain peak with SHAPE variety — random face count, height/radius/footprint independent of size, so a
// range reads as varied crags rather than a grid of identical hex-cones. `s` sets overall size; `r` an rng.
function peak(x,z,s,r,snow){ r=r||Math.random;
  const g=new THREE.Group(); g.position.set(x,0,z);
  const sides=4+Math.floor(r()*4);                       // 4–7 faces → jagged silhouettes
  const h=0.4*s*(0.75+r()*0.85), rad=0.16*s*(0.8+r()*0.5), rot=r()*6.28, sx=0.72+r()*0.6;
  const m=new THREE.Mesh(new THREE.ConeGeometry(rad,h,sides), mat(snow?0x9aa0a6:0x8a8172,{roughness:1}));   // snowcap variant: cooler grey rock
  m.position.y=TOP+h/2; m.rotation.y=rot; m.scale.x=sx; m.castShadow=true; g.add(m);
  // snow cap: FORCED for the snow-capped variant (bigger cap), else only on the taller peaks
  if(snow || s>0.9 || r()<0.4){ const sh=h*(snow?0.5:0.32), sr=rad*(snow?0.6:0.5);
    const cap=new THREE.Mesh(new THREE.ConeGeometry(sr,sh,sides), mat(0xeef2f6));
    cap.position.y=TOP+h-sh/2; cap.rotation.y=rot; cap.scale.x=sx; g.add(cap); }
  return g; }
function tuft(x,z){ const m=new THREE.Mesh(new THREE.ConeGeometry(0.05,0.1,5), mat(0x6f9a3f)); m.position.set(x,TOP+0.05,z); return m; }

/* A large BATTLE-SCALE prop, sized in world units (a tile is 1 unit) so it can span several 5-ft squares.
   The host places these over biome clusters when board scale is 'battle'. kind: tree|pine|boulder|hut|house. */
export function makeBattleProp(kind, r){ r = r || Math.random; const g = new THREE.Group();
  if(kind==='tree'){ const th=0.45+r()*0.4, cr=0.7+r()*0.6;
    const tr=new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.14,th,7), trunkMat); tr.position.y=TOP+th/2; tr.castShadow=true; g.add(tr);
    for(let i=0;i<3;i++){ const s=cr*(1-i*0.2), c=new THREE.Mesh(new THREE.SphereGeometry(s,9,8), mat(i? 0x3a6b3a:0x2f5d33));
      c.position.y=TOP+th+cr*0.35+i*cr*0.42; c.scale.y=0.82; c.castShadow=true; g.add(c); } }
  else if(kind==='pine'){ const th=0.4+r()*0.3;
    const tr=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.11,th,7), trunkMat); tr.position.y=TOP+th/2; g.add(tr);
    for(let i=0;i<4;i++){ const s=1-i*0.22, c=new THREE.Mesh(new THREE.ConeGeometry(0.72*s,0.85,8), mat(0x2b5d34));
      c.position.y=TOP+th+i*0.5; c.castShadow=true; g.add(c); } }
  else if(kind==='boulder'){ const b=new THREE.Mesh(new THREE.DodecahedronGeometry(0.55+r()*0.5), mat(0x8a8172,{roughness:1}));
    b.position.y=TOP+0.35; b.rotation.set(r()*3,r()*3,r()*3); b.scale.set(1,0.78,0.9+r()*0.3); b.castShadow=true; g.add(b);
    const b2=new THREE.Mesh(new THREE.DodecahedronGeometry(0.28+r()*0.22), mat(0x7d7568,{roughness:1})); b2.position.set(0.45,TOP+0.18,0.35); b2.castShadow=true; g.add(b2); }
  else if(kind==='hut'||kind==='house'){ const big=kind==='house', w=big?1.25:0.82, h=big?0.72:0.5;
    const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w*0.92), mat(big?0xcab79a:0xc7a06a,{roughness:0.85})); b.position.y=TOP+h/2; b.castShadow=true; g.add(b);
    const roof=new THREE.Mesh(new THREE.ConeGeometry(w*0.82,w*0.5,4), mat(0x7a3b30)); roof.position.y=TOP+h+w*0.24; roof.rotation.y=Math.PI/4; roof.castShadow=true; g.add(roof); }
  return g; }

/* ---- 2D board mode: a board-wide flat/top-down toggle. In FLAT mode buildTileMesh skips raised 3-D features
   (peaks, houses, trees…) and draws flat top-down decals instead, so the whole board reads as a paper map.
   Painted-top biomes (plains/forest/farmland/rocky/sand/snow) already read from above and need no decal. ---- */
let _flat = false;
export function setTileFlat(v){ _flat = !!v; }
export function tileFlat(){ return _flat; }
function flatDecal(w,h,color,op){ const geo=new THREE.PlaneGeometry(w,h); geo.rotateX(-Math.PI/2);
  const m=new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color, transparent:true, opacity:op==null?0.96:op, depthWrite:false}));
  m.renderOrder=3; return m; }
function flatRoof(x,z,big,r){ const g=new THREE.Group();                        // bigger + VARIED: size, footprint aspect, rotation & roof colour jitter per building
  const base=big?0.215:0.14, w=base*(0.8+r()*0.55), h=w*(0.66+r()*0.62), rot=r()*3.14;
  const sh=flatDecal(w*1.18,h*1.18,0x000000,0.28); sh.position.set(x+0.012,TOP+0.045,z+0.014); sh.rotation.y=rot; g.add(sh);   // soft shadow
  const roofCols = big?[0xb9b2a6,0xc9bfa8,0xa89a86,0xbfae90]:[0xc59a5f,0xb98a52,0xd8bd93];
  const roof=flatDecal(w,h, roofCols[(r()*roofCols.length)|0], 0.98); roof.position.set(x,TOP+0.05,z); roof.rotation.y=rot; g.add(roof);
  const ridge=flatDecal(w,h*0.17,[0x7a3b30,0x6e4b32,0x8a3b2f][(r()*3)|0],0.9); ridge.position.set(x,TOP+0.052,z); ridge.rotation.y=rot; g.add(ridge); return g; }   // roof ridge line

// scatter a feature over the tile, keeping clear of any path strips. `mass` (0..1) = mountain-massif depth:
// core cells build a tall central peak + satellites, fringe cells a single small foothill.
function scatter(group, def, gridKind, seed, mass, variant){
  const r = rng32(seed*2654435761>>>0);
  const snowPeaks = variant===1 && def.biome==='mountains';   // snow-capped mountains variant → every peak gets a snow cap
  const g = TE.gridFor(gridKind);
  const hasPath = def.edges.some(e=>e.path!==P.NONE);
  const pathDirs = def.edges.map((e,i)=>e.path!==P.NONE?i:-1).filter(i=>i>=0).map(i=>g.edgeMid(i));
  const clear = (x,z)=>{ if(Math.hypot(x,z)<0.16 && hasPath) return false;      // keep centre clear when paths cross
    for(const [ex,ez] of pathDirs){ // distance from point to the centre→edge segment
      const t=Math.max(0,Math.min(1,(x*ex+z*ez)/(ex*ex+ez*ez))); const dx=x-ex*t, dz=z-ez*t;
      if(Math.hypot(dx,dz)<0.16) return false; } return true; };
  const rad = gridKind==='hex'?0.36:0.4;
  const pts=[]; for(let i=0;i<26;i++){ const x=(r()*2-1)*rad, z=(r()*2-1)*rad; if(clear(x,z)) pts.push([x,z]); }
  const f = def.feature;
  const take=(n)=>pts.slice(0,n);
  // BATTLE SCALE: region features (forests, peaks, buildings) become board-level multi-tile props; a single
  // tile only keeps ground-level extras (water surface, a bridge, a shoreline). See makeBattleProp + host pass.
  if(_scale==='battle' && f!=='water' && f!=='bridge' && f!=='shore') return;
  // 2D BOARD MODE: flat top-down decals instead of raised geometry (textured biomes already read from above).
  if(_flat){
    if(f==='houses'||f==='buildings'){ take(f==='buildings'?5:4).forEach(([x,z])=> group.add(flatRoof(x,z,f==='buildings',r))); return; }
    if(f==='keep'){ const k=flatDecal(0.34,0.34,0x8a8a92,0.98); k.position.y=TOP+0.05; group.add(k);
      for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const t=flatDecal(0.1,0.1,0x6f676d,0.98); t.position.set(sx*0.15,TOP+0.052,sz*0.15); group.add(t);} return; }
    if(f==='peaks'){ const M=(typeof mass==='number')?mass:0.5; take(1+Math.round(M*3)).forEach(([x,z],i)=>{ const s=0.1+M*0.16*(i?0.6:1);
      const c=flatDecal(s,s,snowPeaks?0xdfe9f2:0x726a5c,0.92); c.position.set(x,TOP+0.05,z); c.rotation.y=r()*1.57; group.add(c);      // snow-white crag dots for the snow-capped variant
      if(snowPeaks){ const cap=flatDecal(s*0.5,s*0.5,0xffffff,0.95); cap.position.set(x,TOP+0.052,z); cap.rotation.y=c.rotation.y; group.add(cap); } }); return; }
    if(f==='trees'||f==='tufts'||f==='farm'||f==='treeline'||f==='foothills'||f==='citywall'||f==='field') return;   // carried by the painted top / omitted in 2D
    // water / bridge / shore fall through to their (already-flat) handlers below
  }
  if(f==='trees')       take(8).forEach(([x,z])=> group.add(tree(x,z,0.8+r()*0.5)));
  else if(f==='tufts')  take(5).forEach(([x,z])=> group.add(tuft(x,z)));
  else if(f==='peaks'){ const M = (typeof mass==='number') ? mass : (0.35+r()*0.5);   // core=tall massif, fringe=small foothill
    const big = 0.6 + M*1.9, n = 1 + Math.round(M*3);
    group.add(peak((r()*2-1)*0.14, (r()*2-1)*0.14, big, r, snowPeaks));                 // central summit near tile centre
    for(let i=1;i<n;i++){ const [x,z]=pts[i]||[(r()*2-1)*rad,(r()*2-1)*rad]; group.add(peak(x,z, big*(0.38+r()*0.42), r, snowPeaks)); } }  // lower shoulders
  else if(f==='houses') take(4).forEach(([x,z])=> group.add(house(x,z,r()*6.28,false,r)));
  else if(f==='buildings') take(5).forEach(([x,z])=> group.add(house(x,z,r()*6.28,true,r)));
  else if(f==='farm' && pts[0]) group.add(house(pts[0][0],pts[0][1],r()*6.28,false,r));
  else if(f==='keep'){ // castle: central keep + ring wall around the perimeter (gap at the road/gate edge)
    const k=new THREE.Mesh(new THREE.BoxGeometry(0.26,0.42,0.26), mat(0x9a9298)); k.position.y=TOP+0.21; k.castShadow=true; group.add(k);
    const t=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,0.16,8), mat(0xb9b2a6)); t.position.y=TOP+0.5; group.add(t);
    for(let dir=0; dir<g.N; dir++){ const [ex,ez]=g.edgeMid(dir); const p=def.edges[dir].path;
      if(p===P.ROAD||p===P.TRAIL) archGate(group, ex*0.86, ez*0.86, edgeLenOf(gridKind), 0.24);     // arched gateway where the road enters
      else if(p===P.NONE) wallSeg(group, ex*0.86, ez*0.86, edgeLenOf(gridKind), 0.24); } }
  else if(f==='water'){ // a single TRANSPARENT glossy surface sitting on the deep-blue base slab → water you can
    // see into (depth), not a second stacked block. (Was a 0.02-thick slab which, after the slab-height fix,
    // stacked visibly on top of the base — Paul: "double stacked; I liked the transparent look before".)
    const w=new THREE.Mesh(topGeo(gridKind), new THREE.MeshStandardMaterial({ color:0x6fb8e6, roughness:0.16, metalness:0.35, transparent:true, opacity:0.55, depthWrite:false }));
    w.position.y=TOP+0.006; w.renderOrder=1; group.add(w); }
  else if(f==='bridge'){ const pl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.04,0.26), mat(0x6b4a2e,{roughness:1})); pl.position.y=TOP+0.05; group.add(pl); }
  // transition strips along the N/first edge
  else if(f==='citywall'){ const [ex,ez]=g.edgeMid(0); wallSeg(group, ex*0.9, ez*0.9, edgeLenOf(gridKind), 0.24); }
  else if(f==='treeline'){ const [ex,ez]=g.edgeMid(0); for(let i=-2;i<=2;i++){ const t=Math.atan2(ex,ez)+Math.PI/2; group.add(tree(ex*0.8+Math.sin(t)*i*0.14, ez*0.8+Math.cos(t)*i*0.14, 0.7)); } }
  else if(f==='foothills'){ const [ex,ez]=g.edgeMid(0); group.add(peak(ex*0.75,ez*0.75,0.7)); }
  else if(f==='shore'){ const [ex,ez]=g.edgeMid(0); const w=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.02,0.28), mat(0x59a6d6,{roughness:0.3,metalness:0.25})); w.position.set(ex*0.8,TOP,ez*0.8); w.rotation.y=Math.atan2(ex,ez); group.add(w); }
}
function edgeLenOf(kind){ return kind==='hex' ? 0.5 : 1.0; }   // side length of a unit tile

// tint a wedge near a transition edge with that edge's biome colour
function transitionTint(group, def, gridKind){
  const g = TE.gridFor(gridKind);
  def.edges.forEach((e,dir)=>{ if(e.biome===def.biome) return;
    const [ex,ez]=g.edgeMid(dir); const c=TE.BIOME_COLOR[e.biome]||0x888888;
    const w=new THREE.Mesh(new THREE.BoxGeometry(edgeLenOf(gridKind)*0.98,0.02, gridKind==='hex'?0.22:0.34), mat(c,{roughness:0.95}));
    w.position.set(ex*0.82,TOP+0.001,ez*0.82); w.rotation.y=Math.atan2(ex,ez); group.add(w); });
}

// small coloured nub at each edge midpoint, coloured by its PATH type (editor overlay)
export function connectorNubs(def, gridKind){
  const g = TE.gridFor(gridKind); const grp=new THREE.Group(); grp.name='nubs';
  def.edges.forEach((e,dir)=>{ if(e.path===P.NONE) return;
    const [ex,ez]=g.edgeMid(dir); const c=TE.PATH_COLOR[TE.PATH_NAME[e.path]];
    const m=new THREE.Mesh(new THREE.SphereGeometry(0.06,10,10), new THREE.MeshBasicMaterial({color:c}));
    m.position.set(ex*0.98,TOP+0.08,ez*0.98); grp.add(m); });
  return grp;
}

export function buildTileMesh(def, gridKind, seed, variant, mass, customTex){
  const g = TE.gridFor(gridKind);
  const grp = new THREE.Group(); grp.userData.defId=def.id;
  // base slab — a DARKENED biome tone so where the painted top feathers out at the edges it reads as a
  // soft shadowed groove between tiles (a clean tile border + a blend, instead of a hard texture seam).
  const baseCol = new THREE.Color(TE.BIOME_COLOR[def.biome]||0x777777).multiplyScalar(0.5);
  const base = new THREE.Mesh(slabGeo(g.corners(), D_H), mat(baseCol.getHex(), {roughness:0.95}));
  base.receiveShadow=true; base.name='base'; grp.add(base);
  // painted terrain texture on the tile top (if this biome has one) — variant picks which painting.
  // The paint is the tile's actual TOP SURFACE: OPAQUE, full-coverage (no feathered rim revealing the dark
  // slab underneath) and sitting flush on the slab top, so it reads as painted-on rather than a translucent
  // layer floating over a darker base. (Water has no BIOME_TEXTURE → it keeps its own reflective surface.)
  // OPAQUE, full-coverage art whose rim is tinted to the biome colour → reads as the painted TOP SURFACE
  // (not a translucent layer over a dark base) AND blends softly into neighbouring tiles at the seam.
  const tex = customTex || biomeTexture(def.biome, variant||0, gridKind, false, TE.BIOME_COLOR[def.biome]||0x777777);   // uploaded tile art wins
  if (tex){
    // drawn UNLIT (art shows as painted). Now that the slab sits at [0,TOP], this plane at TOP+0.02 is a
    // real depth-tested surface — so 3-D features that belong ON the terrain (mountain peaks, etc.) render
    // ABOVE it instead of being hidden by an always-on-top plane. (depthTest:false used to occlude them.)
    const top = new THREE.Mesh(topGeo(gridKind), new THREE.MeshBasicMaterial({ map:tex }));
    top.position.y = TOP + 0.02; top.renderOrder = 1;
    if(!customTex){ const rr = rng32((((seed||1)*40503)>>>0)); const steps = gridKind==='hex'?6:4;   // rotate per tile to hide the repeat (tile shape is n-fold symmetric so it still covers)
      top.rotation.y = (gridKind==='hex'?Math.PI/3:Math.PI/2) * Math.floor(rr()*steps); }   // uploaded art stays upright
    grp.add(top);
  }
  // rim — a crisp thin tile outline drawn on top (depth-test off) so the hex/grid line stays clean over the blend
  const rimPts=g.corners(); const rimGeo=new THREE.BufferGeometry().setFromPoints(rimPts.concat([rimPts[0]]).map(c=>new THREE.Vector3(c[0],TOP+0.04,c[1])));
  const rim=new THREE.LineLoop(rimGeo, new THREE.LineBasicMaterial({color:0x12100c, transparent:true, opacity:0.28, depthTest:false, depthWrite:false}));
  rim.renderOrder=2; grp.add(rim);
  // transition biome tint
  transitionTint(grp, def, gridKind);
  // walls stay straight segments along their edge; roads/trails/rivers are CURVED painted ribbons that
  // still exit at the exact edge midpoint (so they connect) but bend + wobble through the tile.
  if(!customTex) def.edges.forEach((e,dir)=>{ if(e.path===P.WALL){ const [ex,ez]=g.edgeMid(dir); wallSeg(grp, ex, ez, edgeLenOf(gridKind)); } });
  // GENERATED tiles (def.gen) draw their roads/rivers/trails as CONTINUOUS swept strokes (bld.draw) instead
  // of per-tile ribbons, so they don't truncate/misalign at tile joins. Only hand-placed LIBRARY tiles use
  // the per-tile ribbon renderer here. (Tile edges stay set either way for the play/graph layer.)
  if(!def.gen && !customTex) buildPaths(grp, def, gridKind, seed);
  // features — skip the procedural 3D scatter when a painted texture already shows the terrain
  // (keep it for untextured biomes: village houses, city buildings, castle keep, water, transitions).
  // EXCEPTION: mountains still get scattered 3D PEAKS on top of the rocky ground — otherwise every mountain
  // tile shows the SAME texture with a centred peak, so a mountain region reads as peaks in a straight grid.
  if (!customTex){
    if (!tex) scatter(grp, def, gridKind, seed||1, mass, variant);
    else if (def.feature==='houses' || def.feature==='buildings' || def.feature==='keep' || def.feature==='peaks') scatter(grp, def, gridKind, seed||1, mass, variant);
  }
  return grp;
}

export const stepAngle = (kind)=> kind==='hex' ? Math.PI/3 : Math.PI/2;

/* ==========================================================================
   Board-level FREEFORM paths — the manual ✏️ Draw tool + generated town walls.
   Unlike tile paths (drawn per-tile between edge midpoints), these follow an
   arbitrary polyline of board points {x,z} (in the builder's scene frame), so a
   road / stream / trail / wall can run along tile edges, turn at corners, and
   trace the hex/square pattern for as long as you like. Same painted textures.
   ========================================================================== */
// path widths are world-scale by default (a ribbon across a region tile). In BATTLE scale a road/stream must
// read as a real ~5-10 ft way — roughly one 5-ft cell wide — so widen them when _scale==='battle'.
const DRAW_SPEC = {
  river: ()=>({ tex:riverTex(), w:_scale==='battle'?0.95:0.24, y:TOP+0.028, ro:5 }),
  trail: ()=>({ tex:trailTex(), w:_scale==='battle'?0.55:0.09, y:TOP+0.030, ro:6, blend:'multiply' }),   // World roads/trails halved — too thick for the map scale (Paul)
  road:  ()=>({ tex:roadTex(),  w:_scale==='battle'?0.90:0.11, y:TOP+0.034, ro:7 }),
  paved: ()=>({ tex:pavedTex(), w:_scale==='battle'?1.00:0.12, y:TOP+0.035, ro:7 }),
};
// a flat textured ribbon of the given type following world points [{x,z},…]
// The drawn points are the clicked connector dots; instead of hard straight segments between
// them we run a smooth spline THROUGH them (rounded corners), so a hand-drawn road bends like the
// per-tile roads do. Collinear runs stay straight; a turn at a corner becomes a gentle curve.
export function pathRibbonAlong(points, type){
  const s = DRAW_SPEC[type] && DRAW_SPEC[type]();
  if (!s || !points || points.length < 2) return null;
  const hw = s.w/2;
  const vpts = points.map(p=>new THREE.Vector3(p.x, s.y, p.z));
  // centripetal Catmull-Rom passes through every drawn dot without overshooting on sharp turns
  const curve = new THREE.CatmullRomCurve3(vpts, false, 'centripetal', 0.5);
  const len = curve.getLength() || 1;
  const N = Math.max(2, Math.min(240, Math.round(len/0.10)));   // sample density along the curve
  // build a sample list, EXTENDING each end a little straight along its tangent so where two drawn
  // strokes meet they overlap (covers the triangular gap) instead of butting flat ends together.
  const EXT=0.09, samp=[];
  const t0=curve.getTangent(0), p0=curve.getPoint(0);
  samp.push({ p:p0.clone().addScaledVector(t0,-EXT), t:t0, run:-EXT });
  for (let i=0;i<=N;i++){ const u=i/N; samp.push({ p:curve.getPoint(u), t:curve.getTangent(u), run:u*len }); }
  const t1=curve.getTangent(1), p1=curve.getPoint(1);
  samp.push({ p:p1.clone().addScaledVector(t1,EXT), t:t1, run:len+EXT });
  const pos=[], uv=[], idx=[];
  for (const sm of samp){ const t=sm.t, nx=-t.z, nz=t.x, p=sm.p;
    pos.push(p.x+nx*hw, s.y, p.z+nz*hw,  p.x-nx*hw, s.y, p.z-nz*hw);
    uv.push(0, sm.run/0.5, 1, sm.run/0.5);
  }
  for (let i=0;i<samp.length-1;i++){ const a=i*2; idx.push(a,a+2,a+1, a+1,a+2,a+3); }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2)); g.setIndex(idx);
  const tt=s.tex.clone(); tt.needsUpdate=true; tt.wrapT=THREE.RepeatWrapping;
  const mo={ map:tt, transparent:true, depthTest:false, depthWrite:false, side:THREE.DoubleSide };
  if (s.blend==='multiply') mo.blending=THREE.MultiplyBlending;
  const m=new THREE.Mesh(g, new THREE.MeshBasicMaterial(mo)); m.renderOrder=s.ro; return m;
}
// a small textured patch that fills where drawn paths of a type meet — reads as the roads/trails
// merging into a Y/junction (same trick the per-tile renderer uses at 3-way hubs), positioned by caller.
export function pathPlate(type, radius){
  const s = DRAW_SPEC[type] && DRAW_SPEC[type]();
  if (!s) return null;
  const jt=s.tex.clone(); jt.needsUpdate=true;
  const plate=new THREE.Mesh(new THREE.CircleGeometry(radius || s.w*0.5, 18),   // = the road's HALF-width so the merge patch fills the junction WITHOUT bulging past the road edges as a visible disc
    new THREE.MeshBasicMaterial({ map:jt, transparent:true, depthTest:false, depthWrite:false,
      blending: s.blend==='multiply' ? THREE.MultiplyBlending : THREE.NormalBlending }));
  plate.rotation.x=-Math.PI/2; plate.renderOrder=s.ro; return plate;
}
// a crenellated stone wall following world points [{x,z},…]
export function wallRibbonAlong(points, hgt){
  // BATTLE scale: a settlement/castle wall is a real defensive structure a mini stands behind, so it must be
  // TALL and thick — not the low world-scale region-boundary curb. Scale height, thickness, battlements + their
  // spacing up so the wall reads correctly against 5-ft cells and battle-sized props.
  const battle = _scale==='battle';
  hgt = hgt || (battle ? 1.05 : 0.26);
  const th   = battle ? 0.24 : 0.13;                 // wall thickness
  const mW   = battle ? 0.26 : 0.14, mH = battle ? 0.20 : 0.08, mD = battle ? 0.20 : 0.11;  // merlon (crenellation) box
  const mStep= battle ? 0.36 : 0.2;                  // spacing between battlements
  const capY = battle ? 0.10 : 0.04;                 // merlon lift above the wall top
  const grp=new THREE.Group();
  for (let i=0;i<points.length-1;i++){ const a=points[i], b=points[i+1];
    const dx=b.x-a.x, dz=b.z-a.z, L=Math.hypot(dx,dz); if(L<1e-4) continue;
    const yaw=Math.atan2(dx,dz);
    const seg=new THREE.Mesh(new THREE.BoxGeometry(th, hgt, L*0.98), mat(0x8b8b93,{roughness:0.8}));
    seg.position.set((a.x+b.x)/2, TOP+hgt/2, (a.z+b.z)/2); seg.rotation.y=yaw; seg.castShadow=true; grp.add(_overTiles(seg));
    const merlon=mat(0x9a9aa2,{roughness:0.8}); const n=Math.max(1,Math.round(L/mStep));
    for (let k=0;k<=n;k++){ const t=k/n; const c=new THREE.Mesh(new THREE.BoxGeometry(mW,mH,mD), merlon);
      c.position.set(a.x+dx*t, TOP+hgt+capY, a.z+dz*t); c.rotation.y=yaw; grp.add(_overTiles(c)); }
  }
  return grp;
}
// a FLAT 2-D wall: a grey stone ribbon lying on the ground with a drawn battlement pattern (the "2D" wall option)
let _wallTex;
function wallTex(){ return _wallTex || (_wallTex = makeStripTex((x,w,h)=>{
  x.fillStyle='#8b8b93'; x.fillRect(0,0,w,h);
  x.fillStyle='rgba(40,42,47,.55)'; x.fillRect(0,0,w,h*.14); x.fillRect(0,h*.86,w,h*.14);       // dark long edges
  x.strokeStyle='rgba(50,52,58,.7)'; x.lineWidth=2;
  for(let i=0;i<=6;i++){ const yy=i*h/6; x.beginPath(); x.moveTo(0,yy); x.lineTo(w,yy); x.stroke(); }  // block courses
  for(let r=0;r<6;r++){ const off=(r%2)*w*0.25; x.beginPath(); x.moveTo(w*0.5+off- (r%2?w*0.5:0),r*h/6); x.lineTo(w*0.5+off-(r%2?w*0.5:0),(r+1)*h/6); x.stroke(); }
},40,80)); }
export function wallFlatAlong(points){
  const spec={ tex:wallTex(), w:0.20, y:TOP+0.03, ro:7 };
  return ribbonAlongSpec(points, spec);
}
// shared: a flat textured ribbon following world points with a given spec (used by 2D wall)
function ribbonAlongSpec(points, s){
  if(!points || points.length<2) return null; const hw=s.w/2;
  const vpts=points.map(p=>new THREE.Vector3(p.x,s.y,p.z));
  const curve=new THREE.CatmullRomCurve3(vpts,false,'centripetal',0.5); const len=curve.getLength()||1;
  const N=Math.max(2,Math.min(240,Math.round(len/0.10))); const pos=[],uv=[],idx=[];
  for(let i=0;i<=N;i++){ const u=i/N,p=curve.getPoint(u),t=curve.getTangent(u); const nx=-t.z,nz=t.x;
    pos.push(p.x+nx*hw,s.y,p.z+nz*hw, p.x-nx*hw,s.y,p.z-nz*hw); uv.push(0,(u*len)/0.4,1,(u*len)/0.4); }
  for(let i=0;i<N;i++){ const a=i*2; idx.push(a,a+2,a+1,a+1,a+2,a+3); }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2)); g.setIndex(idx);
  const tt=s.tex.clone(); tt.needsUpdate=true; tt.wrapT=THREE.RepeatWrapping;
  const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({map:tt,transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide}));
  m.renderOrder=s.ro; return m;
}

/* ================= PLACEABLE PROPS (trees / house / castle / …) — 3D model or 2D flat token ========= */
export const PROP_KINDS = ['tree','pine','house','castle','well','rock','bush','tower','tent','henge','pyramid'];
const _propIconCache={};
function propIcon(kind){ if(_propIconCache[kind]) return _propIconCache[kind];
  const S=128, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d'), c=S/2;
  x.clearRect(0,0,S,S); x.lineJoin='round';
  const circle=(cx,cy,r,fill)=>{ x.fillStyle=fill; x.beginPath(); x.arc(cx,cy,r,0,6.283); x.fill(); };
  if(kind==='tree'){ circle(c,c,50,'#2f6b34'); circle(c,c,50,'rgba(0,0,0,0)'); circle(c-12,c-12,20,'#4f8b45'); circle(c,c,7,'#5a3d22'); }
  else if(kind==='pine'){ x.fillStyle='#2b6b3a'; for(const r of [52,38,24]){ x.beginPath(); x.moveTo(c,c-r); const k=r*0.9; x.lineTo(c+k,c+r*0.5); x.lineTo(c-k,c+r*0.5); x.closePath(); x.fill(); } circle(c,c,6,'#3a2a18'); }
  else if(kind==='house'){ x.fillStyle='#caa877'; x.fillRect(c-38,c-30,76,66); x.fillStyle='#8a3b2f'; x.beginPath(); x.moveTo(c-46,c-26); x.lineTo(c,c-56); x.lineTo(c+46,c-26); x.closePath(); x.fill(); }
  else if(kind==='castle'){ x.fillStyle='#9a9298'; x.fillRect(c-40,c-40,80,80); x.fillStyle='#7d757b'; for(const [dx,dy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) x.fillRect(c+dx*40-14,c+dy*40-14,28,28); x.fillStyle='#b9b2a6'; x.fillRect(c-13,c-13,26,26); }
  else if(kind==='well'){ circle(c,c,40,'#8b8b93'); circle(c,c,26,'#3a6b8a'); x.strokeStyle='#6b4a2e'; x.lineWidth=8; x.beginPath(); x.moveTo(c-40,c); x.lineTo(c+40,c); x.stroke(); }
  else if(kind==='rock'){ x.fillStyle='#8a8172'; x.beginPath(); x.moveTo(c-38,c+18); x.lineTo(c-20,c-30); x.lineTo(c+18,c-34); x.lineTo(c+40,c+6); x.lineTo(c+16,c+34); x.lineTo(c-24,c+30); x.closePath(); x.fill(); x.fillStyle='rgba(255,255,255,.15)'; circle(c-6,c-6,16,'rgba(255,255,255,.12)'); }
  else if(kind==='bush'){ circle(c-16,c+4,22,'#3c7a3f'); circle(c+16,c+4,22,'#357036'); circle(c,c-10,24,'#4f8b45'); }
  else if(kind==='tower'){ circle(c,c,40,'#9a9298'); circle(c,c,40,'rgba(0,0,0,0)'); x.strokeStyle='#6f676d'; x.lineWidth=5; x.beginPath(); x.arc(c,c,30,0,6.283); x.stroke(); circle(c,c,14,'#8a3b2f'); }
  else if(kind==='tent'){ x.fillStyle='#c9a15a'; x.beginPath(); x.moveTo(c,c-44); x.lineTo(c+44,c+34); x.lineTo(c-44,c+34); x.closePath(); x.fill(); x.fillStyle='#3a2a18'; x.beginPath(); x.moveTo(c,c-10); x.lineTo(c+16,c+34); x.lineTo(c-16,c+34); x.closePath(); x.fill(); }
  else if(kind==='henge'){ for(let i=0;i<8;i++){ const a=i/8*6.283, rx=c+Math.cos(a)*40, ry=c+Math.sin(a)*40;   // stone circle (top-down)
      x.fillStyle=i%2?'#8f8880':'#9a938a'; x.fillRect(rx-7,ry-9,14,18); } x.strokeStyle='rgba(80,74,66,.5)'; x.lineWidth=2; x.beginPath(); x.arc(c,c,40,0,6.283); x.stroke(); }
  else if(kind==='pyramid'){ x.fillStyle='#c9b07a'; x.beginPath(); x.moveTo(c,c-46); x.lineTo(c+46,c+40); x.lineTo(c-46,c+40); x.closePath(); x.fill();   // pyramid seen from above (4 faces)
      x.fillStyle='#e0cc95'; x.beginPath(); x.moveTo(c,c-46); x.lineTo(c,c+40); x.lineTo(c-46,c+40); x.closePath(); x.fill();
      x.strokeStyle='#8a744a'; x.lineWidth=2; x.beginPath(); x.moveTo(c-46,c+40); x.lineTo(c,c-46); x.lineTo(c+46,c+40); x.moveTo(c,c-46); x.lineTo(c,c+40); x.stroke(); }
  const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace; t.needsUpdate=true; return _propIconCache[kind]=t;
}
function prop3D(kind){ const g=new THREE.Group();
  const add=(m)=>{ m.castShadow=true; _overTiles(m); g.add(m); return m; };
  if(kind==='tree'){ add(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.045,0.16,7), trunkMat)).position.y=TOP+0.08;
    add(new THREE.Mesh(new THREE.ConeGeometry(0.17,0.4,8), treeMat)).position.y=TOP+0.36; }
  else if(kind==='pine'){ add(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,0.14,6), trunkMat)).position.y=TOP+0.07;
    for(let i=0;i<3;i++){ const s=1-i*0.28; add(new THREE.Mesh(new THREE.ConeGeometry(0.16*s,0.24,7), mat(0x2b6b3a))).position.y=TOP+0.18+i*0.16; } }
  else if(kind==='house'){ const b=add(new THREE.Mesh(new THREE.BoxGeometry(0.34,0.24,0.34), mat(0xcaa877,{roughness:0.85}))); b.position.y=TOP+0.12;
    const r=add(new THREE.Mesh(new THREE.ConeGeometry(0.3,0.2,4), mat(0x8a3b2f))); r.position.y=TOP+0.34; r.rotation.y=Math.PI/4; }
  else if(kind==='castle'){ add(new THREE.Mesh(new THREE.BoxGeometry(0.4,0.4,0.4), mat(0x9a9298))).position.y=TOP+0.2;
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,0.28,10), mat(0xb9b2a6))).position.y=TOP+0.54;
    for(const [dx,dz] of [[-1,-1],[1,-1],[-1,1],[1,1]]){ const t=add(new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.08,0.5,8), mat(0x8f878d))); t.position.set(dx*0.22,TOP+0.25,dz*0.22); } }
  else if(kind==='well'){ add(new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.14,0.14,12), mat(0x8b8b93))).position.y=TOP+0.07;
    for(const s of [-1,1]) add(new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.02,0.28,6), trunkMat)).position.set(s*0.11,TOP+0.2,0);
    const roof=add(new THREE.Mesh(new THREE.ConeGeometry(0.2,0.12,4), mat(0x8a3b2f))); roof.position.y=TOP+0.4; roof.rotation.y=Math.PI/4; }
  else if(kind==='rock'){ add(new THREE.Mesh(new THREE.DodecahedronGeometry(0.16,0), mat(0x8a8172,{roughness:1}))).position.y=TOP+0.12; }
  else if(kind==='bush'){ for(const [dx,dz,s] of [[-0.09,0.03,0.9],[0.09,0.02,0.85],[0,-0.06,1]]) add(new THREE.Mesh(new THREE.SphereGeometry(0.11*s,8,7), mat(0x3f7a42))).position.set(dx,TOP+0.09,dz); }
  else if(kind==='tower'){ add(new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.14,0.6,10), mat(0x9a9298))).position.y=TOP+0.3;
    const roof=add(new THREE.Mesh(new THREE.ConeGeometry(0.17,0.22,10), mat(0x8a3b2f))); roof.position.y=TOP+0.71; }
  else if(kind==='tent'){ const wdt=0.5, len=0.56, hgt=0.34;   // a proper RIDGE (A-frame) tent — a triangular prism, not a cone/pyramid
    const shp=new THREE.Shape(); shp.moveTo(-wdt/2,0); shp.lineTo(wdt/2,0); shp.lineTo(0,hgt); shp.closePath();
    const tg=new THREE.ExtrudeGeometry(shp,{depth:len,bevelEnabled:false}); tg.translate(0,0,-len/2);
    const t=add(new THREE.Mesh(tg, mat(0xc25d3a,{roughness:0.9}))); t.position.y=TOP; t.castShadow=true;
    const door=add(new THREE.Mesh(new THREE.PlaneGeometry(wdt*0.34,hgt*0.7), mat(0x3a2a18)));   // dark entrance flap on the front end
    door.position.set(0,TOP+hgt*0.33,len/2+0.002); }
  else if(kind==='henge'){ const R=0.24, stone=mat(0x968f86,{roughness:1});   // ring of standing stones + a couple of lintels
    for(let i=0;i<7;i++){ const a=i/7*6.283; const s=add(new THREE.Mesh(new THREE.BoxGeometry(0.09,0.26,0.05), stone));
      s.position.set(Math.cos(a)*R,TOP+0.13,Math.sin(a)*R); s.rotation.y=-a; }
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.06,0.3,7), stone)).position.set(0,TOP+0.15,0); }
  else if(kind==='pyramid'){ const p=add(new THREE.Mesh(new THREE.ConeGeometry(0.34,0.42,4), mat(0xd2ba82,{roughness:1})));
    p.position.y=TOP+0.21; p.rotation.y=Math.PI/4; }   // (removed the stray cube that used to float above the apex)
  return g;
}
// place-able prop: mode '3d' → raised model; '2d' → flat top-down token on the ground. Caller sets position/rot.
export function makeProp(kind, mode, scale){
  scale = scale||1;
  if(mode==='2d'){ const geo=new THREE.PlaneGeometry(0.62,0.62); geo.rotateX(-Math.PI/2);
    const m=new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map:propIcon(kind), transparent:true, depthWrite:false }));
    m.position.y=TOP+0.03; m.renderOrder=6; const g=new THREE.Group(); g.add(m); g.scale.setScalar(scale); return g; }
  const g=prop3D(kind); g.scale.setScalar(scale); return g;
}

/* ================= SUBDIVIDE overlay — split a cell into equal smaller pieces =====================
   Squares → n×n small squares. Hexes → 6·n² equilateral TRIANGLES (or 3·n² RHOMBI) — a regular hexagon
   can NOT be split into smaller regular hexagons, but triangles/rhombi tile it exactly. Returns a
   LineSegments overlay in the tile's local frame (caller positions it at the cell). ================= */
function _triLattice(A,B,C,n,push){
  const P=(i,j)=>[A[0]+(i/n)*(B[0]-A[0])+(j/n)*(C[0]-A[0]), A[1]+(i/n)*(B[1]-A[1])+(j/n)*(C[1]-A[1])];
  for(let i=0;i<=n;i++) push(P(i,0), P(i,n-i));   // parallel to A→C
  for(let j=0;j<=n;j++) push(P(0,j), P(n-j,j));   // parallel to A→B
  for(let s=0;s<=n;s++) push(P(s,0), P(0,s));     // parallel to B→C
}
function _rhombiLattice(A,B,D,n,push){            // parallelogram spanned by (B-A) and (D-A)
  const P=(i,j)=>[A[0]+(i/n)*(B[0]-A[0])+(j/n)*(D[0]-A[0]), A[1]+(i/n)*(B[1]-A[1])+(j/n)*(D[1]-A[1])];
  for(let i=0;i<=n;i++) push(P(i,0), P(i,n));
  for(let j=0;j<=n;j++) push(P(0,j), P(n,j));
}
// count of equal sub-cells a mode+level yields (for labels)
export function subdivisionCount(gridKind, mode, n){
  if(gridKind==='square' || mode==='grid') return n*n;
  if(mode==='offset') return 7;         // inner hex + 6 trapezoids
  if(mode==='rhombi') return 3*n*n;
  return 6*n*n;   // triangles
}
const _OFFSET_F = Math.sqrt(1/7);       // inset factor for the OFFSET-hex subdivide → all 7 cells EQUAL AREA (6·f² = 1−f²)
// the sub-cell POLYGONS (for picking + painting) — each {poly:[[x,z]…], c:[cx,cz]} in local frame
export function subdivisionCells(gridKind, mode, n){
  n=Math.max(2,n|0); const g=TE.gridFor(gridKind), C=g.corners(); const out=[];
  const add=(pts)=>{ let cx=0,cz=0; for(const p of pts){cx+=p[0];cz+=p[1];} out.push({poly:pts, c:[cx/pts.length, cz/pts.length]}); };
  if(gridKind==='square'||mode==='grid'){
    for(let j=0;j<n;j++) for(let i=0;i<n;i++){ const x0=-0.5+i/n, z0=-0.5+j/n, s=1/n; add([[x0,z0],[x0+s,z0],[x0+s,z0+s],[x0,z0+s]]); }
  } else if(mode==='offset'){                       // OFFSET hex: an inner (inset) hex + 6 trapezoids to the outer corners
    const inner=C.map(p=>[p[0]*_OFFSET_F, p[1]*_OFFSET_F]);
    add(inner.slice());                             // central hex
    for(let k=0;k<6;k++){ const k2=(k+1)%6; add([C[k],C[k2],inner[k2],inner[k]]); }   // trapezoid per outer edge
  } else if(mode==='rhombi'){
    for(const [a,,c] of [[0,1,2],[2,3,4],[4,5,0]]){ const A=[0,0],B=C[a],D=C[c];
      const P=(i,j)=>[A[0]+(i/n)*(B[0]-A[0])+(j/n)*(D[0]-A[0]), A[1]+(i/n)*(B[1]-A[1])+(j/n)*(D[1]-A[1])];
      for(let i=0;i<n;i++) for(let j=0;j<n;j++) add([P(i,j),P(i+1,j),P(i+1,j+1),P(i,j+1)]); }
  } else {   // triangles
    for(let k=0;k<6;k++){ const A=[0,0],B=C[k],Cc=C[(k+1)%6];
      const P=(i,j)=>[A[0]+(i/n)*(B[0]-A[0])+(j/n)*(Cc[0]-A[0]), A[1]+(i/n)*(B[1]-A[1])+(j/n)*(Cc[1]-A[1])];
      for(let i=0;i<n;i++){ for(let j=0;j<n-i;j++) add([P(i,j),P(i+1,j),P(i,j+1)]);
        for(let j=0;j<n-i-1;j++) add([P(i+1,j),P(i+1,j+1),P(i,j+1)]); } }
  }
  return out;
}
export function subdivisionOverlay(gridKind, mode, n){
  n = Math.max(2, n|0);
  const g = TE.gridFor(gridKind), C = g.corners(); const segs=[]; const push=(a,b)=>{ segs.push(a); segs.push(b); };
  if(gridKind==='square' || mode==='grid'){
    for(let i=1;i<n;i++){ const t=-0.5+i/n; push([t,-0.5],[t,0.5]); push([-0.5,t],[0.5,t]); }
  } else if(mode==='offset'){                       // inner hex edges + a radial line from each inner corner to its outer corner
    const inner=C.map(p=>[p[0]*_OFFSET_F, p[1]*_OFFSET_F]);
    for(let k=0;k<6;k++){ const k2=(k+1)%6; push(inner[k],inner[k2]); push(C[k],inner[k]); }
  } else if(mode==='rhombi'){
    for(const [a,,c] of [[0,1,2],[2,3,4],[4,5,0]]) _rhombiLattice([0,0], C[a], C[c], n, push);
  } else {   // triangles
    for(let k=0;k<6;k++) _triLattice([0,0], C[k], C[(k+1)%6], n, push);
  }
  const pos=[]; for(const p of segs) pos.push(p[0], 0, p[1]);
  const geo=new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  const m=new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color:0x0c1410, transparent:true, opacity:0.6, depthTest:false, depthWrite:false }));
  m.renderOrder=3; return m;
}
