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
export function biomeVariantCount(biome){ if(biome && biome.indexOf('custom:')===0) return 1; if(biome==='mountains') return 2; if(SEASON_ART[biome]) return SEASON_ART[biome].length; const a=BIOME_TEXTURE[biome]; if(a) return a.length; return PROC_VARIANTS[biome]||0; }   // mountains: 0 rocky · 1 snow-capped (paint snowcaps deliberately)

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
const TEX_ZOOM = { forest:0.33 };   // fraction of the painting shown per tile (smaller = bigger features)
const TEX_CROP_AT = { 'forest_canopy.jpg':[0.22,0.22] };   // crop centre (0..1) — leafy forest has a dirt trail through its middle; take a trail-free corner
/* SEASONAL PAINTED ART — seasons 0 Spring · 1 Summer · 2 Autumn · 3 Winter.
   forest  variant = treeType*4 + season   (treeType 0 leafy/round · 1 pine)
   plains  variant = season
   crops   variant = season*3 + cropType   (cropType 0/1/2 from the generator's field mix → patchwork)
   orchard variant = season
   Each entry: f = file, z = fraction of the painting shown per tile (smaller = bigger features),
   at = crop centre, filter = canvas filter, dust = snow/mist dusting amount. */
const _AUT='saturate(1.35) sepia(0.55) hue-rotate(-18deg) brightness(1.02)', _WIN='saturate(0.72) brightness(0.98) hue-rotate(6deg)';
const SEASON_ART = {
  forest: [
    {f:'forest_spring.jpg', z:0.4},                                   // leafy · spring: blossom, thinner canopy
    {f:'forest_canopy.jpg', z:0.33, at:[0.22,0.22]},                  // leafy · summer (trail-free corner)
    {f:'forest_canopy_2.jpg', z:0.33, filter:_AUT},                   // leafy · autumn
    {f:'forest_winter_bare.jpg', z:0.45},                             // leafy · winter: bare branches + a little snow
    {f:'forest_canopy_3.jpg', z:0.33, filter:_WIN, dust:0.5},         // pine · spring: the misty / cloudy look
    {f:'forest_canopy_3.jpg', z:0.33},                                // pine · summer
    {f:'forest_canopy_3.jpg', z:0.33},                                // pine · autumn (evergreen)
    {f:'pine_winter.jpg', z:0.5} ],                                   // pine · winter: snow on the boughs
  plains: [ {f:'grass_plains.jpg'}, {f:'grass_summer.jpg'}, {f:'grass_autumn.jpg'}, {f:'grass_winter.jpg'} ],   // spring wildflowers · lush summer · golden autumn · snow (all edits of ONE painting)
  green:  [ {f:'grass_plains.jpg'}, {f:'grass_summer.jpg'}, {f:'grass_autumn.jpg'}, {f:'grass_winter.jpg'} ],   // castle / town lawns follow the season too
  suburb: [ {f:'grass_summer.jpg'}, {f:'grass_summer.jpg'}, {f:'grass_autumn.jpg'}, {f:'grass_winter.jpg'} ],   // MODERN: mown suburban lawns (no wildflowers)
  park:   [ {f:'grass_plains.jpg'}, {f:'grass_summer.jpg'}, {f:'grass_autumn.jpg'}, {f:'grass_winter.jpg'} ],
  crops: [
    {f:'crop_spring.jpg'}, {f:'crop_spring.jpg'}, {f:'crop_spring.jpg', z:0.8},                    // spring: sprouting furrows
    {f:'crop_summer.jpg'}, {f:'crop_wheat.jpg'}, {f:'crop_summer.jpg', z:0.8},                     // summer: green rows + ripening wheat
    {f:'crop_wheat.jpg'}, {f:'crop_harvest.jpg'}, {f:'crop_harvest.jpg', z:0.8},                   // autumn: golden wheat + harvested stubble & bales
    {f:'crop_winter.jpg'}, {f:'crop_winter.jpg'}, {f:'crop_winter.jpg', z:0.8} ],                  // winter: snowy furrows
  pivot:   [ {f:'pivot_spring.jpg'}, {f:'pivot_summer.jpg'}, {f:'pivot_autumn.jpg'}, {f:'pivot_winter.jpg'} ],   // centre-pivot irrigation circle through the year
  orchard: [ {f:'orchard_spring.jpg', z:0.75}, {f:'orchard_summer.jpg', z:0.75}, {f:'orchard_autumn.jpg', z:0.75}, {f:'orchard_winter.jpg', z:0.75} ],  // 3×3 trees per tile
};
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
  industrial: (gk,fe,ec)=>_groundTex((x,S)=>{ x.fillStyle='#8c8b86'; x.fillRect(0,0,S,S);                // MODERN: concrete yard slabs, oil stains, painted lines
    const n=4, cw=S/n; for(let r=0;r<n;r++) for(let c=0;c<n;c++){ const v=132+Math.random()*20|0; x.fillStyle=`rgb(${v},${v-1},${v-5})`; x.fillRect(c*cw+1,r*cw+1,cw-2,cw-2); }
    for(let i=0;i<14;i++){ x.fillStyle='rgba(30,28,24,.18)'; x.beginPath(); x.ellipse(Math.random()*S,Math.random()*S,6+Math.random()*16,4+Math.random()*10,Math.random()*3,0,6.28); x.fill(); }
    x.fillStyle='rgba(232,194,48,.6)'; x.fillRect(S*0.1,S*0.5,S*0.8,3); }, gk, fe, ec),
  beach: (gk,fe,ec)=>_groundTex((x,S)=>{ x.fillStyle='#ead9a6'; x.fillRect(0,0,S,S);                    // MODERN: pale beach sand
    for(let i=0;i<1400;i++){ const v=Math.random(); x.fillStyle=v<0.5?'rgba(200,180,130,.35)':'rgba(255,248,220,.4)'; x.fillRect(Math.random()*S,Math.random()*S,1.5,1.5); }
    x.strokeStyle='rgba(190,168,120,.35)'; x.lineWidth=2; for(let i=0;i<6;i++){ const y0=Math.random()*S; x.beginPath(); x.moveTo(0,y0); for(let xx=0;xx<=S;xx+=16) x.lineTo(xx,y0+Math.sin(xx*0.05+i)*5); x.stroke(); } }, gk, fe, ec),
  urban: (gk,fe,ec)=>_groundTex((x,S)=>{ x.fillStyle='#a9abae'; x.fillRect(0,0,S,S);            // MODERN: city sidewalk / plaza pavers
    const n=6, cw=S/n; for(let r=0;r<n;r++) for(let c=0;c<n;c++){ const v=160+Math.random()*26|0; x.fillStyle=`rgb(${v},${v+1},${v+4})`; x.fillRect(c*cw+1.5,r*cw+1.5,cw-3,cw-3); }
    for(let i=0;i<30;i++){ x.fillStyle='rgba(60,60,60,.08)'; x.beginPath(); x.arc(Math.random()*S,Math.random()*S,4+Math.random()*14,0,6.28); x.fill(); } }, gk, fe, ec),
  lot: (gk,fe,ec)=>_groundTex((x,S)=>{ x.fillStyle='#4a4c50'; x.fillRect(0,0,S,S);               // MODERN: asphalt parking lot (stall lines + cars are 3-D)
    for(let i=0;i<1500;i++){ const v=60+Math.random()*40|0; x.fillStyle=`rgba(${v},${v},${v+4},.5)`; x.fillRect(Math.random()*S,Math.random()*S,1.5,1.5); }
    x.strokeStyle='rgba(20,20,22,.5)'; x.lineWidth=1.2; for(let i=0;i<5;i++){ x.beginPath(); let px=Math.random()*S,py=Math.random()*S; x.moveTo(px,py); for(let j=0;j<5;j++){ px+=Math.random()*30-15; py+=Math.random()*30-15; x.lineTo(px,py); } x.stroke(); } }, gk, fe, ec),
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
    const n=3, sp=S/n;                                                                             // 3×3 trees per tile (was 6×6 = cabbage-sized)
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
  if (SEASON_ART[biome]){                                                                                     // seasonal painted art (forest / plains / crops / orchard)
    const A=SEASON_ART[biome], e=A[Math.max(0,Math.min(A.length-1,variant))];
    const S=384, cv=document.createElement('canvas'); cv.width=cv.height=S; const cx=cv.getContext('2d');
    const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=8;
    const base=(edgeColor!=null ? edgeColor : (TE.BIOME_COLOR[biome]!=null ? TE.BIOME_COLOR[biome] : 0x808080)), hex='#'+('000000'+(base>>>0).toString(16)).slice(-6);
    const paintBase=()=>{ cx.fillStyle=hex; cx.fillRect(0,0,S,S); _finishTop(cx,S,gridKind,feather,edgeColor); t.needsUpdate=true; };
    paintBase();
    const img=new Image();
    img.onload=()=>{ cx.clearRect(0,0,S,S);
      const W=img.naturalWidth, H=img.naturalHeight, z=e.z||1, sw=W*z, sh=H*z, at=e.at||[0.5,0.5];
      const sx=Math.max(0,Math.min(W-sw, W*at[0]-sw/2)), sy=Math.max(0,Math.min(H-sh, H*at[1]-sh/2));
      if(e.filter){ cx.save(); cx.filter=e.filter; cx.drawImage(img,sx,sy,sw,sh,0,0,S,S); cx.restore(); try{ cx.filter='none'; }catch(_){} }
      else cx.drawImage(img,sx,sy,sw,sh,0,0,S,S);
      if(e.dust) _snowDust(cx,S,e.dust);
      _finishTop(cx,S,gridKind,feather,edgeColor); t.needsUpdate=true; };
    img.onerror=paintBase; img.src='tile-textures/'+e.f;
    return (_texCache[ckey]=t);
  }
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
    // TEX_ZOOM: draw only the centre crop of the painting so its features read at map scale (forest canopy was
    // ~10 trees per tile = "cabbage-sized" next to the castle → now ~5 across, each tree twice the size)
    const zf=TEX_ZOOM[biome]||1, sw=img.naturalWidth*zf, sh=img.naturalHeight*zf, cc=TEX_CROP_AT[file]||[0.5,0.5], sx=Math.max(0,Math.min(img.naturalWidth-sw, img.naturalWidth*cc[0]-sw/2)), sy=Math.max(0,Math.min(img.naturalHeight-sh, img.naturalHeight*cc[1]-sh/2));
    if(sf){ cx.save(); cx.filter=sf; cx.drawImage(img,sx,sy,sw,sh,0,0,S,S); cx.restore(); try{ cx.filter='none'; }catch(e){} }
    else cx.drawImage(img,sx,sy,sw,sh,0,0,S,S);
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
  // crenellated lintel across the two posts (the old stepped-voussoir arch was rotated on the wrong axis and
  // read as tumbled rubble next to the keep)
  const lin=new THREE.Mesh(new THREE.BoxGeometry(half*2+0.09, 0.07, 0.11), stone);
  lin.position.set(ex, TOP+H+0.035, ez); lin.rotation.y=Math.atan2(-Math.cos(tang), Math.sin(tang)); lin.castShadow=true; group.add(_overTiles(lin));
  for(const s of [-1,0,1]){ const m=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.05,0.1), mat(0x9a9aa2,{roughness:0.8}));
    m.position.set(px(s*0.8), TOP+H+0.095, pz(s*0.8)); m.rotation.y=lin.rotation.y; group.add(_overTiles(m)); }
}
const treeMat = mat(0x2f5d33), trunkMat = mat(0x6b4a2e,{roughness:1});
function tree(x,z,s){ const g=new THREE.Group();
  const tr=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.03,0.1), trunkMat); tr.position.y=TOP+0.05; g.add(tr);
  const cn=new THREE.Mesh(new THREE.ConeGeometry(0.09*s,0.24*s,7), treeMat); cn.position.y=TOP+0.22*s; g.add(cn);
  cn.castShadow=true; g.position.set(x,0,z); return g; }
/* ---- HOUSES (v0.91 — Paul: "we can do a better job on the houses") ----
   A real little building instead of a box + cone: walls painted with a canvas texture (lime-wash / timber-framed
   plaster / fieldstone, with a door and shuttered windows on the front and windows round the sides), a proper
   GABLED roof (thatch, clay tile or slate — its gable ends are wall-coloured), eaves overhang and a stone
   chimney. Cottages sometimes get a lean-to wing; town houses are two storeys with rows of windows. Textures +
   materials are cached, so a whole village costs only a few draw calls per house. */
const _hsCache={};
function _hsCanvas(w,h,draw){ const cv=document.createElement('canvas'); cv.width=w; cv.height=h; draw(cv.getContext('2d'),w,h);
  const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=4; return t; }
const WALL_STYLES=[                                             // base, beam colour (null = no timber), stone?
  {base:'#e9dfc6', beam:'#4a3424'}, {base:'#e3d2ae', beam:'#553a26'}, {base:'#efe6d2', beam:null},
  {base:'#d8c49a', beam:null}, {base:'#b3a38c', beam:null, stone:true}, {base:'#c9b48e', beam:'#3f2c1f'},
  // MODERN PACK (6–12): clapboard siding in white / pastels, red barn, brick
  {base:'#f1efe8', beam:null, siding:true, shut:'#2f3d2f'}, {base:'#c9d6dd', beam:null, siding:true, shut:'#27384a'}, {base:'#e6dcc2', beam:null, siding:true, shut:'#4a3a2a'},
  {base:'#bfcfb7', beam:null, siding:true, shut:'#f1efe8'}, {base:'#d8c6a8', beam:null, siding:true, shut:'#6b2f2a'}, {base:'#e9ecee', beam:null, siding:true, shut:'#1f2a36'},
  {base:'#a8322a', beam:null, siding:true, shut:'#f1efe8', barn:true}, {base:'#9c5a44', beam:null, stone:true} ];
function _houseWallTex(si, face, storeys){ const key='w'+si+face+storeys; if(_hsCache[key]) return _hsCache[key];
  const st=WALL_STYLES[si];
  return (_hsCache[key]=_hsCanvas(128, 64*storeys, (x,W,H)=>{
    x.fillStyle=st.base; x.fillRect(0,0,W,H);
    if(st.stone){ for(let y=0;y<H;y+=9) for(let i=-(y/9%2)*7;i<W;i+=15){ x.fillStyle=['#a79781','#9b8b76','#b8a88f','#8f806c'][((i*7+y*3)>>>0)%4]; x.fillRect(i+1,y+1,13,7); } }
    else if(st.siding){ x.fillStyle='rgba(0,0,0,.09)'; for(let y=5;y<H;y+=7) x.fillRect(0,y,W,1.5); x.fillStyle='rgba(255,255,255,.18)'; for(let y=6;y<H;y+=7) x.fillRect(0,y,W,1); }   // lap siding
    else { x.globalAlpha=0.08; for(let i=0;i<260;i++){ x.fillStyle=i%2?'#000':'#fff'; x.fillRect((i*53)%W,(i*29)%H,3,2); } x.globalAlpha=1; }
    if(st.barn){ x.strokeStyle='#f1efe8'; x.lineWidth=4; x.strokeRect(2,2,W-4,H-4); if(face!=='side'){ x.beginPath(); x.moveTo(W/2-24,H-2); x.lineTo(W/2+24,H-46); x.moveTo(W/2+24,H-2); x.lineTo(W/2-24,H-46); x.stroke(); x.strokeRect(W/2-24,H-46,48,44); } return; }
    const floorH=H/storeys;
    if(st.beam){ x.fillStyle=st.beam; x.fillRect(0,0,W,5); x.fillRect(0,H-6,W,6); x.fillRect(0,0,5,H); x.fillRect(W-5,0,5,H);
      for(let f=1;f<storeys;f++) x.fillRect(0,f*floorH-3,W,6);
      x.lineWidth=4; x.strokeStyle=st.beam; for(let f=0;f<storeys;f++){ const y0=f*floorH; x.beginPath(); x.moveTo(8,y0+floorH-6); x.lineTo(30,y0+6); x.moveTo(W-8,y0+floorH-6); x.lineTo(W-30,y0+6); x.stroke(); } }
    const win=(cx,cy)=>{ x.fillStyle='#3b2a1e'; x.fillRect(cx-11,cy-10,22,20); x.fillStyle='#26303d'; x.fillRect(cx-8,cy-8,16,16);
      x.fillStyle='#e7c77a'; x.globalAlpha=0.35; x.fillRect(cx-8,cy-8,16,7); x.globalAlpha=1;
      x.fillStyle='#3b2a1e'; x.fillRect(cx-1,cy-8,2,16); x.fillRect(cx-8,cy-1,16,2);
      x.fillStyle=st.shut||'#6b3f2a'; x.fillRect(cx-17,cy-10,6,20); x.fillRect(cx+11,cy-10,6,20); };   // shutters
    for(let f=0;f<storeys;f++){ const cy=H-(f+0.52)*floorH;
      if(face==='front'){ if(f===0){ x.fillStyle='#5a3a24'; x.fillRect(W/2-11,H-40,22,40); x.beginPath(); x.arc(W/2,H-40,11,Math.PI,0); x.fill();
          x.fillStyle='#3a2616'; x.fillRect(W/2-1,H-44,2,44); x.fillStyle='#c9a15a'; x.fillRect(W/2+6,H-20,3,3); win(28,cy); win(W-28,cy); }
        else { win(28,cy); win(W/2,cy); win(W-28,cy); } }
      else if(face==='side'){ win(40,cy); win(W-40,cy); }
      else win(W/2,cy); }
  })); }
const ROOF_STYLES=[{kind:'thatch',c:'#c7a35c',d:'#8f7038'},{kind:'thatch',c:'#b8944f',d:'#7d6232'},{kind:'tile',c:'#a34a33',d:'#6e2c1e'},
                   {kind:'tile',c:'#8d4a2f',d:'#5c2b1b'},{kind:'slate',c:'#56606f',d:'#343a45'},{kind:'tile',c:'#b0613e',d:'#77371f'},
                   {kind:'shingle',c:'#4a4d52',d:'#2f3135'},{kind:'shingle',c:'#6b5646',d:'#4a3a2e'},{kind:'shingle',c:'#5f6770',d:'#3d434a'}];   // MODERN: asphalt shingles
function _roofTex(ri){ const key='r'+ri; if(_hsCache[key]) return _hsCache[key];
  const st=ROOF_STYLES[ri];
  const t=_hsCanvas(64,64,(x,W,H)=>{ x.fillStyle=st.c; x.fillRect(0,0,W,H);
    if(st.kind==='thatch'){ x.strokeStyle=st.d; x.globalAlpha=0.55; x.lineWidth=1; for(let i=0;i<180;i++){ const px=(i*37)%W, py=(i*23)%H; x.beginPath(); x.moveTo(px,py); x.lineTo(px+1,py+7); x.stroke(); } x.globalAlpha=1; }
    else { x.fillStyle=st.d; for(let y=0;y<H;y+=8){ x.fillRect(0,y,W,1.6); for(let i=(y/8%2)*5;i<W;i+=10) x.fillRect(i,y,1.2,8); } } });
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(9,9); return (_hsCache[key]=t); }
function _hsMat(key, make){ return _hsCache['m'+key] || (_hsCache['m'+key]=make()); }
function _gableGeo(W, L, rh){ const key='g'+W.toFixed(3)+L.toFixed(3)+rh.toFixed(3); if(_hsCache[key]) return _hsCache[key];
  const sh=new THREE.Shape(); sh.moveTo(-W/2,0); sh.lineTo(W/2,0); sh.lineTo(0,rh); sh.closePath();
  const g=new THREE.ExtrudeGeometry(sh,{depth:L, bevelEnabled:false}); g.translate(0,0,-L/2); return (_hsCache[key]=g); }
// one building: body (length L along z, width W along x, front door on +x), gabled roof, chimney
function _building(W, L, H, storeys, si, ri, r, chimney){ const g=new THREE.Group();
  const plain=_hsMat('wp'+si, ()=>new THREE.MeshStandardMaterial({color:new THREE.Color(WALL_STYLES[si].base), roughness:0.9}));
  const mats=[ _hsMat('wf'+si+storeys, ()=>new THREE.MeshStandardMaterial({map:_houseWallTex(si,'front',storeys), roughness:0.9})),
               _hsMat('ws'+si+storeys, ()=>new THREE.MeshStandardMaterial({map:_houseWallTex(si,'side',storeys), roughness:0.9})),
               plain, plain,
               _hsMat('we'+si+storeys, ()=>new THREE.MeshStandardMaterial({map:_houseWallTex(si,'end',storeys), roughness:0.9})),
               _hsMat('we'+si+storeys, ()=>new THREE.MeshStandardMaterial({map:_houseWallTex(si,'end',storeys), roughness:0.9})) ];
  const body=new THREE.Mesh(new THREE.BoxGeometry(W,H,L), mats); body.position.y=TOP+H/2; body.castShadow=true; body.receiveShadow=true; g.add(body);
  const ov=0.018, rh=(W+ov*2)*(0.42+r()*0.22)*(ROOF_STYLES[ri].kind==='thatch'?1.15:1);
  const roofMats=[ _hsMat('gp'+si, ()=>new THREE.MeshStandardMaterial({color:new THREE.Color(WALL_STYLES[si].base).multiplyScalar(0.92), roughness:0.9})),
                   _hsMat('rf'+ri, ()=>new THREE.MeshStandardMaterial({map:_roofTex(ri), roughness:0.95})) ];
  const roof=new THREE.Mesh(_gableGeo(W+ov*2, L+ov*2, rh), roofMats); roof.position.y=TOP+H-0.002; roof.castShadow=true; g.add(roof);
  if(chimney){ const ch=new THREE.Mesh(new THREE.BoxGeometry(0.026,rh*0.9,0.026), _hsMat('chim', ()=>mat(0x7d7064,{roughness:1})));
    ch.position.set(W*0.18, TOP+H+rh*0.62, (r()<0.5?-1:1)*L*0.3); ch.castShadow=true; g.add(ch); }
  return g; }
function house(x,z,rot,tall,r){ r=r||Math.random; const g=new THREE.Group();
  if(tall){                                                    // town house / castle hall: two storeys, often stone, tile or slate roof
    const W=0.13+r()*0.05, L=0.17+r()*0.1, H=0.2+r()*0.07, st=(r()<0.35?4:(r()*6)|0), ri=2+((r()*4)|0);
    g.add(_building(W, L, H, 2, st, ri, r, r()<0.8));
    if(r()<0.35){ const L2=L*0.5, w2=_building(W*0.9, L2, H*0.62, 1, st, ri, r, false); w2.position.set(0, 0, L/2+L2/2-0.004); g.add(w2); }   // lower wing continuing the ridge line
  } else {                                                     // cottage: one storey, thatch or tile, sometimes an L-shaped lean-to wing
    const W=0.1+r()*0.035, L=0.14+r()*0.07, H=0.075+r()*0.025, st=(r()*6)|0, ri=(r()<0.55?((r()*2)|0):2+((r()*4)|0));
    g.add(_building(W, L, H, 1, st, ri, r, true));
    if(r()<0.4){ const L2=L*0.45, w2=_building(W*0.84, L2, H*0.78, 1, st, ri, r, false); w2.position.set(0, 0, L/2+L2/2-0.004); g.add(w2); }   // a lower byre / lean-to on the gable end
  }
  g.position.set(x,0,z); g.rotation.y=rot; return g; }
// a little garden plot / woodpile beside a cottage (flat, cheap)
function _garden(x,z,rot,r){ const g=new THREE.Group();
  const p=new THREE.Mesh(new THREE.BoxGeometry(0.09,0.012,0.12), mat([0x6b4f2e,0x5d7a34,0x7a8a3a][(r()*3)|0],{roughness:1})); p.position.set(0,TOP+0.006,0); g.add(p);
  const rail=mat(0x8a6a44,{roughness:1});
  for(const [sx,sz,lx,lz] of [[0,-0.062,0.1,0.008],[0,0.062,0.1,0.008],[-0.05,0,0.008,0.13],[0.05,0,0.008,0.13]]){ const f=new THREE.Mesh(new THREE.BoxGeometry(lx,0.022,lz), rail); f.position.set(sx,TOP+0.018,sz); g.add(f); }
  g.position.set(x,0,z); g.rotation.y=rot; return g; }
/* ===================== MODERN PACK — buildings & street furniture =====================
   Downtown towers (glass curtain walls, setbacks, rooftop plant), apartment blocks, main-street shops with awnings,
   suburban homes (siding, shingle roof, garage + driveway, the odd pool), church with steeple, brick school with
   flagpole, railway station, parking lots with cars, parks, sports fields, farmsteads (farmhouse, red barn, silo),
   wind turbines, water tower, grain elevator. Facade textures + materials are cached like the cottages. */
const _mc={};
const _mTex=(key,w,h,draw)=>_mc[key]||(_mc[key]=_hsCanvas(w,h,draw));
const _mMat=(key,make)=>_mc['m'+key]||(_mc['m'+key]=make());
const _mCol=(hex,opts)=>_mMat('c'+hex+(opts?JSON.stringify(opts):''),()=>mat(hex,opts));
// window-grid facade: cols × floors, glass or punched windows on a wall colour
function _facade(kind, cols, floors, base, glass){ const key='f'+kind+cols+'x'+floors+base+glass;
  return _mTex(key, cols*16, floors*16, (x,W,H)=>{ x.fillStyle=base; x.fillRect(0,0,W,H);
    for(let f=0;f<floors;f++) for(let c=0;c<cols;c++){ const px=c*16, py=f*16;
      if(kind==='glass'){ const lit=((c*7+f*13)%11)===0; x.fillStyle=lit?'#e8d79a':glass; x.fillRect(px+1,py+2,14,12);
        x.fillStyle='rgba(255,255,255,.18)'; x.fillRect(px+1,py+2,6,12); }
      else if(kind==='punched'){ x.fillStyle=((c*5+f*3)%9)===0?'#e6cf8a':glass; x.fillRect(px+4,py+4,8,9); x.fillStyle='rgba(255,255,255,.35)'; x.fillRect(px+4,py+12,8,1.5); }
      else if(kind==='balcony'){ x.fillStyle=glass; x.fillRect(px+3,py+3,10,9); x.fillStyle='rgba(0,0,0,.28)'; x.fillRect(px+1,py+12,14,3); } }
    if(kind==='glass'){ x.fillStyle='rgba(0,0,0,.25)'; for(let f=0;f<=floors;f++) x.fillRect(0,f*16-1,W,2); } }); }
function _storefront(ci){ const awn=['#b8322b','#2f6f9a','#3d8a4a','#d08a2a','#6b4a8a'][ci%5];
  return _mTex('sf'+ci,128,64,(x,W,H)=>{ x.fillStyle=['#d9cdb4','#b9776a','#c9c6bf','#e2d6bf','#9fb2b8'][ci%5]; x.fillRect(0,0,W,H);
    x.fillStyle='#2c3a48'; x.fillRect(6,34,W-12,26);                                    // shop windows
    x.fillStyle='rgba(255,255,255,.2)'; x.fillRect(6,34,30,26); x.fillStyle='#4a3424'; x.fillRect(W/2-8,36,16,26);   // door
    for(let i=0;i<8;i++){ x.fillStyle=i%2?awn:'#f2efe6'; x.fillRect(i*W/8,24,W/8,9); }   // striped awning
    x.fillStyle='#2b2b2b'; x.fillRect(20,8,W-40,12); x.fillStyle='#f3e3a0'; for(let i=0;i<6;i++) x.fillRect(28+i*12,12,7,4); }); }   // sign board
function _boxB(w,h,d,mats){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mats); m.castShadow=true; m.receiveShadow=true; return m; }
function _roofPlant(g,w,d,y,r){ const n=1+((r()*3)|0); for(let i=0;i<n;i++){ const b=_boxB(w*(0.18+r()*0.2),0.03+r()*0.03,d*(0.18+r()*0.2),_mCol(0x8f9296)); b.position.set((r()-0.5)*w*0.5,y+0.02,(r()-0.5)*d*0.5); g.add(b); } }
function _skyscraper(x,z,h,r){ const g=new THREE.Group(); const w=0.17+r()*0.1, d=w*(0.75+r()*0.4);
  const st=[['#46586a','#7fa3c4'],['#5c6770','#9fb6c6'],['#3a4f5f','#5f8fb8'],['#8a8f94','#3d5266'],['#6d5a4b','#8fb0c8']][(r()*5)|0];
  const floors=Math.max(4,Math.round(h/0.045)), low=h*(h>0.7?0.62+r()*0.15:1);
  const fm=(ww,ff)=>_mMat('tw'+st[0]+ww+'_'+ff,()=>new THREE.MeshStandardMaterial({map:_facade('glass',ww,ff,st[0],st[1]),roughness:0.35,metalness:0.35}));
  const roofM=_mCol(0x55595e);
  const f1=Math.max(2,Math.round(floors*low/h));
  const b=_boxB(w,low,d,[fm(4,f1),fm(4,f1),roofM,roofM,fm(3,f1),fm(3,f1)]); b.position.y=TOP+low/2; g.add(b);
  let top=TOP+low;
  if(low<h){ const w2=w*0.72, d2=d*0.72, hh=h-low, f2=Math.max(2,floors-f1); const b2=_boxB(w2,hh,d2,[fm(3,f2),fm(3,f2),roofM,roofM,fm(2,f2),fm(2,f2)]); b2.position.y=top+hh/2; g.add(b2); top+=hh; }
  _roofPlant(g,w*0.7,d*0.7,top,r);
  if(h>1.0){ const a=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.006,0.22,5),_mCol(0xcfd3d6)); a.position.y=top+0.11; g.add(a); }
  g.position.set(x,0,z); g.rotation.y=Math.floor(r()*4)*Math.PI/2+(r()-0.5)*0.1; return g; }
function _apartments(x,z,r){ const g=new THREE.Group(); const w=0.26+r()*0.06, d=0.16+r()*0.04, floors=4+((r()*4)|0), h=floors*0.05;
  const base=['#a4553f','#c8b18e','#b9b7b0','#8e6a55','#d6cbb4'][(r()*5)|0], glass='#3a4656', kind=r()<0.5?'balcony':'punched';
  const fm=(c)=>_mMat('ap'+base+kind+c+floors,()=>new THREE.MeshStandardMaterial({map:_facade(kind,c,floors,base,glass),roughness:0.85}));
  const roofM=_mCol(0x4c4f54);
  const b=_boxB(w,h,d,[fm(3,),fm(3),roofM,roofM,fm(6),fm(6)]); b.position.y=TOP+h/2; g.add(b);
  const par=_boxB(w+0.01,0.015,d+0.01,_mCol(0x6d6f73)); par.position.y=TOP+h+0.007; g.add(par);
  _roofPlant(g,w*0.6,d*0.6,TOP+h,r);
  g.position.set(x,0,z); g.rotation.y=Math.atan2(z,-x)+Math.PI/2+(r()-0.5)*0.3; return g; }
function _shop(x,z,r){ const g=new THREE.Group(); const w=0.15+r()*0.05, d=0.12+r()*0.03, h=0.08+r()*0.07, ci=(r()*5)|0;
  const front=_mMat('shopf'+ci,()=>new THREE.MeshStandardMaterial({map:_storefront(ci),roughness:0.8}));
  const side=_mCol(['#d9cdb4','#b9776a','#c9c6bf','#e2d6bf','#9fb2b8'].map(c=>parseInt(c.slice(1),16))[ci],{roughness:0.9});
  const b=_boxB(w,h,d,[front,side,_mCol(0x55585c),side,side,side]); b.position.y=TOP+h/2; g.add(b);
  const ac=_boxB(0.03,0.02,0.03,_mCol(0x9a9da1)); ac.position.set(-w*0.2,TOP+h+0.01,0); g.add(ac);
  g.position.set(x,0,z); g.rotation.y=Math.atan2(z,-x)+(r()-0.5)*0.3; return g; }            // storefront (+x) faces the street through the middle
function roundTree(x,z,s,r){ const g=new THREE.Group(); s=s||1;
  const tr=new THREE.Mesh(new THREE.CylinderGeometry(0.01*s,0.014*s,0.07*s,5), trunkMat); tr.position.y=TOP+0.035*s; g.add(tr);
  const col=[0x3f7a34,0x4f8a3c,0x2f6a2c,0x5d8f3a][(r()*4)|0];
  const c=new THREE.Mesh(new THREE.IcosahedronGeometry(0.055*s,1), _mCol(col,{roughness:1,flatShading:true})); c.position.y=TOP+0.1*s; c.scale.y=0.9; c.castShadow=true; g.add(c);
  g.position.set(x,0,z); return g; }
function _homeModern(x,z,r,rot){ const g=new THREE.Group();
  const W=0.1+r()*0.03, L=0.15+r()*0.05, H=0.07+r()*0.02, st=6+((r()*6)|0), ri=6+((r()*3)|0), two=r()<0.35;
  const hb=_building(W,L,two?H*1.7:H,two?2:1,st,ri,r,r()<0.5); g.add(hb);
  const gw=0.085, gl=0.075, gh=0.055, gar=_boxB(gw,gh,gl,_mCol(parseInt(WALL_STYLES[st].base.slice(1),16),{roughness:0.9})); gar.position.set(0,TOP+gh/2,L/2+gl/2-0.005); g.add(gar);
  const gd=_boxB(0.004,gh*0.7,gl*0.8,_mCol(0xe8e8e2)); gd.position.set(gw/2+0.002,TOP+gh*0.35,L/2+gl/2-0.005); g.add(gd);           // garage door
  const gr=_boxB(gw+0.012,0.01,gl+0.01,_mCol(0x4a4c52)); gr.position.set(0,TOP+gh+0.005,L/2+gl/2-0.005); g.add(gr);
  const dw=new THREE.Mesh(new THREE.BoxGeometry(0.12,0.004,0.06), _mCol(0x9a9a98)); dw.position.set(gw/2+0.06,TOP+0.002,L/2+gl/2-0.005); g.add(dw);   // driveway
  if(r()<0.25){ const pool=new THREE.Mesh(new THREE.BoxGeometry(0.05,0.006,0.08), _mCol(0x3fb0d8,{roughness:0.2,metalness:0.2})); pool.position.set(-W/2-0.05,TOP+0.003,0); g.add(pool); }
  g.position.set(x,0,z); g.rotation.y=(rot!=null?rot:Math.atan2(z,-x))+(r()-0.5)*0.12; return g; }
function _church(r){ const g=new THREE.Group(); const b=_building(0.13,0.24,0.1,1,6,8,r,false); g.add(b);
  const t=_boxB(0.06,0.2,0.06,_mCol(0xf1efe8)); t.position.set(0,TOP+0.1,0.14); g.add(t);
  const sp=new THREE.Mesh(new THREE.ConeGeometry(0.045,0.16,4), _mCol(0x3c424c)); sp.position.set(0,TOP+0.28,0.14); sp.rotation.y=Math.PI/4; sp.castShadow=true; g.add(sp);
  const cr=_boxB(0.004,0.04,0.004,_mCol(0xd8c070)); cr.position.set(0,TOP+0.38,0.14); g.add(cr); const cr2=_boxB(0.02,0.004,0.004,_mCol(0xd8c070)); cr2.position.set(0,TOP+0.37,0.14); g.add(cr2);
  for(const [px,pz] of [[-0.2,-0.15],[0.18,-0.2],[-0.18,0.25]]) g.add(roundTree(px,pz,0.9,r));
  g.rotation.y=(r()-0.5)*0.4; return g; }
function _school(r){ const g=new THREE.Group(); const brick='#a4553f', fm=(c)=>_mMat('sch'+c,()=>new THREE.MeshStandardMaterial({map:_facade('punched',c,2,brick,'#3a4656'),roughness:0.85}));
  const roofM=_mCol(0x55585c);
  const a=_boxB(0.5,0.11,0.16,[fm(3),fm(3),roofM,roofM,fm(10),fm(10)]); a.position.set(0,TOP+0.055,-0.1); g.add(a);
  const b=_boxB(0.16,0.11,0.26,[fm(5),fm(5),roofM,roofM,fm(3),fm(3)]); b.position.set(-0.17,TOP+0.055,0.1); g.add(b);
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.004,0.24,5),_mCol(0xd8dadc)); pole.position.set(0.12,TOP+0.12,0.08); g.add(pole);
  const fl=new THREE.Mesh(new THREE.PlaneGeometry(0.05,0.03),_mCol(0x2f4f9a,{side:THREE.DoubleSide})); fl.position.set(0.145,TOP+0.22,0.08); g.add(fl);
  const bus=_boxB(0.1,0.035,0.028,_mCol(0xf2b600)); bus.position.set(0.12,TOP+0.018,0.22); g.add(bus);
  g.rotation.y=Math.floor(r()*4)*Math.PI/2; return g; }
function _parkedCars(g,r,rows){ const cols=[0xc0392b,0x2c3e50,0xecf0f1,0x7f8c8d,0x2980b9,0x27ae60,0xf1c40f,0x111111];
  const line=_mCol(0xf2f2f2);
  for(const zr of rows){ for(let i=0;i<7;i++){ const x=-0.33+i*0.11;
      const l=_boxB(0.005,0.002,0.1,line); l.position.set(x-0.055,TOP+0.004,zr); g.add(l);
      if(r()<0.68){ const c=new THREE.Group(), col=_mCol(cols[(r()*cols.length)|0],{roughness:0.4,metalness:0.3});
        const body=_boxB(0.05,0.018,0.085,col); body.position.y=TOP+0.012; c.add(body);
        const cab=_boxB(0.044,0.016,0.045,_mCol(0x2a3440,{roughness:0.2,metalness:0.4})); cab.position.set(0,TOP+0.028,0.004); c.add(cab);
        c.position.set(x,0,zr); c.rotation.y=(r()-0.5)*0.12; g.add(c); } } } }
function _lot(r){ const g=new THREE.Group(); _parkedCars(g,r,[-0.2,0.2]);
  for(const [px,pz] of [[-0.38,0],[0.38,0]]){ const p=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.004,0.16,5),_mCol(0x7c8084)); p.position.set(px,TOP+0.08,pz); g.add(p); }
  g.rotation.y=Math.floor(r()*2)*Math.PI/2; return g; }
function _park(r, n){ const g=new THREE.Group(); const path=new THREE.Mesh(new THREE.RingGeometry(0.2,0.24,24), _mCol(0xc9b98f,{roughness:1})); path.rotation.x=-Math.PI/2; path.position.y=TOP+0.004; g.add(path);
  if(r()<0.4){ const pond=new THREE.Mesh(new THREE.CircleGeometry(0.12,20), _mCol(0x4f9fcf,{roughness:0.15,metalness:0.2})); pond.rotation.x=-Math.PI/2; pond.position.y=TOP+0.005; g.add(pond); }
  else { const f=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.06,0.03,14), _mCol(0xb9b5ab)); f.position.y=TOP+0.015; g.add(f); }
  for(let i=0;i<(n||6);i++){ const a=i/(n||6)*Math.PI*2+r()*0.5, rr=0.3+r()*0.1; g.add(roundTree(Math.cos(a)*rr,Math.sin(a)*rr,0.9+r()*0.5,r)); }
  return g; }
function _sportsField(r){ const g=new THREE.Group();
  const fld=new THREE.Mesh(new THREE.PlaneGeometry(0.62,0.4), new THREE.MeshStandardMaterial({map:_mTex('pitch',128,84,(x,W,H)=>{ for(let i=0;i<8;i++){ x.fillStyle=i%2?'#4f8f3a':'#5a9c42'; x.fillRect(i*W/8,0,W/8,H); }
    x.strokeStyle='#f4f4f0'; x.lineWidth=2; x.strokeRect(4,4,W-8,H-8); x.beginPath(); x.moveTo(W/2,4); x.lineTo(W/2,H-4); x.stroke(); x.beginPath(); x.arc(W/2,H/2,12,0,6.28); x.stroke();
    x.strokeRect(4,H/2-16,16,32); x.strokeRect(W-20,H/2-16,16,32); }),roughness:1}));
  fld.rotation.x=-Math.PI/2; fld.position.y=TOP+0.005; g.add(fld);
  const bl=_boxB(0.3,0.04,0.05,_mCol(0x9aa0a6)); bl.position.set(0,TOP+0.02,-0.26); g.add(bl);
  g.rotation.y=Math.floor(r()*2)*Math.PI/2; return g; }
function _station(dirs, r){ const g=new THREE.Group(); const [ex,ez]=dirs[0]||[0.5,0], a=Math.atan2(ex,ez);
  const inner=new THREE.Group(); inner.rotation.y=a; g.add(inner);                          // local z = along the track
  const plat=_boxB(0.12,0.03,0.8,_mCol(0xb7b3aa)); plat.position.set(0.14,TOP+0.015,0); inner.add(plat);
  const can=_boxB(0.13,0.01,0.6,_mCol(0x7a2f2a)); can.position.set(0.14,TOP+0.12,0); inner.add(can);
  for(const pz of [-0.25,0,0.25]){ const p=_boxB(0.008,0.09,0.008,_mCol(0x3a3a3a)); p.position.set(0.14,TOP+0.075,pz); inner.add(p); }
  const bld=_building(0.14,0.3,0.1,1,13,8,r,true); bld.position.set(0.3,0,0); inner.add(bld);   // brick depot
  for(let i=0;i<3;i++){ const c=_trainCar('commuter',r); c.position.z=(i-1)*(CAR_L*1.08+CAR_GAP); inner.add(c); }   // commuter train at the platform
  return g; }
function _farmstead(r){ const g=new THREE.Group();
  const house=_building(0.1,0.15,0.08,2,6,6,r,true); house.position.set(-0.17,0,-0.12); house.rotation.y=Math.PI/2; g.add(house);
  const barn=_building(0.17,0.24,0.12,1,12,8,r,false); barn.position.set(0.12,0,0.06); g.add(barn);
  const silo=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.26,14),_mCol(0x9ea7ad,{metalness:0.3,roughness:0.5})); silo.position.set(0.28,TOP+0.13,-0.14); silo.castShadow=true; g.add(silo);
  const dome=new THREE.Mesh(new THREE.SphereGeometry(0.04,14,8,0,Math.PI*2,0,Math.PI/2),_mCol(0xc9ced2,{metalness:0.4,roughness:0.4})); dome.position.set(0.28,TOP+0.26,-0.14); g.add(dome);
  g.add(roundTree(-0.3,0.22,1.1,r)); g.add(roundTree(-0.05,0.3,0.9,r));
  g.rotation.y=Math.floor(r()*4)*Math.PI/2; return g; }
function _turbine(x,z,r,yaw){ const g=new THREE.Group(); const H=0.95, white=_mCol(0xf2f4f5,{roughness:0.5});
  const t=new THREE.Mesh(new THREE.CylinderGeometry(0.009,0.018,H,8),white); t.position.y=TOP+H/2; t.castShadow=true; g.add(t);
  const hub=new THREE.Group(); hub.position.y=TOP+H; hub.rotation.y=yaw; g.add(hub);
  const nac=_boxB(0.03,0.028,0.07,white); nac.position.z=-0.015; hub.add(nac);
  const rot=new THREE.Group(); rot.position.z=0.024; rot.rotation.z=r()*Math.PI*2; hub.add(rot);
  for(let i=0;i<3;i++){ const bl=_boxB(0.018,0.3,0.006,white); bl.position.y=0.15; const arm=new THREE.Group(); arm.rotation.z=i*Math.PI*2/3; arm.add(bl); rot.add(arm); }
  g.position.set(x,0,z); return g; }
function _waterTower(r){ const g=new THREE.Group(); const legM=_mCol(0x8f9aa3,{metalness:0.4});
  for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const l=new THREE.Mesh(new THREE.CylinderGeometry(0.006,0.006,0.4,5),legM); l.position.set(sx*0.06,TOP+0.2,sz*0.06); g.add(l); }
  const tank=new THREE.Mesh(new THREE.CylinderGeometry(0.11,0.1,0.12,20),_mCol(0xdfe7ec,{metalness:0.3,roughness:0.4})); tank.position.y=TOP+0.46; tank.castShadow=true; g.add(tank);
  const roof=new THREE.Mesh(new THREE.ConeGeometry(0.115,0.06,20),_mCol(0xc9d2d8,{metalness:0.3})); roof.position.y=TOP+0.55; g.add(roof);
  const band=new THREE.Mesh(new THREE.CylinderGeometry(0.112,0.112,0.02,20),_mCol(0x2f5f9a)); band.position.y=TOP+0.46; g.add(band);
  g.add(roundTree(-0.3,0.2,1,r)); g.add(roundTree(0.28,-0.25,1,r)); return g; }
function _elevator(r, dirs){ const g=new THREE.Group(); const conc=_mCol(0xcac6bd,{roughness:0.9});
  const [ex,ez]=(dirs&&dirs[0])||[0,0.5], inner=new THREE.Group(); inner.rotation.y=Math.atan2(ex,ez); g.add(inner);   // local z = along the track
  for(let i=0;i<4;i++){ const c=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.42,16),conc); c.position.set(0.24,TOP+0.21,-0.15+i*0.1); c.castShadow=true; inner.add(c); }
  const head=_boxB(0.1,0.12,0.12,conc); head.position.set(0.24,TOP+0.48,0.02); inner.add(head);
  const spout=new THREE.Mesh(new THREE.CylinderGeometry(0.006,0.006,0.3,5),_mCol(0x7c8084)); spout.position.set(0.12,TOP+0.33,0.02); spout.rotation.z=0.9; inner.add(spout);
  const shed=_boxB(0.12,0.07,0.18,_mCol(0x8a3a2e)); shed.position.set(-0.26,TOP+0.035,0.1); inner.add(shed);
  for(let i=0;i<3;i++){ const h=_trainCar('hopper',r); h.position.z=(i-1)*(CAR_L+CAR_GAP); inner.add(h); }       // grain hoppers being loaded
  return g; }
function _streetside(group, r){ for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ if(r()<0.75) group.add(roundTree(sx*0.34,sz*0.34,0.8+r()*0.3,r));
    else { const p=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.004,0.12,5),_mCol(0x3c3f44)); p.position.set(sx*0.3,TOP+0.06,sz*0.3); group.add(p); } } }
function _plaza(r){ const g=new THREE.Group(); const f=new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.11,0.035,20),_mCol(0xb5b1a8)); f.position.y=TOP+0.018; g.add(f);
  const w=new THREE.Mesh(new THREE.CircleGeometry(0.085,20),_mCol(0x5fb0dc,{roughness:0.1,metalness:0.3})); w.rotation.x=-Math.PI/2; w.position.y=TOP+0.037; g.add(w);
  const s=new THREE.Mesh(new THREE.CylinderGeometry(0.01,0.02,0.07,8),_mCol(0xb5b1a8)); s.position.y=TOP+0.07; g.add(s);
  for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]) g.add(roundTree(sx*0.3,sz*0.3,0.8,r)); return g; }
/* ---- RAILWAY ROLLING STOCK (Modern Pack) — cars are built along local +z (the track), sitting on the rails ---- */
const CAR_L=0.2, CAR_GAP=0.018, RAIL_Y=0.04;
function _bogies(g,len){ const m=_mCol(0x222326,{roughness:0.8}); for(const s of [-1,1]){ const b=_boxB(0.05,0.018,0.055,m); b.position.set(0,TOP+RAIL_Y+0.009,s*len*0.32); g.add(b); } }
function _trainCar(kind, r){ const g=new THREE.Group(), y0=TOP+RAIL_Y+0.018;
  if(kind==='loco'){ const liv=[[0xf2b600,0x1d1d1f],[0x1f4e8c,0xd9dde2],[0xb8322b,0x2a2a2a],[0x2f6b3a,0xf2b600]][(r()*4)|0];
    const body=_boxB(0.066,0.062,CAR_L*0.96,_mCol(liv[0],{roughness:0.5})); body.position.set(0,y0+0.031,0); g.add(body);
    const stripe=_boxB(0.068,0.012,CAR_L*0.96,_mCol(liv[1])); stripe.position.set(0,y0+0.022,0); g.add(stripe);
    const cab=_boxB(0.068,0.024,0.05,_mCol(liv[0],{roughness:0.5})); cab.position.set(0,y0+0.074,CAR_L*0.3); g.add(cab);
    const win=_boxB(0.07,0.012,0.03,_mCol(0x1c2733,{roughness:0.2,metalness:0.4})); win.position.set(0,y0+0.078,CAR_L*0.31); g.add(win);
    const roof=_boxB(0.05,0.01,CAR_L*0.5,_mCol(0x55585c)); roof.position.set(0,y0+0.067,-CAR_L*0.12); g.add(roof); }
  else if(kind==='tanker'){ const t=new THREE.Mesh(new THREE.CylinderGeometry(0.032,0.032,CAR_L*0.92,14),_mCol([0x1d1d1f,0xdfe3e6,0x3b5a7a][(r()*3)|0],{roughness:0.4,metalness:0.3}));
    t.rotation.x=Math.PI/2; t.position.set(0,y0+0.036,0); t.castShadow=true; g.add(t);
    const dome=_boxB(0.02,0.012,0.02,_mCol(0x55585c)); dome.position.set(0,y0+0.072,0); g.add(dome);
    const deck=_boxB(0.06,0.006,CAR_L*0.96,_mCol(0x2a2a2c)); deck.position.set(0,y0+0.003,0); g.add(deck); }
  else if(kind==='hopper'){ const c=_mCol([0x8f9398,0xb9a37a,0x6d7b8a][(r()*3)|0],{roughness:0.6});
    const b=_boxB(0.066,0.05,CAR_L*0.94,c); b.position.set(0,y0+0.035,0); g.add(b);
    const top=_boxB(0.056,0.004,CAR_L*0.84,_mCol(0xc9b27a)); top.position.set(0,y0+0.061,0); g.add(top);                   // a load of grain
    for(const s of [-1,1]){ const h=new THREE.Mesh(new THREE.ConeGeometry(0.03,0.03,4),c); h.rotation.x=Math.PI; h.rotation.y=Math.PI/4; h.position.set(0,y0+0.004,s*CAR_L*0.22); g.add(h); } }
  else if(kind==='commuter'){ const body=_boxB(0.068,0.07,CAR_L*1.08,_mCol(0xc9ced4,{roughness:0.35,metalness:0.45})); body.position.set(0,y0+0.035,0); g.add(body);
    const band=_boxB(0.07,0.016,CAR_L*1.02,_mCol(0x1c2733,{roughness:0.2,metalness:0.4})); band.position.set(0,y0+0.048,0); g.add(band);
    const st=_boxB(0.07,0.007,CAR_L*1.08,_mCol(0xb8322b)); st.position.set(0,y0+0.02,0); g.add(st); }
  else { const col=[0x8a3a2e,0x6b4a2e,0x2f5f7a,0x7a6a3a,0x4a5a3a][(r()*5)|0];                                        // boxcar
    const b=_boxB(0.066,0.068,CAR_L*0.96,_mCol(col,{roughness:0.8})); b.position.set(0,y0+0.034,0); g.add(b);
    const door=_boxB(0.068,0.05,0.05,_mCol(new THREE.Color(col).multiplyScalar(0.75).getHex())); door.position.set(0,y0+0.032,0); g.add(door);
    const roof=_boxB(0.07,0.005,CAR_L*0.98,_mCol(0x55585c)); roof.position.set(0,y0+0.07,0); g.add(roof); }
  _bogies(g, CAR_L); return g; }
// flat 2D car: a coloured bar
function _trainCarFlat(kind, r){ const cols={loco:0xf2b600,tanker:0x1d1d1f,hopper:0x8f9398,commuter:0xc9ced4,boxcar:0x8a3a2e};
  const d=flatDecal(0.07, CAR_L*0.96, cols[kind]||0x8a3a2e, 0.98); d.position.y=TOP+0.056; const g=new THREE.Group(); g.add(d); return g; }
// a train of `kinds` laid along world points [{x,z}] (scene frame) — follows the curve of the track. `avoid` = points to keep away from.
export function trainAlong(points, seed, avoid, kinds){
  if(!points || points.length<2) return null;
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(p.x,0,p.z)), false, 'centripetal', 0.5), L=curve.getLength();
  const r=rng32(((seed||1)*2654435761)>>>0), sc=_scale==='battle'?28:1, step=(CAR_L+CAR_GAP)*sc;   // battle: a boxcar ≈ 30 ft
  if(!kinds){ kinds=['loco']; const n=Math.max(3,Math.min(9,Math.floor(L*0.45/step))); if(r()<0.35) kinds.push('loco');
    for(let i=kinds.length;i<n;i++) kinds.push(['boxcar','tanker','hopper','boxcar','hopper'][(r()*5)|0]); }
  const span=kinds.length*step; if(span>L*0.92) return null;
  let bestS=(L-span)/2, bestD=-1;                                                                              // where the whole train is farthest from `avoid`
  for(let i=0;i<=10;i++){ const s0=(L-span)*(0.08+0.84*i/10), mid=curve.getPointAt(Math.min(1,(s0+span/2)/L));
    let d=Infinity; for(const a of (avoid||[])) d=Math.min(d, Math.hypot(mid.x-a.x, mid.z-a.z)); if(!avoid||!avoid.length) d=1-Math.abs(i-5)/5+r()*0.2; if(d>bestD){ bestD=d; bestS=s0; } }
  const grp=new THREE.Group(); grp.name='train';
  kinds.forEach((k,i)=>{ const u=Math.min(1,Math.max(0,(bestS+step*(i+0.5))/L)), p=curve.getPointAt(u), t=curve.getTangentAt(u);
    const car=_flat?_trainCarFlat(k,r):_trainCar(k,r); car.scale.setScalar(sc); if(sc!==1) car.position.y=-TOP*(sc-1);
    const hold=new THREE.Group(); hold.add(car); hold.position.set(p.x,0,p.z); hold.rotation.y=Math.atan2(t.x,t.z)+(i===0?Math.PI:0)*0; grp.add(hold); });
  return grp; }
// a short string of cars sitting on a tile's own track (station commuter train, hoppers at the grain elevator)
function _tileTrain(dirs, kinds, r, flat){ const g=new THREE.Group(); const [ex,ez]=dirs[0]||[0,0.5], inner=new THREE.Group(); inner.rotation.y=Math.atan2(ex,ez); g.add(inner);
  const step=CAR_L+CAR_GAP, n=kinds.length; kinds.forEach((k,i)=>{ const c=flat?_trainCarFlat(k,r):_trainCar(k,r); c.position.z=(i-(n-1)/2)*step; inner.add(c); }); return g; }

/* ---- LANDMARK SKYSCRAPER — an N×N-square block (2×2 … 4×4; hex 7/19/37), like the keep: podium, a glass shaft with
   setbacks, a lit crown and a spire; the block round it is a paved plaza with trees ---- */
function _supertall(gridKind, N, r){ const g=new THREE.Group();
  const k = gridKind==='hex' ? 0.62*(2*N-1)*0.72 : N*0.92, H=1.5+N*0.75;
  const st=[['#3f566b','#8fb4d6'],['#4b5963','#a9c3d3'],['#2f4658','#6f9fc9']][(r()*3)|0];
  const fm=(c,f)=>_mMat('st'+st[0]+c+'_'+f,()=>new THREE.MeshStandardMaterial({map:_facade('glass',c,f,st[0],st[1]),roughness:0.25,metalness:0.45}));
  const roofM=_mCol(0x55595e);
  const pod=_boxB(0.62*k,0.08,0.62*k,_mCol(0xb5b3ad)); pod.position.y=TOP+0.04; g.add(pod);                         // podium / lobby
  const tiers=[[0.44,0.55],[0.35,0.25],[0.26,0.12]]; let y=TOP+0.08, total=0;                                    // [width fraction, height fraction]
  tiers.forEach(([wf,hf],i)=>{ const w=wf*k, h=H*hf, fl=Math.max(3,Math.round(h/0.045)), cols=Math.max(3,Math.round(w/0.04));
    const b=_boxB(w,h,w,[fm(cols,fl),fm(cols,fl),roofM,roofM,fm(cols,fl),fm(cols,fl)]); b.position.y=y+h/2; g.add(b);
    const band=_boxB(w*1.02,0.012,w*1.02,_mCol(0xd8dde2,{metalness:0.5,roughness:0.3})); band.position.y=y+h; g.add(band); y+=h; total+=h; });
  const crown=new THREE.Mesh(new THREE.ConeGeometry(0.26*k*0.55,0.3+N*0.05,4),_mCol(0xcfd8e0,{metalness:0.6,roughness:0.25})); crown.rotation.y=Math.PI/4; crown.position.y=y+0.15+N*0.025; g.add(crown);
  const spire=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.012,0.45+N*0.1,6),_mCol(0xe6e9ec,{metalness:0.6})); spire.position.y=y+0.3+N*0.05+0.22+N*0.05; g.add(spire);
  const lamp=new THREE.Mesh(new THREE.SphereGeometry(0.018,8,6),new THREE.MeshBasicMaterial({color:0xff4a3a})); lamp.position.y=spire.position.y+0.24+N*0.05; g.add(lamp);
  // plaza: trees + benches round the edge of the block
  const half=gridKind==='hex' ? (N-0.5)*0.75 : N/2-0.18, nT=6*N;
  for(let i=0;i<nT;i++){ const a=i/nT*Math.PI*2, rr=half*(gridKind==='hex'?0.9:1)/Math.max(Math.abs(Math.cos(a)),Math.abs(Math.sin(a)))*(gridKind==='hex'?Math.max(Math.abs(Math.cos(a)),Math.abs(Math.sin(a))):1);
    g.add(roundTree(Math.cos(a)*rr,Math.sin(a)*rr,0.9,r)); }
  return g; }
/* ---- STADIUM — an oval bowl over W×H squares (4–16 cells; hex = 7): pitch + running track, three tiers of seats,
   an outer concourse wall, floodlight towers and a scoreboard ---- */
function _stadium(gridKind, W, H, r){ const g=new THREE.Group();
  const a=(gridKind==='hex'?1.05:W*0.47), b=(gridKind==='hex'?0.95:H*0.47);                                    // outer radii (x, z)
  const ell=(ra,rb,n)=>{ const s=new THREE.Shape(); for(let i=0;i<=n;i++){ const t=i/n*Math.PI*2; const x=Math.cos(t)*ra, y=Math.sin(t)*rb; i?s.lineTo(x,y):s.moveTo(x,y); } return s; };
  const ring=(ro,ri,h,col,y)=>{ const s=ell(a*ro,b*ro,48), hole=new THREE.Path(); for(let i=0;i<=48;i++){ const t=-i/48*Math.PI*2; const x=Math.cos(t)*a*ri, yy=Math.sin(t)*b*ri; i?hole.lineTo(x,yy):hole.moveTo(x,yy); } s.holes.push(hole);
    const geo=new THREE.ExtrudeGeometry(s,{depth:h,bevelEnabled:false}); geo.rotateX(-Math.PI/2); const m=new THREE.Mesh(geo,_mCol(col,{roughness:0.8})); m.position.y=y; m.castShadow=true; m.receiveShadow=true; g.add(m); };
  const team=[[0x2f5f9a,0xd9dde2],[0xb8322b,0xf2efe6],[0x2f6b3a,0xf2b600]][(r()*3)|0];
  const hS=Math.min(W,H)*0.045+0.03;
  ring(1.0,0.93,hS*3.2,0x9ea2a8,TOP);                                                                           // outer concourse wall
  ring(0.93,0.8,hS*2.6,team[0],TOP); ring(0.8,0.7,hS*1.8,team[1],TOP); ring(0.7,0.61,hS*1.0,team[0],TOP);        // three tiers of seats stepping up
  const trk=new THREE.Mesh(new THREE.ShapeGeometry(ell(a*0.61,b*0.61,48)),_mCol(0xa4523b,{roughness:1})); trk.rotation.x=-Math.PI/2; trk.position.y=TOP+0.026; g.add(trk);   // running track
  const pw=a*1.02, ph=b*0.8, pitch=new THREE.Mesh(new THREE.PlaneGeometry(pw,ph), new THREE.MeshStandardMaterial({map:_mTex('pitch',128,84,(x,W2,H2)=>{ for(let i=0;i<8;i++){ x.fillStyle=i%2?'#4f8f3a':'#5a9c42'; x.fillRect(i*W2/8,0,W2/8,H2); }
    x.strokeStyle='#f4f4f0'; x.lineWidth=2; x.strokeRect(4,4,W2-8,H2-8); x.beginPath(); x.moveTo(W2/2,4); x.lineTo(W2/2,H2-4); x.stroke(); x.beginPath(); x.arc(W2/2,H2/2,12,0,6.28); x.stroke();
    x.strokeRect(4,H2/2-16,16,32); x.strokeRect(W2-20,H2/2-16,16,32); }),roughness:1}));
  pitch.rotation.x=-Math.PI/2; pitch.position.y=TOP+0.03; g.add(pitch);
  for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const px=sx*a*0.98*0.72, pz=sz*b*0.98*0.72, hh=hS*3.2+0.35+Math.min(W,H)*0.05;   // floodlights
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.008,0.014,hh,6),_mCol(0xb8bcc0,{metalness:0.4})); pole.position.set(px,TOP+hh/2,pz); g.add(pole);
    const lamp=_boxB(0.09,0.05,0.02,new THREE.MeshBasicMaterial({color:0xfff5cf})); lamp.position.set(px,TOP+hh,pz); lamp.rotation.y=Math.atan2(-px,-pz); g.add(lamp); }
  const sb=_boxB(Math.min(a,0.5),0.14,0.03,_mCol(0x1c1e22)); sb.position.set(0,TOP+hS*3.2+0.09,-b*0.97); g.add(sb);
  const scr=_boxB(Math.min(a,0.5)*0.85,0.1,0.032,new THREE.MeshBasicMaterial({color:0x2f7fd0})); scr.position.set(0,TOP+hS*3.2+0.09,-b*0.97+0.002); g.add(scr);
  return g; }
function _stadiumFlat(gridKind, W, H){ const g=new THREE.Group(), a=(gridKind==='hex'?1.05:W*0.47), b=(gridKind==='hex'?0.95:H*0.47);
  const disc=(ra,rb,c,y)=>{ const m=new THREE.Mesh(new THREE.CircleGeometry(1,40),new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:0.98,depthWrite:false})); m.rotation.x=-Math.PI/2; m.scale.set(ra,rb,1); m.position.y=TOP+y; m.renderOrder=3; g.add(m); };
  disc(a,b,0x9ea2a8,0.05); disc(a*0.93,b*0.93,0x2f5f9a,0.051); disc(a*0.7,b*0.7,0xa4523b,0.052); disc(a*0.6,b*0.6,0x4f8f3a,0.053); return g; }
// normalise a modern feature id: homes<d> → homes · skyscraper<N> → skyscraper · stadium<W>x<H> / stadiumh → stadium
function _modernBase(f){ f=String(f||''); let m;
  if((m=/^homes(\d)$/.exec(f))) return {f:'homes', face:+m[1]};
  if((m=/^skyscraper(\d)$/.exec(f))) return {f:'skyscraper', n:+m[1]};
  if((m=/^stadium(\d)x(\d)$/.exec(f))) return {f:'stadium', w:+m[1], h:+m[2]};
  if(f==='stadiumh') return {f:'stadium', w:2, h:2, hex:true};
  if((m=/^(airport|military|spacehub)(\d)x(\d)$/.exec(f))) return {f:m[1], w:+m[2], h:+m[3]};
  if((m=/^(airport|military|spacehub)h$/.exec(f))) return {f:m[1], w:2, h:2, hex:true};
  if((m=/^port(\d)x(\d)d(\d)$/.exec(f))) return {f:'port', w:+m[1], h:+m[2], dir:+m[3]};
  if((m=/^porthd(\d)$/.exec(f))) return {f:'port', w:2, h:2, dir:+m[1], hex:true};
  if((m=/^powerplant(\d)x(\d)$/.exec(f))) return {f:'powerplant', w:+m[1], h:+m[2]};
  if(f==='powerplanth') return {f:'powerplant', w:2, h:2, hex:true};
  if((m=/^(marina|pier)(\d)$/.exec(f))) return {f:m[1], dir:+m[2]};
  if(f==='beachhouse') return {f:'homes'};
  if((m=/^hotel(\d)$/.exec(f))) return {f:'hotel', face:+m[1]};
  return {f}; }
/* ===== BIG SITES (Modern Pack): airport · military base · space hub · sea port — each over a W×H block (hex: 7 hexes) ===== */
const _siteExt=(gk,w,h)=> gk==='hex' ? [2.3,2.3] : [w*0.94, h*0.94];
// a plane lying flat on the ground (local: long axis = x)
function _flatPlane(len, wid, col, y){ const m=new THREE.Mesh(new THREE.PlaneGeometry(len,wid), col.isMaterial?col:_mCol(col,{roughness:0.95})); m.rotation.x=-Math.PI/2; m.position.y=TOP+(y||0.026); m.receiveShadow=true; return m; }
function _airliner(r){ const g=new THREE.Group(), white=_mCol(0xf2f4f6,{roughness:0.4}), tail=_mCol([0x1f4e8c,0xb8322b,0x2f7a4a,0xe0a020][(r()*4)|0]);
  const f=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.02,0.24,10),white); f.rotation.z=Math.PI/2; f.position.y=TOP+0.035; f.castShadow=true; g.add(f);
  const nose=new THREE.Mesh(new THREE.SphereGeometry(0.02,10,8),white); nose.position.set(0.12,TOP+0.035,0); g.add(nose);
  const wing=_boxB(0.05,0.004,0.26,white); wing.position.set(0.01,TOP+0.03,0); g.add(wing);
  const fin=_boxB(0.04,0.05,0.004,tail); fin.position.set(-0.1,TOP+0.065,0); g.add(fin);
  const stab=_boxB(0.03,0.003,0.09,white); stab.position.set(-0.105,TOP+0.042,0); g.add(stab);
  for(const s of [-1,1]){ const e=new THREE.Mesh(new THREE.CylinderGeometry(0.008,0.008,0.03,8),_mCol(0x9aa0a6)); e.rotation.z=Math.PI/2; e.position.set(0.02,TOP+0.022,s*0.06); g.add(e); }
  return g; }
function _hangar(len, wid, col){ const g=new THREE.Group(); const m=new THREE.Mesh(new THREE.CylinderGeometry(wid/2,wid/2,len,16,1,false,0,Math.PI),_mCol(col,{roughness:0.6,metalness:0.3}));
  m.rotation.z=Math.PI/2; m.rotation.y=Math.PI/2; m.position.y=TOP; m.castShadow=true; g.add(m); return g; }
function _airport(gk,w,h,r){ const g=new THREE.Group(), [ex,ez]=_siteExt(gk,w,h), L=Math.max(ex,ez), S=Math.min(ex,ez), inner=new THREE.Group(); if(ez>ex) inner.rotation.y=Math.PI/2; g.add(inner);
  const rw=_mMat('runway',()=>new THREE.MeshStandardMaterial({roughness:0.9,map:_mTex('runway',256,32,(x,W,H)=>{ x.fillStyle='#35373b'; x.fillRect(0,0,W,H);
    x.fillStyle='#f2f2ee'; for(let i=0;i<W;i+=18) x.fillRect(i+30,H/2-1,10,2); for(const x0 of [4,W-16]) for(let j=0;j<6;j++) x.fillRect(x0,4+j*4.2,12,2.4);
    x.fillRect(0,1,W,1); x.fillRect(0,H-2,W,1); })}));
  const run=_flatPlane(L*0.97, S*0.24, rw, 0.028); run.position.z=S*0.2; inner.add(run);
  const tx=_flatPlane(L*0.8, S*0.07, 0x55585c, 0.027); tx.position.z=S*0.02; inner.add(tx);
  const ty=_flatPlane(L*0.8, 0.006, 0xe8c230, 0.029); ty.position.z=S*0.02; inner.add(ty);
  const glass=_mMat('termglass',()=>new THREE.MeshStandardMaterial({color:0x6f93b5,roughness:0.2,metalness:0.5}));
  const term=_boxB(L*0.42,0.07,S*0.14,[glass,glass,_mCol(0xd9dde2),_mCol(0xd9dde2),glass,glass]); term.position.set(-L*0.05,TOP+0.035,-S*0.3); inner.add(term);
  const roof=_boxB(L*0.44,0.012,S*0.17,_mCol(0xe9ecee)); roof.position.set(-L*0.05,TOP+0.076,-S*0.3); inner.add(roof);
  const tw=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.026,0.42,10),_mCol(0xd9dde2)); tw.position.set(L*0.3,TOP+0.21,-S*0.3); inner.add(tw);
  const cab=new THREE.Mesh(new THREE.CylinderGeometry(0.045,0.035,0.05,10),glass); cab.position.set(L*0.3,TOP+0.44,-S*0.3); inner.add(cab);
  const cr=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.01,10),_mCol(0x55585c)); cr.position.set(L*0.3,TOP+0.47,-S*0.3); inner.add(cr);
  for(let i=0;i<2;i++){ const hg=_hangar(0.28,0.2,0xb7bcc2); hg.position.set(-L*0.36+i*0.26,0,-S*0.28); inner.add(hg); }
  for(let i=0;i<3;i++){ const p=_airliner(r); p.position.set(-L*0.2+i*0.3,0,-S*0.13); p.rotation.y=-Math.PI/2; inner.add(p); }        // at the gates
  const tk=_airliner(r); tk.position.set(-L*0.3,0,S*0.2); inner.add(tk);                                                          // lined up for take-off
  return g; }
function _tank(r){ const g=new THREE.Group(), olive=_mCol([0x55603a,0x6b6b47,0x5a5a3c][(r()*3)|0],{roughness:0.8});
  const hull=_boxB(0.06,0.022,0.1,olive); hull.position.y=TOP+0.016; g.add(hull);
  const tr=_boxB(0.066,0.012,0.104,_mCol(0x2a2a26)); tr.position.y=TOP+0.006; g.add(tr);
  const tur=_boxB(0.04,0.016,0.045,olive); tur.position.set(0,TOP+0.035,-0.005); g.add(tur);
  const gun=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.004,0.07,6),olive); gun.rotation.x=Math.PI/2; gun.position.set(0,TOP+0.036,0.045); g.add(gun); return g; }
function _heli(r){ const g=new THREE.Group(), c=_mCol(0x4f5a3a,{roughness:0.6});
  const body=new THREE.Mesh(new THREE.SphereGeometry(0.03,10,8),c); body.scale.set(1,0.8,1.6); body.position.y=TOP+0.035; g.add(body);
  const boom=_boxB(0.012,0.012,0.1,c); boom.position.set(0,TOP+0.04,-0.08); g.add(boom);
  for(const a of [0,Math.PI/2]){ const b=_boxB(0.006,0.003,0.2,_mCol(0x222222)); b.position.y=TOP+0.07; b.rotation.y=a+0.4; g.add(b); } return g; }
function _military(gk,w,h,r){ const g=new THREE.Group(), [ex,ez]=_siteExt(gk,w,h), hx=ex/2*0.95, hz=ez/2*0.95, fence=_mCol(0x9aa0a6,{metalness:0.4});
  for(const [x0,z0,x1,z1] of [[-hx,-hz,hx,-hz],[hx,-hz,hx,hz],[hx,hz,-hx,hz],[-hx,hz,-hx,-hz]]){ const len=Math.hypot(x1-x0,z1-z0), f=_boxB(len,0.035,0.004,fence);
    f.position.set((x0+x1)/2,TOP+0.018,(z0+z1)/2); f.rotation.y=-Math.atan2(z1-z0,x1-x0); f.material.transparent=true; f.material.opacity=0.6; g.add(f); }
  for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const x=sx*hx, z=sz*hz;                                                    // watchtowers
    for(const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const l=_boxB(0.004,0.16,0.004,_mCol(0x5a4a3a)); l.position.set(x+a*0.015,TOP+0.08,z+b*0.015); g.add(l); }
    const cab=_boxB(0.05,0.03,0.05,_mCol(0x6b6b47)); cab.position.set(x,TOP+0.175,z); g.add(cab); const rf=_boxB(0.06,0.006,0.06,_mCol(0x3a3a34)); rf.position.set(x,TOP+0.195,z); g.add(rf); }
  const tan=_mCol(0xb3a585,{roughness:0.9}), olive=_mCol(0x707552,{roughness:0.9}), roofM=_mCol(0x55603a,{roughness:0.8});
  const pg=_flatPlane(ex*0.3, ez*0.28, 0x9a9488, 0.027); pg.rotation.z=0; pg.position.set(ex*0.02,0,-ez*0.08); g.add(pg);          // parade ground
  const nB=Math.max(4,Math.round(ez/0.4));
  for(let i=0;i<nB;i++){ const z=-hz*0.85+i*(hz*1.7/nB)+0.05;                                                                   // barracks rows
    const bb=_boxB(ex*0.26,0.055,0.085,i%2?tan:olive); bb.position.set(-ex*0.3,TOP+0.028,z); g.add(bb);
    const rf=new THREE.Mesh(new THREE.CylinderGeometry(0.047,0.047,ex*0.26,4,1),roofM); rf.rotation.z=Math.PI/2; rf.rotation.x=Math.PI/4; rf.scale.set(1,1,0.55); rf.position.set(-ex*0.3,TOP+0.06,z); g.add(rf); }
  const hq=_building(0.16,0.26,0.1,2,13,6,r,false); hq.position.set(ex*0.02,0,-hz*0.7); hq.rotation.y=Math.PI/2; g.add(hq);
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.004,0.3,5),_mCol(0xd8dadc)); pole.position.set(ex*0.02,TOP+0.15,-ez*0.08); g.add(pole);
  const fl=new THREE.Mesh(new THREE.PlaneGeometry(0.07,0.04),_mCol(0x2f4f9a,{side:THREE.DoubleSide})); fl.position.set(ex*0.02+0.035,TOP+0.28,-ez*0.08); g.add(fl);
  for(let i=0;i<2;i++){ const hg=_hangar(0.4,0.3,i?0x55603a:0x6b6b47); hg.position.set(ex*0.3,0,hz*0.25+i*0.36*(hz>0.9?1:0.8)-0.1); g.add(hg); }
  const pad=new THREE.Mesh(new THREE.CircleGeometry(0.13,24),_mCol(0x55585c)); pad.rotation.x=-Math.PI/2; pad.position.set(ex*0.3,TOP+0.027,-hz*0.55); g.add(pad);
  for(const [a2,b2,c,d] of [[-0.035,0,0.012,0.09],[0.035,0,0.012,0.09],[0,0,0.07,0.012]]){ const hb=_boxB(c,0.002,d,_mCol(0xf2f2ee)); hb.position.set(ex*0.3+a2,TOP+0.029,-hz*0.55+b2); g.add(hb); }
  const he=_heli(r); he.position.set(ex*0.3,0,-hz*0.55); g.add(he);
  const mp=_flatPlane(ex*0.34, ez*0.26, 0x6e6a60, 0.027); mp.position.set(ex*0.02,0,hz*0.55); g.add(mp);                          // motor pool
  for(let row=0;row<3;row++) for(let i=0;i<Math.max(3,Math.round(ex*0.34/0.1));i++){ const x=-ex*0.13+i*0.1, z=hz*0.4+row*0.14;
    if(row<2){ const t=_tank(r); t.position.set(x,0,z); g.add(t); }
    else { const tr=new THREE.Group(), c=_mCol(0x5a5a3c); const cab=_boxB(0.05,0.035,0.035,c); cab.position.set(0,TOP+0.024,0.045); tr.add(cab);
      const bed=_boxB(0.055,0.045,0.08,_mCol(0x6b6b47)); bed.position.set(0,TOP+0.03,-0.02); tr.add(bed); tr.position.set(x,0,z); g.add(tr); } }
  const mast=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.009,0.55,5),_mCol(0xb8322b)); mast.position.set(-ex*0.05,TOP+0.275,-hz*0.85); g.add(mast);
  const apr=_flatPlane(ex*0.3,0.26,0x55585c,0.027); apr.position.set(ex*0.3,0,-hz*0.12); g.add(apr);                               // fighter apron
  for(let i=0;i<2;i++){ const j=_veh('jet',r); j.position.set(ex*0.22+i*0.18,TOP,-hz*0.12); j.rotation.y=Math.PI; g.add(j); }
  for(let i=0;i<2;i++){ const j=_veh('jeep',r); j.position.set(-ex*0.05+i*0.08,TOP,-ez*0.2); g.add(j); }
  for(let i=0;i<3;i++){ const tent=new THREE.Mesh(new THREE.ConeGeometry(0.05,0.05,4),_mCol(0x7a7a55)); tent.rotation.y=Math.PI/4; tent.position.set(-ex*0.05+i*0.12,TOP+0.025,hz*0.05); g.add(tent); }
  return g; }
function _rocket(sc){ const g=new THREE.Group(), white=_mCol(0xf4f5f6,{roughness:0.35}), black=_mCol(0x1c1c1f), gold=_mCol(0xc8a24a,{metalness:0.5,roughness:0.4});
  const H1=1.5*sc, H2=0.55*sc, R=0.075*sc;
  const core=new THREE.Mesh(new THREE.CylinderGeometry(R,R,H1,20),white); core.position.y=TOP+0.06+H1/2; core.castShadow=true; g.add(core);
  for(const f of [0.25,0.72,0.98]){ const b=new THREE.Mesh(new THREE.CylinderGeometry(R*1.01,R*1.01,0.035*sc,20),black); b.position.y=TOP+0.06+H1*f; g.add(b); }
  const up=new THREE.Mesh(new THREE.CylinderGeometry(R*0.85,R,H2,20),white); up.position.y=TOP+0.06+H1+H2/2; g.add(up);
  const fair=new THREE.Mesh(new THREE.ConeGeometry(R*0.85,0.32*sc,20),white); fair.position.y=TOP+0.06+H1+H2+0.16*sc; g.add(fair);
  for(const s of [-1,1]){ const bx=s*R*1.75, bh=H1*0.62, b=new THREE.Mesh(new THREE.CylinderGeometry(R*0.55,R*0.55,bh,14),white); b.position.set(bx,TOP+0.06+bh/2,0); b.castShadow=true; g.add(b);
    const nc=new THREE.Mesh(new THREE.ConeGeometry(R*0.55,0.14*sc,14),white); nc.position.set(bx,TOP+0.06+bh+0.07*sc,0); g.add(nc);
    const nz=new THREE.Mesh(new THREE.CylinderGeometry(R*0.35,R*0.5,0.05*sc,12),_mCol(0x3a3a3c)); nz.position.set(bx,TOP+0.035,0); g.add(nz); }
  for(let i=0;i<4;i++){ const fin=_boxB(0.006*sc,0.12*sc,0.07*sc,black); const a=i*Math.PI/2+Math.PI/4; fin.position.set(Math.cos(a)*R*1.05,TOP+0.12*sc,Math.sin(a)*R*1.05); fin.rotation.y=-a; g.add(fin); }
  const band=new THREE.Mesh(new THREE.CylinderGeometry(R*1.01,R*1.01,0.1*sc,20),gold); band.position.y=TOP+0.06+H1+0.05*sc; g.add(band);
  g.userData.top=0.06+H1+H2+0.32*sc; return g; }
function _serviceTower(hgt, sc){ const g=new THREE.Group(), red=_mCol(0xb8322b,{roughness:0.7}), w=0.1*sc;
  for(const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const p=_boxB(0.008*sc,hgt,0.008*sc,red); p.position.set(a*w/2,TOP+hgt/2,b*w/2); g.add(p); }
  for(let y=0.1*sc;y<hgt;y+=0.12*sc){ for(const [x,z,lx,lz] of [[0,-w/2,w,0.006*sc],[0,w/2,w,0.006*sc],[-w/2,0,0.006*sc,w],[w/2,0,0.006*sc,w]]){ const b=_boxB(lx,0.006*sc,lz,red); b.position.set(x,TOP+y,z); g.add(b); } }
  for(const f of [0.45,0.8]){ const arm=_boxB(0.12*sc,0.01*sc,0.02*sc,_mCol(0x55585c)); arm.position.set(w/2+0.06*sc,TOP+hgt*f,0); g.add(arm); }
  return g; }
function _spaceHub(gk,w,h,r){ const g=new THREE.Group(), [ex,ez]=_siteExt(gk,w,h), L=Math.max(ex,ez), S=Math.min(ex,ez), inner=new THREE.Group(); if(ez>ex) inner.rotation.y=Math.PI/2; g.add(inner);
  const sc=Math.max(1, S/2.2)*1.15;
  const padX=L*0.28, pad=_boxB(0.7*sc,0.04,0.7*sc,_mCol(0xc9c6bd)); pad.position.set(padX,TOP+0.02,0); inner.add(pad);
  const trench=_boxB(0.5*sc,0.005,0.12*sc,_mCol(0x2a2a2c)); trench.position.set(padX,TOP+0.042,0); inner.add(trench);
  const rk=_rocket(sc); rk.position.set(padX,0,0); inner.add(rk);
  const st=_serviceTower(rk.userData.top*0.92, sc); st.position.set(padX-0.2*sc,0,0); inner.add(st);
  const vab=_boxB(0.5*sc,0.95*sc,0.42*sc,_mCol(0xdfe1e3,{roughness:0.8})); vab.position.set(-L*0.3,TOP+0.475*sc,-S*0.12); inner.add(vab);
  const door=_boxB(0.502*sc,0.8*sc,0.1*sc,_mCol(0x9ea3a8)); door.position.set(-L*0.3,TOP+0.4*sc,-S*0.12); inner.add(door);
  const stripe=_boxB(0.12*sc,0.18*sc,0.425*sc,_mCol(0x2f4f9a)); stripe.position.set(-L*0.3+0.1*sc,TOP+0.75*sc,-S*0.12); inner.add(stripe);
  const crawl=_flatPlane(L*0.56, 0.12*sc, 0xb5b1a8, 0.027); crawl.position.set(-L*0.02,0,0); inner.add(crawl);
  const cc=_boxB(0.36*sc,0.08,0.2*sc,_mCol(0xe9ecee)); cc.position.set(-L*0.28,TOP+0.04,S*0.3); inner.add(cc);
  const mast=new THREE.Mesh(new THREE.CylinderGeometry(0.008,0.008,0.14,6),_mCol(0x9aa0a6)); mast.position.set(-L*0.2,TOP+0.15,S*0.3); inner.add(mast);
  const dish=new THREE.Mesh(new THREE.SphereGeometry(0.08*sc,16,8,0,Math.PI*2,0,Math.PI/3),_mCol(0xf2f4f5,{side:THREE.DoubleSide})); dish.rotation.x=Math.PI*0.75; dish.position.set(-L*0.2,TOP+0.24,S*0.3); inner.add(dish);
  for(let i=0;i<2;i++){ const t=new THREE.Mesh(new THREE.SphereGeometry(0.07*sc,16,12),_mCol(0xf2f4f5,{roughness:0.3,metalness:0.2})); t.position.set(padX+(i?0.3:-0.3)*sc,TOP+0.1*sc,S*0.33); t.castShadow=true; inner.add(t); }
  return g; }
function _container(col){ return _boxB(0.1,0.034,0.04,_mCol(col,{roughness:0.7})); }
function _seaPort(gk,w,h,dir,r){ const g=new THREE.Group(), [ex,ez]=_siteExt(gk,w,h), gr=TE.gridFor(gk), [mx,mz]=gr.edgeMid(dir), ml=Math.hypot(mx,mz);
  const ux=mx/ml, uz=mz/ml, inner=new THREE.Group(); inner.rotation.y=Math.atan2(ux,uz); g.add(inner);                    // local +z = toward the water
  const along = Math.abs(ux)>Math.abs(uz) ? ez : ex, deep = Math.abs(ux)>Math.abs(uz) ? ex : ez, edge=deep/2;
  const quay=_boxB(along*0.98,0.03,0.05,_mCol(0x8e8a82)); quay.position.set(0,TOP+0.015,edge-0.02); inner.add(quay);
  const cols=[0xb8322b,0x2f6f9a,0x3d8a4a,0xd08a2a,0x6b4a8a,0xc9ced4,0x8a3a2e];
  const nC=Math.max(2,Math.round(along/0.9));
  for(let i=0;i<nC;i++){ const x=(i-(nC-1)/2)*along/nC, cc=_mCol(i%2?0x2f6f9a:0xd04a2a,{roughness:0.6});                  // gantry cranes
    for(const [a,b] of [[-0.06,edge-0.12],[0.06,edge-0.12],[-0.06,edge-0.02],[0.06,edge-0.02]]){ const l=_boxB(0.012,0.36,0.012,cc); l.position.set(x+a,TOP+0.18,b); inner.add(l); }
    const boom=_boxB(0.03,0.025,0.62,cc); boom.position.set(x,TOP+0.37,edge+0.12); inner.add(boom);
    const cab=_boxB(0.05,0.04,0.05,_mCol(0xe9ecee)); cab.position.set(x,TOP+0.34,edge-0.05); inner.add(cab); }
  // container yard: bays of 3 rows × n stacks, a lane between bays, stacks 1–3 high (a bay keeps a similar height)
  const yardFront=edge-0.28, yardBack=-edge+0.38, perRow=Math.max(2,Math.floor(along*0.86/0.108));
  for(let z=yardFront, bay=0; z>yardBack; bay++){ const bh=1+((r()*3)|0);
    for(let rr=0; rr<3 && z>yardBack; rr++, z-=0.048){ for(let i=0;i<perRow;i++){ if(r()<0.12) continue; const n=Math.max(1,Math.min(3,bh+((r()*3)|0)-1));
        for(let s2=0;s2<n;s2++){ const c=_container(cols[(r()*cols.length)|0]); c.position.set((i-(perRow-1)/2)*0.108,TOP+0.017+s2*0.035,z); inner.add(c); } } }
    z-=0.09; }                                                                                                                    // lane between bays
  const wh=_boxB(along*0.5,0.09,0.16,_mCol(0xb7b3aa)); wh.position.set(-along*0.2,TOP+0.045,-edge+0.12); inner.add(wh);
  const whr=_boxB(along*0.52,0.012,0.18,_mCol(0x55585c)); whr.position.set(-along*0.2,TOP+0.096,-edge+0.12); inner.add(whr);
  // a container ship moored alongside
  const sl=Math.min(along*0.9, 2.2), ship=new THREE.Group(); ship.position.set(0,0,edge+0.24); inner.add(ship);
  const hull=_boxB(sl,0.07,0.26,_mCol(0x2a2a30,{roughness:0.6})); hull.position.y=TOP+0.02; ship.add(hull);
  const red=_boxB(sl*1.001,0.02,0.261,_mCol(0x8a2a22)); red.position.y=TOP-0.005; ship.add(red);
  const bow=new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.13,0.07,3,1),_mCol(0x2a2a30)); bow.rotation.y=Math.PI/2; bow.scale.set(1,1,0.6); bow.position.set(sl/2,TOP+0.02,0); ship.add(bow);
  for(let i=0;i<Math.floor(sl*0.75/0.105);i++) for(let j=0;j<2;j++){ const n=1+((r()*3)|0); for(let s=0;s<n;s++){ const c=_container(cols[(r()*cols.length)|0]); c.position.set(-sl*0.28+i*0.105,TOP+0.072+s*0.035,(j-0.5)*0.09); ship.add(c); } }
  const br=_boxB(0.12,0.16,0.22,_mCol(0xf2f4f6)); br.position.set(-sl*0.42,TOP+0.135,0); ship.add(br);
  const fun=_boxB(0.05,0.08,0.06,_mCol(0xb8322b)); fun.position.set(-sl*0.46,TOP+0.25,0); ship.add(fun);
  return g; }
// 2D (flat) versions of the big sites
function _siteFlat(kind, gk, w, h, dir){ const g=new THREE.Group(), [ex,ez]=_siteExt(gk,w,h);
  const dec=(ww,hh,c,x,z,y,rot)=>{ const d=flatDecal(ww,hh,c,0.98); d.position.set(x||0,TOP+(y||0.05),z||0); d.rotation.y=rot||0; g.add(d); return d; };
  const L=Math.max(ex,ez), S=Math.min(ex,ez), rot=ez>ex?Math.PI/2:0, rx=(x,z)=>ez>ex?[-z,x]:[x,z];
  if(kind==='airport'){ const [a,b]=rx(0,S*0.2); dec(ez>ex?S*0.24:L*0.97, ez>ex?L*0.97:S*0.24, 0x35373b, a, b); const [c,d]=rx(-L*0.05,-S*0.3); dec(ez>ex?S*0.14:L*0.42, ez>ex?L*0.42:S*0.14, 0x6f93b5, c, d, 0.052); }
  else if(kind==='military'){ dec(ex*0.95,ez*0.95,0x6b6b47,0,0,0.049).material.opacity=0.35; for(let i=0;i<4;i++) dec(ex*0.3,0.09,0x6b6b47,-ex*0.22,-ez*0.33+i*0.16,0.052); }
  else if(kind==='spacehub'){ const [a,b]=rx(L*0.28,0); dec(0.6,0.6,0xc9c6bd,a,b); const m=new THREE.Mesh(new THREE.CircleGeometry(0.1,16),new THREE.MeshBasicMaterial({color:0xf4f5f6,depthWrite:false})); m.rotation.x=-Math.PI/2; m.position.set(a,TOP+0.055,b); m.renderOrder=3; g.add(m); const [c,d]=rx(-L*0.3,-S*0.12); dec(0.45,0.4,0xdfe1e3,c,d,0.052); }
  else if(kind==='port'){ const gr=TE.gridFor(gk), [mx,mz]=gr.edgeMid(dir), ml=Math.hypot(mx,mz), ux=mx/ml, uz=mz/ml, along=Math.abs(ux)>Math.abs(uz)?ez:ex, deep=Math.abs(ux)>Math.abs(uz)?ex:ez;
    const d=dec(along*0.9,0.26,0x2a2a30,ux*(deep/2+0.24),uz*(deep/2+0.24),0.052,Math.atan2(ux,uz)+Math.PI/2); d.rotation.y=Math.atan2(-ux,-uz);                       // ship lies along the quay
    for(let i=0;i<8;i++) dec(0.1,0.04,[0xb8322b,0x2f6f9a,0x3d8a4a,0xd08a2a][i%4],(i%4-1.5)*0.18-ux*0.2,(Math.floor(i/4)-0.5)*0.14-uz*0.2,0.053); }
  return g; }
/* ===================== MODERN PACK round 2 — VEHICLES (traffic + placeable props) =====================
   Every model is built on y=0 with its NOSE pointing +z, in world units (a tile = 1). Traffic uses them as-is;
   props scale them up. _veh(kind, r) → Group. */
const _vc=(hex,o)=>_mCol(hex,o);
function _wheels(g, w, l, rad, n){ const m=_vc(0x1a1a1c,{roughness:0.9}); const zs=n===3?[-l*0.36,l*0.02,l*0.36]:[-l*0.33,l*0.33];
  for(const z of zs) for(const s of [-1,1]){ const wh=new THREE.Mesh(new THREE.CylinderGeometry(rad,rad,rad*0.9,10),m); wh.rotation.z=Math.PI/2; wh.position.set(s*w/2,rad,z); g.add(wh); } }
const CAR_COLS=[0xc0392b,0x2c3e50,0xecf0f1,0x7f8c8d,0x2980b9,0x27ae60,0xf1c40f,0x111111,0x8e44ad,0xd35400,0xbdc3c7];
const _glass=()=>_vc(0x1c2733,{roughness:0.15,metalness:0.5});
function _veh(kind, r){ r=r||Math.random; const g=new THREE.Group(); g.userData.kind=kind;
  const box=(w,h,l,mat,x,y,z)=>{ const b=_boxB(w,h,l,mat); b.position.set(x||0,y,z||0); g.add(b); return b; };
  if(kind==='car'||kind==='taxi'||kind==='police'){ const col=kind==='taxi'?0xf2c200:kind==='police'?0xf2f2f2:CAR_COLS[(r()*CAR_COLS.length)|0], c=_vc(col,{roughness:0.35,metalness:0.35});
    box(0.044,0.016,0.088,c,0,0.018,0); box(0.04,0.016,0.046,_glass(),0,0.034,-0.004); box(0.036,0.004,0.04,c,0,0.043,-0.004);
    if(kind==='police'){ box(0.045,0.006,0.03,_vc(0x1d1d1f),0,0.019,0.012); box(0.022,0.006,0.008,_vc(0x2060ff),-0.006,0.047,-0.004); box(0.01,0.006,0.008,_vc(0xff2a2a),0.01,0.047,-0.004); }
    if(kind==='taxi') box(0.018,0.008,0.01,_vc(0xffffff),0,0.049,-0.004);
    _wheels(g,0.046,0.088,0.011); }
  else if(kind==='pickup'){ const c=_vc(CAR_COLS[(r()*CAR_COLS.length)|0],{roughness:0.4,metalness:0.3});
    box(0.048,0.02,0.1,c,0,0.022,0); box(0.044,0.018,0.036,_glass(),0,0.041,0.014); box(0.042,0.004,0.034,c,0,0.051,0.014);
    box(0.048,0.012,0.04,_vc(0x2a2a2c),0,0.033,-0.028); _wheels(g,0.05,0.1,0.013); }
  else if(kind==='bus'||kind==='schoolbus'){ const col=kind==='schoolbus'?0xf2b600:[0x2f6f9a,0xb8322b,0x3d8a4a][(r()*3)|0], c=_vc(col,{roughness:0.5});
    box(0.056,0.05,0.2,c,0,0.037,0); box(0.058,0.016,0.19,_glass(),0,0.045,0.002); box(0.052,0.004,0.19,_vc(kind==='schoolbus'?0xf2b600:0xe9ecee),0,0.064,0);
    if(kind==='schoolbus') box(0.058,0.004,0.2,_vc(0x1d1d1f),0,0.028,0); _wheels(g,0.058,0.2,0.014); }
  else if(kind==='semi'){ const cab=_vc([0xb8322b,0x1f4e8c,0xf2f2f2,0x2f6b3a,0x1d1d1f][(r()*5)|0],{roughness:0.4,metalness:0.3});
    box(0.056,0.05,0.05,cab,0,0.045,0.13); box(0.058,0.018,0.012,_glass(),0,0.056,0.155); box(0.05,0.012,0.03,_vc(0x55585c),0,0.078,0.12);
    const tr=[0xe9ecee,0xd9dde2,0x9aa0a6,0x3b5a7a][(r()*4)|0]; box(0.06,0.07,0.22,_vc(tr,{roughness:0.6}),0,0.058,-0.02);
    box(0.061,0.012,0.14,_vc([0xb8322b,0x2f6f9a,0xd08a2a][(r()*3)|0]),0,0.07,-0.02);
    const wm=_vc(0x1a1a1c); for(const z of [0.14,0.09,-0.08,-0.11]) for(const s of [-1,1]){ const wh=new THREE.Mesh(new THREE.CylinderGeometry(0.013,0.013,0.012,10),wm); wh.rotation.z=Math.PI/2; wh.position.set(s*0.03,0.013,z); g.add(wh); } }
  else if(kind==='tank'){ const olive=_vc([0x55603a,0x6b6b47,0x5a5a3c][(r()*3)|0],{roughness:0.8});
    box(0.064,0.012,0.11,_vc(0x2a2a26),0,0.009,0); box(0.058,0.024,0.1,olive,0,0.026,0); box(0.04,0.018,0.05,olive,0,0.047,-0.006);
    const gun=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.005,0.08,8),olive); gun.rotation.x=Math.PI/2; gun.position.set(0,0.048,0.058); g.add(gun);
    box(0.012,0.006,0.012,olive,0.01,0.059,-0.012); }
  else if(kind==='jeep'){ const olive=_vc(0x5f6a42,{roughness:0.8}); box(0.044,0.018,0.07,olive,0,0.022,0); box(0.04,0.004,0.028,_vc(0x3a3a34),0,0.042,-0.01);
    box(0.04,0.014,0.003,_glass(),0,0.037,0.014); _wheels(g,0.048,0.07,0.012); }
  else if(kind==='armytruck'){ const olive=_vc(0x5a5a3c,{roughness:0.8}); box(0.05,0.04,0.04,olive,0,0.036,0.07);
    box(0.052,0.014,0.014,_glass(),0,0.046,0.09); box(0.054,0.012,0.12,olive,0,0.024,-0.02);
    const cov=new THREE.Mesh(new THREE.CylinderGeometry(0.028,0.028,0.12,12,1,false,0,Math.PI),_vc(0x6b6b47,{roughness:0.95})); cov.rotation.z=Math.PI/2; cov.rotation.y=Math.PI/2; cov.position.set(0,0.03,-0.02); g.add(cov);
    _wheels(g,0.056,0.16,0.014,3); }
  else if(kind==='helicopter'||kind==='newscopter'){ const c=kind==='helicopter'?_vc(0x4f5a3a,{roughness:0.6}):_vc(0x1f4e8c,{roughness:0.4,metalness:0.3});
    const body=new THREE.Mesh(new THREE.SphereGeometry(0.03,12,10),c); body.scale.set(0.9,0.85,1.7); body.position.y=0.04; g.add(body);
    const can=new THREE.Mesh(new THREE.SphereGeometry(0.02,10,8),_glass()); can.position.set(0,0.045,0.03); g.add(can);
    box(0.012,0.012,0.11,c,0,0.046,-0.085); box(0.004,0.03,0.02,c,0,0.058,-0.135);
    const mast=new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.004,0.02,6),_vc(0x333333)); mast.position.y=0.075; g.add(mast);
    for(const a of [0,Math.PI/2]){ const b=box(0.006,0.003,0.24,_vc(0x222222),0,0.086,0); b.rotation.y=a+0.4; }
    for(const s of [-1,1]) box(0.004,0.004,0.08,_vc(0x333333),s*0.022,0.004,0); }
  else if(kind==='airliner'){ const white=_vc(0xf2f4f6,{roughness:0.4}), tail=_vc([0x1f4e8c,0xb8322b,0x2f7a4a,0xe0a020][(r()*4)|0]);
    const f=new THREE.Mesh(new THREE.CylinderGeometry(0.026,0.026,0.34,14),white); f.rotation.x=Math.PI/2; f.position.y=0.045; g.add(f);
    const nose=new THREE.Mesh(new THREE.SphereGeometry(0.026,12,10),white); nose.scale.z=1.6; nose.position.set(0,0.045,0.17); g.add(nose);
    const tc=new THREE.Mesh(new THREE.ConeGeometry(0.026,0.07,14),white); tc.rotation.x=-Math.PI/2; tc.position.set(0,0.05,-0.2); g.add(tc);
    box(0.36,0.005,0.07,white,0,0.038,0.01); box(0.13,0.004,0.035,white,0,0.055,-0.2); box(0.004,0.06,0.05,tail,0,0.085,-0.2);
    for(const s of [-1,1]){ const e=new THREE.Mesh(new THREE.CylinderGeometry(0.011,0.011,0.045,10),_vc(0x9aa0a6)); e.rotation.x=Math.PI/2; e.position.set(s*0.075,0.026,0.03); g.add(e); }
    box(0.052,0.008,0.24,_vc(0x1f4e8c),0,0.05,0); }                                                      // window band
  else if(kind==='jet'){ const grey=_vc(0x8a939c,{roughness:0.5,metalness:0.4});
    const f=new THREE.Mesh(new THREE.CylinderGeometry(0.016,0.02,0.2,10),grey); f.rotation.x=Math.PI/2; f.position.y=0.03; g.add(f);
    const nose=new THREE.Mesh(new THREE.ConeGeometry(0.016,0.07,10),grey); nose.rotation.x=Math.PI/2; nose.position.set(0,0.03,0.135); g.add(nose);
    const can=new THREE.Mesh(new THREE.SphereGeometry(0.012,10,8),_glass()); can.scale.z=2.4; can.position.set(0,0.044,0.06); g.add(can);
    const wing=new THREE.Shape(); wing.moveTo(0,0.03); wing.lineTo(0.13,-0.05); wing.lineTo(0.13,-0.07); wing.lineTo(0,-0.07); wing.lineTo(-0.13,-0.07); wing.lineTo(-0.13,-0.05); wing.closePath();
    const wg=new THREE.ExtrudeGeometry(wing,{depth:0.004,bevelEnabled:false}); wg.rotateX(-Math.PI/2); const wm=new THREE.Mesh(wg,grey); wm.position.set(0,0.028,-0.01); g.add(wm);
    for(const s of [-1,1]){ const t=box(0.004,0.045,0.04,grey,s*0.016,0.058,-0.085); t.rotation.z=s*0.3; } }
  else if(kind==='propplane'){ const c=_vc([0xf2f4f6,0xe0a020,0xb8322b][(r()*3)|0],{roughness:0.4});
    const f=new THREE.Mesh(new THREE.CylinderGeometry(0.012,0.014,0.1,10),c); f.rotation.x=Math.PI/2; f.position.y=0.03; g.add(f);
    box(0.16,0.004,0.03,c,0,0.042,0.01); box(0.05,0.003,0.02,c,0,0.034,-0.045); box(0.003,0.022,0.018,c,0,0.045,-0.045);
    box(0.05,0.003,0.004,_vc(0x333333),0,0.03,0.052); box(0.024,0.01,0.018,_glass(),0,0.045,0.015); }
  else if(kind==='sailboat'||kind==='motorboat'){ const hull=new THREE.Mesh(new THREE.CylinderGeometry(0.022,0.012,0.1,3,1),_vc(0xf2f4f6,{roughness:0.4})); hull.rotation.x=Math.PI/2; hull.scale.set(1,1,0.4); hull.position.y=0.006; g.add(hull);
    if(kind==='sailboat'){ const m=new THREE.Mesh(new THREE.CylinderGeometry(0.002,0.002,0.13,5),_vc(0xd9dde2)); m.position.set(0,0.07,0.01); g.add(m);
      const sh=new THREE.Shape(); sh.moveTo(0,0); sh.lineTo(0,0.11); sh.lineTo(-0.045,0); sh.closePath(); const sm=new THREE.Mesh(new THREE.ShapeGeometry(sh),_vc(0xffffff,{side:THREE.DoubleSide})); sm.rotation.y=Math.PI/2; sm.position.set(0,0.012,0.008); g.add(sm); }
    else box(0.024,0.014,0.03,_vc(0xd9dde2),0,0.018,-0.005); }
  return g; }
const VEHICLE_KINDS=['car','taxi','police','pickup','bus','schoolbus','semi','tank','jeep','armytruck','helicopter','newscopter','airliner','jet','propplane','sailboat','motorboat'];

/* traffic along a street / highway stroke (scene points [{x,z}]): vehicles in both lanes, keep-right, spaced by seed.
   opts: { density (per unit), kinds (weighted list), laneOff, lanes (per direction), y, scale } */
export function trafficAlong(points, seed, opts){
  if(!points || points.length<2) return null; opts=opts||{};
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(p.x,0,p.z)), false, 'centripetal', 0.5), L=curve.getLength();
  const r=rng32(((seed||1)*2246822519)>>>0), sc=opts.scale||(_scale==='battle'?11:1), den=opts.density||0.3, lanes=opts.lanes||1, lo=opts.laneOff||0.05;
  const kinds=opts.kinds||['car','car','car','car','pickup','taxi','bus','semi'];
  const grp=new THREE.Group(); grp.name='traffic'; const gap=0.13*sc, avoid=opts.avoid||[], aR=(opts.avoidR||0.2)*sc;
  const clearOf=(p)=>avoid.every(a=>(a.x-p.x)**2+(a.z-p.z)**2>aR*aR);                        // keep intersections clear
  for(const dir of [1,-1]) for(let ln=0; ln<lanes; ln++){ let s=0.08*sc+r()*0.3;
    while(s<L-0.08*sc){ if(r()<den*gap*4 && clearOf(curve.getPointAt(s/L))){ const u=s/L, p=curve.getPointAt(u), t=curve.getTangentAt(u), k=kinds[(r()*kinds.length)|0];
        const v=_flat?_vehFlat(k,r):_veh(k,r); v.scale.setScalar(sc*(opts.vscale||1));
        const nx=t.z, nz=-t.x, off=(lo+ln*0.075)*sc*(opts.laneScale||1);                                        // right-hand lane (dir 1) / opposite (dir -1)
        const hold=new THREE.Group(); hold.add(v); hold.position.set(p.x+nx*off*dir, (opts.y!=null?opts.y:TOP+0.034)+(_flat?0.022:0), p.z+nz*off*dir);
        hold.rotation.y=Math.atan2(t.x*dir,t.z*dir); grp.add(hold); s+=gap*(1.2+(k==='semi'||k==='bus'||k==='schoolbus'?1.6:0)); }
      else s+=gap*(0.8+r()*0.8); } }
  return grp; }
function _vehFlat(kind, r){ const len={bus:0.2,schoolbus:0.2,semi:0.3,airliner:0.4,jet:0.22}[kind]||0.088, col=kind==='bus'?0x2f6f9a:kind==='schoolbus'?0xf2b600:kind==='taxi'?0xf2c200:kind==='semi'?0xe9ecee:kind==='tank'||kind==='jeep'||kind==='armytruck'?0x5a5a3c:CAR_COLS[(r()*CAR_COLS.length)|0];
  const g=new THREE.Group(), d=flatDecal(len>0.2?0.06:0.045,len,col,0.98); d.position.y=0; g.add(d); return g; }

/* ---- ELEVATED HIGHWAY: a 4-lane divided deck on concrete piers, with barriers — drawn over the whole stroke ---- */
let _hwyTex;
function highwayTex(){ return _hwyTex || (_hwyTex = makeStripTex((x,w,h)=>{
  x.fillStyle='#3a3c40'; x.fillRect(0,0,w,h); for(let i=0;i<700;i++){ const v=48+Math.random()*30|0; x.fillStyle=`rgba(${v},${v},${v+3},.6)`; x.fillRect(Math.random()*w,Math.random()*h,1.2,1.2); }
  x.fillStyle='#b5b1a8'; x.fillRect(0,0,w*0.05,h); x.fillRect(w*0.95,0,w*0.05,h); x.fillRect(w*0.485,0,w*0.03,h);   // barriers + median
  x.fillStyle='rgba(245,245,240,.9)'; for(const f of [0.25,0.75]) x.fillRect(w*f-1,0,2,h*0.5);                          // dashed lane lines
  x.fillStyle='#e8c230'; x.fillRect(w*0.46,0,1.5,h); x.fillRect(w*0.54-1.5,0,1.5,h); },96,64)); }
export function highwayAlong(points){
  if(!points || points.length<2) return null;
  const grp=new THREE.Group(); grp.name='highway';
  const Y=_scale==='battle'?TOP+1.6:TOP+0.16, W=_scale==='battle'?3.2:0.34;
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(p.x,0,p.z)), false, 'centripetal', 0.5), L=curve.getLength();
  if(_flat){ const m=pathRibbonAlong(points,'highwayflat'); if(m) grp.add(m); return grp; }
  const N=Math.max(2,Math.round(L/0.1)), pos=[], idx=[], uv=[];
  for(let i=0;i<=N;i++){ const u=i/N, p=curve.getPointAt(u), t=curve.getTangentAt(u), nx=-t.z, nz=t.x;
    pos.push(p.x+nx*W/2,Y,p.z+nz*W/2, p.x-nx*W/2,Y,p.z-nz*W/2); uv.push(0,u*L/0.5,1,u*L/0.5); }
  for(let i=0;i<N;i++){ const a=i*2; idx.push(a,a+2,a+1,a+1,a+2,a+3); }
  const geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2)); geo.setIndex(idx); geo.computeVertexNormals();
  const tex=highwayTex().clone(); tex.needsUpdate=true; tex.wrapT=THREE.RepeatWrapping;
  const deck=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({map:tex,roughness:0.85,side:THREE.DoubleSide})); deck.receiveShadow=true; grp.add(deck);
  // deck underside + edge beams, piers every ~0.5
  const conc=_vc(0xa9a6a0,{roughness:0.9}), step=_scale==='battle'?5:0.5;
  for(let s=0;s<=L;s+=step){ const u=Math.min(1,s/L), p=curve.getPointAt(u), t=curve.getTangentAt(u), a=Math.atan2(t.x,t.z);
    const pier=_boxB(W*0.3,Y-TOP,W*0.12,conc); pier.position.set(p.x,TOP+(Y-TOP)/2,p.z); pier.rotation.y=a; grp.add(pier);
    const cap=_boxB(W*0.95,W*0.08,W*0.14,conc); cap.position.set(p.x,Y-W*0.05,p.z); cap.rotation.y=a; grp.add(cap); }
  for(const side of [-1,1]){ const bp=[]; for(let i=0;i<=N;i++){ const u=i/N, p=curve.getPointAt(u), t=curve.getTangentAt(u), nx=-t.z, nz=t.x; bp.push(new THREE.Vector3(p.x+nx*W/2*side,Y+W*0.03,p.z+nz*W/2*side)); }
    const bc=new THREE.CatmullRomCurve3(bp); const tube=new THREE.Mesh(new THREE.TubeGeometry(bc,N,W*0.03,4,false),conc); grp.add(tube); }
  return grp; }

/* ===================== INDUSTRIAL ===================== */
function _corrTex(base){ return _mTex('corr'+base,64,64,(x,W,H)=>{ x.fillStyle=base; x.fillRect(0,0,W,H); for(let i=0;i<W;i+=4){ x.fillStyle='rgba(0,0,0,.12)'; x.fillRect(i,0,1.5,H); x.fillStyle='rgba(255,255,255,.1)'; x.fillRect(i+2,0,1,H); } }); }
function _corrMat(base){ return _mMat('corrm'+base,()=>{ const t=_corrTex(base); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(4,1); return new THREE.MeshStandardMaterial({map:t,roughness:0.7,metalness:0.3}); }); }
function _stack(h,r0,banded){ const g=new THREE.Group(); const m=new THREE.Mesh(new THREE.CylinderGeometry(r0*0.75,r0,h,12),_vc(0x9a8a7a,{roughness:0.9})); m.position.y=TOP+h/2; m.castShadow=true; g.add(m);
  if(banded) for(const f of [0.82,0.92]){ const b=new THREE.Mesh(new THREE.CylinderGeometry(r0*0.78,r0*0.8,h*0.05,12),_vc(f>0.9?0xf2f2f2:0xb8322b)); b.position.y=TOP+h*f; g.add(b); }
  return g; }
function _factory(r){ const g=new THREE.Group(); const wall=_corrMat(['#8a9096','#a0856a','#7a8a7a'][(r()*3)|0]), brick=_mCol(0x9c5a44);
  const L=0.62, W=0.38, H=0.12; const b=_boxB(L,H,W,[wall,wall,_mCol(0x55585c),_mCol(0x55585c),brick,brick]); b.position.y=TOP+H/2; g.add(b);
  const n=5; for(let i=0;i<n;i++){ const sh=new THREE.Shape(); sh.moveTo(0,0); sh.lineTo(L/n,0); sh.lineTo(L/n,0.06); sh.closePath();       // sawtooth roof
    const geo=new THREE.ExtrudeGeometry(sh,{depth:W*0.98,bevelEnabled:false}); const m=new THREE.Mesh(geo,[_mCol(0x7a8088),_mCol(0x9fb6c6,{roughness:0.2,metalness:0.4})]);
    m.position.set(-L/2+i*L/n,TOP+H,-W*0.49); m.castShadow=true; g.add(m); }
  for(let i=0;i<3;i++){ const d=_boxB(0.004,0.07,0.07,_mCol(0x55585c)); d.position.set(L/2+0.002,TOP+0.035,-0.12+i*0.12); g.add(d); }
  const st=_stack(0.5+r()*0.25,0.035,true); st.position.set(-L*0.36,0,W*0.36); g.add(st);
  if(r()<0.6){ const s2=_stack(0.38,0.028,false); s2.position.set(-L*0.24,0,W*0.36); g.add(s2); }
  const silo=new THREE.Mesh(new THREE.CylinderGeometry(0.045,0.045,0.18,12),_mCol(0xc9ced2,{metalness:0.4,roughness:0.4})); silo.position.set(L*0.36,TOP+0.09,W*0.42); g.add(silo);
  g.rotation.y=Math.floor(r()*4)*Math.PI/2; return g; }
function _warehouse(r, dirs){ const g=new THREE.Group(); const wall=_corrMat(['#b9bcc0','#c9b99a','#8fa3b0'][(r()*3)|0]);
  const L=0.7, W=0.36, H=0.11; const b=_boxB(L,H,W,[wall,wall,_mCol(0x6d7176),_mCol(0x6d7176),wall,wall]); b.position.set(0,TOP+H/2,-0.06); g.add(b);
  for(let i=0;i<5;i++){ const d=_boxB(0.07,0.075,0.004,_mCol(0x55585c)); d.position.set(-L*0.4+i*0.14,TOP+0.038,-0.06+W/2+0.002); g.add(d); }   // loading docks
  const apron=_flatPlane(L,0.2,0x6e6a60,0.027); apron.position.set(0,0,W/2+0.04); g.add(apron);
  for(let i=0;i<3;i++){ if(r()<0.3) continue; const t=_veh('semi',r); t.scale.setScalar(0.9); t.position.set(-L*0.4+i*0.28,TOP,W/2+0.1); t.rotation.y=Math.PI; g.add(t); }
  g.rotation.y=Math.floor(r()*4)*Math.PI/2; return g; }
function _tankFarm(r){ const g=new THREE.Group(); const bund=_mCol(0xa9a6a0);
  for(const [x0,z0,x1,z1] of [[-0.42,-0.42,0.42,-0.42],[0.42,-0.42,0.42,0.42],[0.42,0.42,-0.42,0.42],[-0.42,0.42,-0.42,-0.42]]){ const len=Math.hypot(x1-x0,z1-z0), f=_boxB(len,0.025,0.012,bund); f.position.set((x0+x1)/2,TOP+0.012,(z0+z1)/2); f.rotation.y=-Math.atan2(z1-z0,x1-x0); g.add(f); }
  const white=_mCol(0xe9ecee,{roughness:0.45,metalness:0.2});
  for(const [x,z,rad,h] of [[-0.2,-0.2,0.16,0.14],[0.2,-0.2,0.14,0.12],[-0.2,0.2,0.13,0.12],[0.21,0.21,0.1,0.18]]){
    const t=new THREE.Mesh(new THREE.CylinderGeometry(rad,rad,h,20),white); t.position.set(x,TOP+h/2,z); t.castShadow=true; g.add(t);
    const top=new THREE.Mesh(new THREE.CylinderGeometry(rad*0.95,rad,0.012,20),_mCol(0xc9ced2)); top.position.set(x,TOP+h+0.006,z); g.add(top);
    const lad=_boxB(0.004,h,0.012,_mCol(0x8a3a2e)); lad.position.set(x+rad,TOP+h/2,z); g.add(lad); }
  const pipe=_mCol(0x8a8f96,{metalness:0.5}); for(const z of [-0.2,0.2]){ const p=new THREE.Mesh(new THREE.CylinderGeometry(0.007,0.007,0.7,6),pipe); p.rotation.z=Math.PI/2; p.position.set(0,TOP+0.03,z+(z>0?-0.14:0.14)); g.add(p); }
  return g; }
function _depot(r){ const g=new THREE.Group(); const off=_boxB(0.16,0.07,0.1,_mCol(0xd9dde2)); off.position.set(-0.3,TOP+0.035,-0.3); g.add(off);
  for(let i=0;i<5;i++){ if(r()<0.25) continue; const t=_veh('semi',r); t.position.set(-0.24+i*0.12,TOP,0.12); g.add(t); }
  for(let i=0;i<4;i++){ if(r()<0.3) continue; const c=_veh(r()<0.5?'pickup':'car',r); c.position.set(-0.05+i*0.09,TOP,-0.3); c.rotation.y=Math.PI; g.add(c); }
  g.rotation.y=Math.floor(r()*4)*Math.PI/2; return g; }
function _coolingTower(h,rad){ const pts=[]; for(let i=0;i<=16;i++){ const t=i/16, y=t*h, r0=rad*(0.62+0.38*Math.pow((t-0.72)/0.72,2)); pts.push(new THREE.Vector2(r0,y)); }
  const m=new THREE.Mesh(new THREE.LatheGeometry(pts,28),_mCol(0xcac6bd,{roughness:0.9,side:THREE.DoubleSide})); m.position.y=TOP; m.castShadow=true; return m; }
function _powerPlant(gk,w,h,r){ const g=new THREE.Group(), [ex,ez]=_siteExt(gk,w,h), L=Math.max(ex,ez), S=Math.min(ex,ez), inner=new THREE.Group(); if(ez>ex) inner.rotation.y=Math.PI/2; g.add(inner);
  const ct=Math.min(S*0.28,0.55), H=0.9*Math.max(1,S/2.2);
  for(let i=0;i<2;i++){ const c=_coolingTower(H,ct); c.position.set(L*0.18+i*ct*2.3-ct,0,-S*0.15); inner.add(c);
    for(let j=0;j<3;j++){ const steam=new THREE.Mesh(new THREE.SphereGeometry(ct*(0.55-j*0.1),12,10),new THREE.MeshStandardMaterial({color:0xffffff,transparent:true,opacity:0.28-j*0.06,roughness:1,depthWrite:false}));   // soft rising steam
      steam.scale.y=0.6; steam.position.set(c.position.x+j*ct*0.3,TOP+H+ct*(0.35+j*0.45),c.position.z); inner.add(steam); } }
  const hall=_boxB(L*0.32,0.24,S*0.26,[_corrMat('#8a9096'),_corrMat('#8a9096'),_mCol(0x55585c),_mCol(0x55585c),_corrMat('#8a9096'),_corrMat('#8a9096')]); hall.position.set(-L*0.22,TOP+0.12,-S*0.12); inner.add(hall);
  const ch=_stack(H*1.3,0.045,true); ch.position.set(-L*0.4,0,-S*0.3); inner.add(ch);
  const yard=_flatPlane(L*0.4,S*0.3,0x9a9488,0.027); yard.position.set(-L*0.1,0,S*0.28); inner.add(yard);
  const steel=_mCol(0x8f9aa3,{metalness:0.4});
  for(let i=0;i<4;i++){ const x=-L*0.26+i*L*0.13; for(const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const l=_boxB(0.005,0.16,0.005,steel); l.position.set(x+a*0.02,TOP+0.08,S*0.28+b*0.02); inner.add(l); }
    const arm=_boxB(0.12,0.006,0.006,steel); arm.position.set(x,TOP+0.15,S*0.28); inner.add(arm); }
  return g; }
function _sidings(r, dirs){ const g=new THREE.Group(); const [ex,ez]=dirs[0]||[0.5,0], inner=new THREE.Group(); inner.rotation.y=Math.atan2(ex,ez); g.add(inner);
  const tr=pathRibbonAlong([{x:0.2,z:-0.5},{x:0.2,z:0.5}],'rail'); if(tr) inner.add(tr);
  for(let i=0;i<4;i++){ if(r()<0.25) continue; const c=_trainCar(['boxcar','tanker','hopper'][(r()*3)|0],r); c.position.set(0.2,0,-0.33+i*0.22); inner.add(c); }
  return g; }

/* ===================== COASTAL ===================== */
function _umbrella(x,z,r){ const g=new THREE.Group(); const p=new THREE.Mesh(new THREE.CylinderGeometry(0.002,0.002,0.05,4),_vc(0xe9ecee)); p.position.y=TOP+0.025; g.add(p);
  const c=new THREE.Mesh(new THREE.ConeGeometry(0.03,0.012,8),_vc([0xe74c3c,0x3498db,0xf1c40f,0x2ecc71,0xe67e22][(r()*5)|0])); c.position.y=TOP+0.052; g.add(c);
  const tw=_flatPlane(0.02,0.04,[0xe74c3c,0x3498db,0xf1c40f][(r()*3)|0],0.029); tw.position.set(0.03,0,0.01); g.add(tw); g.position.set(x,0,z); return g; }
function _beach(r){ const g=new THREE.Group(); for(let i=0;i<5+((r()*4)|0);i++) g.add(_umbrella((r()-0.5)*0.7,(r()-0.5)*0.7,r));
  if(r()<0.4){ const tw=_boxB(0.03,0.08,0.03,_vc(0xe9ecee)); tw.position.set((r()-0.5)*0.4,TOP+0.04,(r()-0.5)*0.4); g.add(tw); const hut=_boxB(0.05,0.03,0.05,_vc(0xd35400)); hut.position.set(tw.position.x,TOP+0.095,tw.position.z); g.add(hut); }   // lifeguard tower
  return g; }
function _dock(len,wid){ return _boxB(wid,0.012,len,_vc(0x8a6a44,{roughness:0.9})); }
function _marina(r, landDir){ const g=new THREE.Group(); const [ex,ez]=landDir||[0,-0.5], inner=new THREE.Group(); inner.rotation.y=Math.atan2(ex,ez); g.add(inner);   // +z = toward the shore
  const spine=_dock(0.9,0.04); spine.position.set(0,TOP+0.006,0); inner.add(spine);
  for(let i=0;i<4;i++){ const z=-0.36+i*0.22; for(const s of [-1,1]){ const f=_dock(0.03,0.2); f.rotation.y=Math.PI/2; f.position.set(s*0.12,TOP+0.006,z); inner.add(f);
      if(r()<0.8){ const b=_veh(r()<0.55?'sailboat':'motorboat',r); b.scale.setScalar(1.3); b.position.set(s*0.14,TOP-0.004,z+0.06); b.rotation.y=Math.PI/2*s; inner.add(b); } } }
  return g; }
function _ferrisWheel(sc){ const g=new THREE.Group(); const R=0.12*sc, steel=_vc(0xe9ecee,{metalness:0.4});
  const rim=new THREE.Mesh(new THREE.TorusGeometry(R,0.004*sc,6,32),steel); rim.position.y=TOP+R+0.03*sc; g.add(rim);
  for(let i=0;i<8;i++){ const a=i/8*Math.PI*2, s=_boxB(0.003*sc,R*2,0.003*sc,steel); s.position.y=rim.position.y; s.rotation.z=a; g.add(s);
    const cab=_boxB(0.018*sc,0.016*sc,0.018*sc,_vc([0xe74c3c,0x3498db,0xf1c40f,0x2ecc71][i%4])); cab.position.set(Math.cos(a)*R,rim.position.y+Math.sin(a)*R,0); g.add(cab); }
  for(const s of [-1,1]){ const leg=_boxB(0.006*sc,R+0.04*sc,0.006*sc,steel); leg.position.set(s*R*0.4,TOP+(R+0.04*sc)/2,0); leg.rotation.z=-s*0.35; g.add(leg); }
  return g; }
function _pier(r, landDir){ const g=new THREE.Group(); const [ex,ez]=landDir||[0,-0.5], inner=new THREE.Group(); inner.rotation.y=Math.atan2(ex,ez); g.add(inner);
  const deck=_boxB(0.16,0.016,1.0,_vc(0x8a6a44,{roughness:0.9})); deck.position.set(0,TOP+0.03,0); inner.add(deck);
  for(let z=-0.45;z<=0.45;z+=0.15) for(const s of [-1,1]){ const p=new THREE.Mesh(new THREE.CylinderGeometry(0.006,0.006,0.05,6),_vc(0x5a4a3a)); p.position.set(s*0.07,TOP+0.01,z); inner.add(p); }
  const fw=_ferrisWheel(1); fw.position.set(0,0.03,-0.3); inner.add(fw);
  return g; }
function _lighthouse(r){ const g=new THREE.Group(); const H=0.55;
  const t=new THREE.Mesh(new THREE.CylinderGeometry(0.045,0.065,H,16),_vc(0xf4f5f6)); t.position.y=TOP+H/2; t.castShadow=true; g.add(t);
  for(const f of [0.2,0.5,0.8]){ const b=new THREE.Mesh(new THREE.CylinderGeometry(0.066-0.02*f,0.066-0.02*f,H*0.1,16),_vc(0xc0392b)); b.position.y=TOP+H*f; g.add(b); }
  const gal=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,0.01,16),_vc(0x2a2a2c)); gal.position.y=TOP+H+0.005; g.add(gal);
  const lamp=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,0.05,12),new THREE.MeshBasicMaterial({color:0xfff2b0})); lamp.position.y=TOP+H+0.035; g.add(lamp);
  const cap=new THREE.Mesh(new THREE.ConeGeometry(0.04,0.04,12),_vc(0xc0392b)); cap.position.y=TOP+H+0.08; g.add(cap);
  const hut=_building(0.1,0.14,0.07,1,6,6,r,true); hut.position.set(0.16,0,0.05); g.add(hut); return g; }
function _hotel(r){ const g=new THREE.Group(); const base=['#f3e6d0','#e8f0f2','#f7d9c4','#d9ecd9','#f2e1ea'][(r()*5)|0], floors=6+((r()*5)|0), h=floors*0.05, w=0.34, d=0.14;
  const fm=(c)=>_mMat('ho'+base+c+floors,()=>new THREE.MeshStandardMaterial({map:_facade('balcony',c,floors,base,'#3f7fa8'),roughness:0.8}));
  const b=_boxB(w,h,d,[fm(3),fm(3),_mCol(0x9aa0a6),_mCol(0x9aa0a6),fm(8),fm(8)]); b.position.y=TOP+h/2; g.add(b);
  const pool=_boxB(0.12,0.006,0.06,_vc(0x3fb0d8,{roughness:0.1,metalness:0.3})); pool.position.set(0,TOP+h+0.004,0); g.add(pool);
  const pool2=_flatPlane(0.16,0.08,0x3fb0d8,0.028); pool2.position.set(0,0,d/2+0.12); g.add(pool2);
  for(let i=0;i<3;i++) g.add(_umbrella(-0.1+i*0.1,d/2+0.2,r));
  return g; }
const MODERN_FEATS=new Set(['yard','sidewalk','factory','warehouse','tankfarm','depot','sidings','powerplant','beach','marina','pier','lighthouse','hotel','underhwy','interchange','airport','military','spacehub','port','siteyard','skyscraper','skyyard','stadium','stadyard','towers','apartments','shops','homes','church','school','station','railside','lot','park','sportsfield','streetside','plaza','farmstead','turbines','watertower','elevator']);
// the modern scatter (3D); returns true when it handled the feature
function modernScatter(group, def, gridKind, f, pts, r, mass, pathDirs, railDirs, roomy, faceDir, info){
  info=info||{};
  if(f==='skyyard'||f==='stadyard'||f==='siteyard'||f==='underhwy'||f==='yard'||f==='sidewalk') return true;          // ground under a landmark / the highway — drawn elsewhere
  { const gr=TE.gridFor(gridKind), water=()=>{ const w=new THREE.Mesh(topGeo(gridKind), new THREE.MeshStandardMaterial({ color:0x6fb8e6, roughness:0.16, metalness:0.35, transparent:true, opacity:0.55, depthWrite:false })); w.position.y=TOP+0.006; w.renderOrder=1; group.add(w); };
    if(f==='factory'){ group.add(_factory(r)); return true; }
    if(f==='warehouse'){ group.add(_warehouse(r)); return true; }
    if(f==='tankfarm'){ group.add(_tankFarm(r)); return true; }
    if(f==='depot'){ group.add(_depot(r)); return true; }
    if(f==='sidings'){ group.add(_sidings(r, railDirs.length?railDirs:[[0.5,0]])); return true; }
    if(f==='beach'){ group.add(_beach(r)); return true; }
    if(f==='lighthouse'){ group.add(_lighthouse(r)); return true; }
    if(f==='hotel'){ const h=_hotel(r); if(faceDir>=0){ const [ex,ez]=gr.edgeMid(faceDir); h.rotation.y=Math.atan2(ex,ez); } group.add(h); return true; }
    if(f==='marina'){ water(); group.add(_marina(r, gr.edgeMid(info.dir||0))); return true; }
    if(f==='pier'){ water(); group.add(_pier(r, gr.edgeMid(info.dir||0))); return true; }
    if(f==='powerplant'){ const W=info.w||2, H=info.h||2, sub=new THREE.Group(); if(gridKind==='square') sub.position.set((W-1)/2,0,(H-1)/2); sub.add(_powerPlant(gridKind,W,H,r)); group.add(sub); return true; }
    if(f==='interchange'){ // on/off ramps: a sloped deck either side of the elevated highway, down to the street it crosses
      const hd=def.edges.map((e,i)=>e.path===P.HWY?gr.edgeMid(i):null).filter(Boolean)[0]; if(!hd) return true;
      const a=Math.atan2(hd[0],hd[1]), conc=_mCol(0x9e9b95,{roughness:0.9}), Y=0.16;
      for(const s of [-1,1]){ const len=0.95, rise=Y, ramp=_boxB(0.1,0.02,len,[conc,conc,_mMat('rampTop',()=>new THREE.MeshStandardMaterial({color:0x3a3c40,roughness:0.9})),conc,conc,conc]);
        const inner=new THREE.Group(); inner.rotation.y=a; group.add(inner); ramp.position.set(s*0.25,TOP+rise/2+0.01,s*0.02); ramp.rotation.x=s*Math.atan2(rise,len); inner.add(ramp); }
      return true; } }
  if(f==='airport'||f==='military'||f==='spacehub'||f==='port'){ const W=info.w||2, H=info.h||2, sub=new THREE.Group(); if(gridKind==='square') sub.position.set((W-1)/2,0,(H-1)/2);
    sub.add(f==='airport'?_airport(gridKind,W,H,r): f==='military'?_military(gridKind,W,H,r): f==='spacehub'?_spaceHub(gridKind,W,H,r): _seaPort(gridKind,W,H,info.dir||0,r)); group.add(sub); return true; }
  if(f==='skyscraper'){ const N=info.n||2, off=gridKind==='square'?(N-1)/2:0, sub=new THREE.Group(); sub.position.set(off,0,off); sub.add(_supertall(gridKind,N,r)); group.add(sub); return true; }
  if(f==='stadium'){ const W=info.w||2, H=info.h||2, sub=new THREE.Group(); if(gridKind==='square') sub.position.set((W-1)/2,0,(H-1)/2); sub.add(_stadium(gridKind,W,H,r)); group.add(sub); return true; }
  const spaced=(n,gap,ok)=>{ const got=[]; for(const p of pts){ if(got.length>=n) break; if((!ok||ok(p[0],p[1])) && got.every(q=>Math.hypot(q[0]-p[0],q[1]-p[1])>=gap)) got.push(p); } return got; };
  const k = gridKind==='hex' ? 0.8 : 1;
  if(f==='towers'){ const M=(typeof mass==='number')?mass:0.5, n=M>0.6?1+((r()*2)|0):2+((r()*2)|0);
    spaced(n,0.3,roomy).forEach(([x,z],i)=> group.add(_skyscraper(x*0.8,z*0.8,(0.3+M*1.3)*(i?0.55+r()*0.35:0.85+r()*0.3),r))); return true; }
  if(f==='apartments'){ spaced(2,0.36,roomy).forEach(([x,z])=>group.add(_apartments(x*0.8,z*0.8,r))); return true; }
  if(f==='shops'){ spaced(3,0.25,roomy).forEach(([x,z])=>group.add(_shop(x,z,r))); return true; }
  if(f==='homes'){ const g2=TE.gridFor(gridKind), face=(dx,dz)=>Math.atan2(-dz,dx);        // local +x (front door + driveway) → toward the street
    if(pathDirs.length){ // a street runs through this tile: a house either side, facing it
      const [ax,az]=pathDirs[0], al=Math.hypot(ax,az), ux=ax/al, uz=az/al, nx=-uz, nz=ux, perp=pathDirs.some(([bx,bz])=>Math.abs((bx*ux+bz*uz)/Math.hypot(bx,bz))<0.5);
      for(const s of [-1,1]) for(const t of (perp?[0.28]:[-0.2,0.2])){ const along=perp?(s>0?0.28:-0.28):t; const x=nx*s*0.29+ux*along, z=nz*s*0.29+uz*along;
        if(!roomy(x,z)) continue; group.add(_homeModern(x,z,r,face(-nx*s,-nz*s))); } }
    else if(faceDir>=0){ // a row of houses along the street edge, back gardens behind
      const [ex,ez]=g2.edgeMid(faceDir), el=Math.hypot(ex,ez), ux=ex/el, uz=ez/el, tx=-uz, tz=ux, sp=gridKind==='hex'?0.16:0.22;
      for(const s of [-1,1]) group.add(_homeModern(ux*0.2+tx*s*sp, uz*0.2+tz*s*sp, r, face(ux,uz)));
      for(const s of [-1,1]) if(r()<0.7) group.add(roundTree(-ux*0.3+tx*s*sp*1.1,-uz*0.3+tz*s*sp*1.1,0.9+r()*0.4,r));
      if(r()<0.3){ const pool=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.006,0.09), _mCol(0x3fb0d8,{roughness:0.2,metalness:0.2})); pool.position.set(-ux*0.12+tx*0.06,TOP+0.003,-uz*0.12+tz*0.06); pool.rotation.y=face(ux,uz); group.add(pool); } }
    else { spaced(2,0.34,roomy).forEach(([x,z])=>group.add(_homeModern(x,z,r))); spaced(6,0.12,roomy).slice(-2).forEach(([x,z])=>group.add(roundTree(x,z,0.9+r()*0.4,r))); }
    return true; }
  const one=(o)=>{ o.scale.multiplyScalar(k); group.add(o); return true; };
  if(f==='church') return one(_church(r));
  if(f==='school') return one(_school(r));
  if(f==='station') return one(_station(railDirs.length?railDirs:pathDirs, r));
  if(f==='railside') return true;
  if(f==='lot') return one(_lot(r));
  if(f==='park') return one(_park(r, pathDirs.length?4:6));
  if(f==='sportsfield') return one(_sportsField(r));
  if(f==='plaza') return one(_plaza(r));
  if(f==='streetside'){ _streetside(group,r); return true; }
  if(f==='farmstead') return one(_farmstead(r));
  if(f==='watertower') return one(_waterTower(r));
  if(f==='elevator') return one(_elevator(r, railDirs));
  if(f==='turbines'){ const yaw=0.7; spaced(1+((r()*2)|0),0.45,roomy).forEach(([x,z])=>group.add(_turbine(x,z,r,yaw))); return true; }
  return false; }
// the 2D (flat map) version: simple top-down shapes
function modernFlat(group, f, pts, r, mass, info, gridKind, railDirs){
  info=info||{};
  if(f==='skyyard'||f==='stadyard'||f==='siteyard'||f==='underhwy'||f==='interchange'||f==='yard'||f==='sidewalk') return true;
  { const dec=(w,h,c,x,z,rot)=>{ const d=flatDecal(w,h,c,0.98); d.position.set(x||0,TOP+0.05,z||0); d.rotation.y=rot||0; group.add(d); };
    if(f==='factory'){ dec(0.62,0.38,0x7a8088); dec(0.62,0.05,0x9fb6c6,0,-0.1); dec(0.07,0.07,0x9a8a7a,-0.22,0.14); return true; }
    if(f==='warehouse'){ dec(0.7,0.36,0xb9bcc0,0,-0.06); dec(0.7,0.18,0x6e6a60,0,0.2); return true; }
    if(f==='tankfarm'){ for(const [x,z,rr] of [[-0.2,-0.2,0.16],[0.2,-0.2,0.14],[-0.2,0.2,0.13],[0.21,0.21,0.1]]){ const m=new THREE.Mesh(new THREE.CircleGeometry(rr,20),new THREE.MeshBasicMaterial({color:0xe9ecee,depthWrite:false})); m.rotation.x=-Math.PI/2; m.position.set(x,TOP+0.05,z); m.renderOrder=3; group.add(m); } return true; }
    if(f==='depot'){ for(let i=0;i<5;i++) dec(0.06,0.3,0xe9ecee,-0.24+i*0.12,0.12); return true; }
    if(f==='beach'){ for(let i=0;i<6;i++){ const m=new THREE.Mesh(new THREE.CircleGeometry(0.03,8),new THREE.MeshBasicMaterial({color:[0xe74c3c,0x3498db,0xf1c40f][i%3],depthWrite:false})); m.rotation.x=-Math.PI/2; m.position.set((r()-0.5)*0.7,TOP+0.05,(r()-0.5)*0.7); m.renderOrder=3; group.add(m); } return true; }
    if(f==='lighthouse'){ const m=new THREE.Mesh(new THREE.CircleGeometry(0.065,16),new THREE.MeshBasicMaterial({color:0xf4f5f6,depthWrite:false})); m.rotation.x=-Math.PI/2; m.position.y=TOP+0.05; m.renderOrder=3; group.add(m); dec(0.03,0.03,0xc0392b,0,0); return true; }
    if(f==='hotel'){ dec(0.34,0.14,0xf3e6d0,0,0); dec(0.16,0.08,0x3fb0d8,0,0.19); return true; }
    if(f==='marina'||f==='pier'){ const gr=TE.gridFor(gridKind), [ex,ez]=gr.edgeMid(info.dir||0); dec(f==='pier'?0.16:0.04,1.0,0x8a6a44,0,0,Math.atan2(ex,ez)); return true; }
    if(f==='powerplant'){ const sub=new THREE.Group(); if(gridKind==='square') sub.position.set(((info.w||2)-1)/2,0,((info.h||2)-1)/2); for(const x of [-0.3,0.3]){ const m=new THREE.Mesh(new THREE.CircleGeometry(0.4,24),new THREE.MeshBasicMaterial({color:0xcac6bd,depthWrite:false})); m.rotation.x=-Math.PI/2; m.position.set(x,TOP+0.05,-0.2); m.renderOrder=3; sub.add(m); } group.add(sub); return true; }
    if(f==='sidings') return true; }
  if(f==='airport'||f==='military'||f==='spacehub'||f==='port'){ const W=info.w||2, H=info.h||2, sub=_siteFlat(f,gridKind,W,H,info.dir||0); if(gridKind==='square') sub.position.set((W-1)/2,0,(H-1)/2); group.add(sub); return true; }
  if(f==='skyscraper'){ const N=info.n||2, off=gridKind==='square'?(N-1)/2:0, k=gridKind==='hex'?0.62*(2*N-1)*0.72:N*0.92, sub=new THREE.Group(); sub.position.set(off,0,off); group.add(sub);
    for(const [w,c,y] of [[0.62*k,0xb5b3ad,0.05],[0.44*k,0x3f566b,0.051],[0.35*k,0x4b6a86,0.052],[0.26*k,0x8fb4d6,0.053]]){ const d=flatDecal(w,w,c,0.99); d.position.y=TOP+y; sub.add(d); } return true; }
  if(f==='stadium'){ const W=info.w||2, H=info.h||2, sub=_stadiumFlat(gridKind,W,H); if(gridKind==='square') sub.position.set((W-1)/2,0,(H-1)/2); group.add(sub); return true; }
  if((f==='station'||f==='elevator') && railDirs && railDirs.length){ group.add(_tileTrain(railDirs, f==='station'?['commuter','commuter','commuter']:['hopper','hopper','hopper'], r, true)); }
  const dec=(w,h,c,x,z,rot,y)=>{ const d=flatDecal(w,h,c,0.98); d.position.set(x||0,TOP+(y||0.05),z||0); d.rotation.y=rot||0; group.add(d); return d; };
  const dot=(rad,c,x,z,y)=>{ const m=new THREE.Mesh(new THREE.CircleGeometry(rad,16), new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:0.97,depthWrite:false})); m.rotation.x=-Math.PI/2; m.position.set(x,TOP+(y||0.051),z); m.renderOrder=3; group.add(m); };
  const sp=(n,gap)=>{ const got=[]; for(const p of pts){ if(got.length>=n) break; if(got.every(q=>Math.hypot(q[0]-p[0],q[1]-p[1])>=gap)) got.push(p); } return got; };
  if(f==='towers'){ sp(2,0.3).forEach(([x,z])=>{ const s=0.2+r()*0.08; dec(s*1.1,s*1.1,0x000000,x+0.02,z+0.03,0,0.046).material.opacity=0.35; dec(s,s,[0x5b6f82,0x6f7a84,0x4a6273][(r()*3)|0],x,z); dec(s*0.55,s*0.55,0x8e979e,x,z,0,0.052); }); return true; }
  if(f==='apartments'){ sp(2,0.34).forEach(([x,z])=>{ const rot=r()*0.4; dec(0.27,0.17,[0xa4553f,0xc8b18e,0xb9b7b0][(r()*3)|0],x,z,rot); dec(0.2,0.1,0x5d6166,x,z,rot,0.052); }); return true; }
  if(f==='shops'){ sp(3,0.25).forEach(([x,z])=>{ const rot=r()*0.5; dec(0.16,0.13,0x7d8286,x,z,rot); dec(0.16,0.03,[0xb8322b,0x2f6f9a,0x3d8a4a,0xd08a2a][(r()*4)|0],x,z+0.05,rot,0.052); }); return true; }
  if(f==='homes'){ sp(3,0.3).forEach(([x,z])=>{ group.add(flatRoof(x,z,false,r)); dec(0.1,0.05,0x9a9a98,x+0.1,z,0,0.047); }); return true; }
  if(f==='church'){ dec(0.14,0.26,0xf1efe8,0,0); dec(0.03,0.12,0x8a7a4a,0,-0.02,0,0.052); dec(0.09,0.03,0x8a7a4a,0,-0.04,0,0.052); return true; }
  if(f==='school'){ dec(0.5,0.16,0xa4553f,0,-0.1); dec(0.16,0.26,0xa4553f,-0.17,0.1); return true; }
  if(f==='station'){ dec(0.14,0.8,0xb7b3aa,0.14,0); dec(0.14,0.3,0x7a2f2a,0.3,0,0,0.052); return true; }
  if(f==='lot'){ for(const zr of [-0.2,0.2]) for(let i=0;i<7;i++){ dec(0.005,0.1,0xf2f2f2,-0.385+i*0.11,zr,0,0.049); if(r()<0.68) dec(0.05,0.085,[0xc0392b,0x2c3e50,0xecf0f1,0x2980b9,0xf1c40f][(r()*5)|0],-0.33+i*0.11,zr,0,0.052); } return true; }
  if(f==='park'||f==='plaza'){ for(let i=0;i<6;i++){ const a=i/6*6.28, rr=0.32; dot(0.06,0x3f7a34,Math.cos(a)*rr,Math.sin(a)*rr); } dot(0.1,f==='plaza'?0xb5b1a8:0x4f9fcf,0,0); return true; }
  if(f==='sportsfield'){ dec(0.62,0.4,0x4f8f3a,0,0); dec(0.005,0.38,0xffffff,0,0,0,0.052); return true; }
  if(f==='streetside'){ for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]) dot(0.045,0x3f7a34,sx*0.34,sz*0.34); return true; }
  if(f==='farmstead'){ dec(0.17,0.24,0xa8322a,0.12,0.06); dec(0.17,0.03,0x55585c,0.12,0.06,0,0.052); group.add(flatRoof(-0.17,-0.12,false,r)); dot(0.04,0xb5bcc2,0.28,-0.14); return true; }
  if(f==='turbines'){ for(let i=0;i<3;i++) dec(0.018,0.3,0xf2f4f5,Math.sin(i*2.09)*0.13,Math.cos(i*2.09)*0.13,i*2.09); dot(0.02,0xdddddd,0,0,0.053); return true; }
  if(f==='watertower'){ dot(0.11,0xdfe7ec,0,0); dot(0.05,0x2f5f9a,0,0,0.053); return true; }
  if(f==='elevator'){ for(let i=0;i<4;i++) dot(0.05,0xcac6bd,-0.15+i*0.1,0); return true; }
  return f==='railside'; }

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
function flatRoof(x,z,big,r){ const g=new THREE.Group();                        // top-down GABLED roof: sunlit + shaded halves, ridge, chimney
  const base=big?0.24:0.18, w=base*(0.85+r()*0.35), h=w*(0.72+r()*0.25), rot=r()*3.14;
  const sets = big ? [[0xa34a33,0x7a3322],[0x56606f,0x3a414d],[0x8d4a2f,0x62301c]] : [[0xd0ab62,0xa3833f],[0xc39a55,0x93713a],[0xa34a33,0x7a3322],[0xb0613e,0x80401f]];
  const [lt,dk]=sets[(r()*sets.length)|0];
  const sh=flatDecal(w*1.15,h*1.2,0x000000,0.3); sh.position.set(x+0.014,TOP+0.045,z+0.016); sh.rotation.y=rot; g.add(sh);   // soft shadow
  const px=Math.sin(rot)*h/4, pz=Math.cos(rot)*h/4;                              // the decal's local +z (across the ridge) after turning by rot
  const a=flatDecal(w,h/2,lt,0.99); a.position.set(x-px,TOP+0.05,z-pz); a.rotation.y=rot; g.add(a);
  const b=flatDecal(w,h/2,dk,0.99); b.position.set(x+px,TOP+0.05,z+pz); b.rotation.y=rot; g.add(b);
  const ridge=flatDecal(w*1.02,h*0.07,0x3a2a1c,0.85); ridge.position.set(x,TOP+0.052,z); ridge.rotation.y=rot; g.add(ridge);
  const ch=flatDecal(0.024,0.024,0x6f6358,0.98); ch.position.set(x+Math.cos(rot)*w*0.28-px*0.5,TOP+0.054,z-Math.sin(rot)*w*0.28-pz*0.5); g.add(ch);
  return g; }

// scatter a feature over the tile, keeping clear of any path strips. `mass` (0..1) = mountain-massif depth:
// core cells build a tall central peak + satellites, fringe cells a single small foothill.
/* ---- CASTLE PIECES: gatehouse, drawbridge, tall keep (settlement + world-map castles) ---- */
const _stone=()=>mat(0x8f8a90,{roughness:0.85}), _stoneLt=()=>mat(0xa29ca2,{roughness:0.8}), _slate=()=>mat(0x44495e,{roughness:0.7}), _wood=()=>mat(0x7a5230,{roughness:1}), _woodDk=()=>mat(0x4f3420,{roughness:1}), _iron=()=>mat(0x2b2b30,{roughness:0.5,metalness:0.6});
function _ringMerlons(group, x, y, z, rad, n, k){ const m=_stoneLt();
  for(let i=0;i<n;i++){ const a=i/n*Math.PI*2; const b=new THREE.Mesh(new THREE.BoxGeometry(0.035*k,0.05*k,0.035*k), m);
    b.position.set(x+Math.cos(a)*rad, y+0.025*k, z+Math.sin(a)*rad); b.rotation.y=-a; group.add(_overTiles(b)); } }
function _tower(group, x, z, rad, h, k, roof){               // round tower + crenellated top (+ optional conical roof)
  const t=new THREE.Mesh(new THREE.CylinderGeometry(rad, rad*1.08, h, 12), _stone()); t.position.set(x, TOP+h/2, z); t.castShadow=true; group.add(_overTiles(t));
  const lip=new THREE.Mesh(new THREE.CylinderGeometry(rad*1.18, rad*1.18, 0.03*k, 12), _stoneLt()); lip.position.set(x, TOP+h, z); group.add(_overTiles(lip));
  if(roof){ const c=new THREE.Mesh(new THREE.ConeGeometry(rad*1.25, roof, 12), _slate()); c.position.set(x, TOP+h+roof/2+0.015*k, z); c.castShadow=true; group.add(_overTiles(c)); }
  else _ringMerlons(group, x, TOP+h+0.015*k, z, rad*1.05, 8, k);
}
/* GATEHOUSE on wall edge `dir`: two flanking round towers, a crenellated arch block over the road and a
   half-raised iron portcullis — sits on the curtain-wall line so the wall runs straight into it. */
function gatehouse(group, g, dir, gridKind){
  const k = gridKind==='hex' ? 0.72 : 1, L = edgeLenOf(gridKind);
  const [ex,ez]=g.edgeMid(dir), n=Math.atan2(ex,ez), tx=Math.sin(n+Math.PI/2), tz=Math.cos(n+Math.PI/2);
  const half=L*0.34, open=0.2*k, H=0.46*k;
  for(const s of [-1,1]) _tower(group, ex+tx*s*half, ez+tz*s*half, 0.1*k, 0.56*k, k, 0.2*k);
  // arch block: two piers + lintel spanning the road, with merlons on top
  const span=half*2-0.16*k, depth=0.2*k, st=_stone();
  const lin=new THREE.Mesh(new THREE.BoxGeometry(span, H-open, depth), st); lin.position.set(ex, TOP+open+(H-open)/2, ez); lin.rotation.y=Math.atan2(-tz,tx); group.add(_overTiles(lin));
  const nM=4; for(let i=0;i<nM;i++){ const s=(i/(nM-1)-0.5)*span*0.9; const m=new THREE.Mesh(new THREE.BoxGeometry(0.05*k,0.06*k,depth*1.02), _stoneLt());
    m.position.set(ex+tx*s, TOP+H+0.03*k, ez+tz*s); m.rotation.y=lin.rotation.y; group.add(_overTiles(m)); }
  // rounded arch over the opening (voussoirs)
  const ar=span*0.36, seg=7; for(let i=0;i<=seg;i++){ const a=Math.PI*i/seg, s=Math.cos(a)*ar;
    const v=new THREE.Mesh(new THREE.BoxGeometry(0.04*k,0.04*k,depth*1.04), _stoneLt()); v.position.set(ex+tx*s, TOP+open-0.02*k+Math.sin(a)*ar*0.35, ez+tz*s); v.rotation.y=lin.rotation.y; group.add(_overTiles(v)); }
  // portcullis: iron grille, half raised, just behind the arch face
  const iron=_iron(), bars=5, pw=span*0.62;
  for(let i=0;i<bars;i++){ const s=(i/(bars-1)-0.5)*pw; const b=new THREE.Mesh(new THREE.BoxGeometry(0.012*k,open*0.55,0.012*k), iron);
    b.position.set(ex+tx*s, TOP+open*0.72, ez+tz*s); group.add(_overTiles(b)); }
  const cross=new THREE.Mesh(new THREE.BoxGeometry(pw,0.012*k,0.012*k), iron); cross.position.set(ex, TOP+open*0.6, ez); cross.rotation.y=lin.rotation.y; group.add(_overTiles(cross));
  // banner over the gate
  const ban=new THREE.Mesh(new THREE.PlaneGeometry(0.08*k,0.12*k), mat(0xa3232b,{side:THREE.DoubleSide,roughness:0.9}));
  const eh=Math.hypot(ex,ez); ban.position.set(ex+ex/eh*depth*0.53, TOP+open+(H-open)*0.5, ez+ez/eh*depth*0.53); ban.rotation.y=n; group.add(_overTiles(ban));
}
/* DRAWBRIDGE across a moat cell: plank deck hinged on edge `dir` (the gate side) spanning the water to the far
   bank, with side beams and the two chains running up to the gatehouse. */
function drawbridge(group, g, dir, gridKind){
  const k = gridKind==='hex' ? 0.72 : 1;
  const [ex,ez]=g.edgeMid(dir), len=Math.hypot(ex,ez)*2, ux=ex/Math.hypot(ex,ez), uz=ez/Math.hypot(ex,ez), ang=Math.atan2(ex,ez);
  const W=0.34*k, y=TOP+0.035, wd=_wood(), dk=_woodDk();
  const deck=new THREE.Mesh(new THREE.BoxGeometry(W, 0.03, len*1.02), wd); deck.position.set(0, y, 0); deck.rotation.y=ang; deck.castShadow=true; group.add(_overTiles(deck));
  const nP=Math.max(6,Math.round(len/0.07)); for(let i=0;i<nP;i++){ const t=(i+0.5)/nP-0.5;           // plank seams
    const s=new THREE.Mesh(new THREE.BoxGeometry(W*1.01,0.004,0.008), dk); s.position.set(ux*t*len, y+0.016, uz*t*len); s.rotation.y=ang; group.add(_overTiles(s)); }
  const px=Math.cos(ang), pz=-Math.sin(ang);                                                             // across-deck unit
  for(const s of [-1,1]){ const b=new THREE.Mesh(new THREE.BoxGeometry(0.03*k,0.05*k,len*1.02), dk); b.position.set(px*s*W/2, y+0.03*k, pz*s*W/2); b.rotation.y=ang; group.add(_overTiles(b));
    // chain: from the deck's OUTER end up to the gatehouse face above the hinge
    const a=new THREE.Vector3(-ux*len*0.42+px*s*W*0.45, y+0.03, -uz*len*0.42+pz*s*W*0.45), c=new THREE.Vector3(ex*0.98+px*s*W*0.45, TOP+0.36*k, ez*0.98+pz*s*W*0.45);
    const mid=a.clone().add(c).multiplyScalar(0.5), dv=c.clone().sub(a), ch=new THREE.Mesh(new THREE.CylinderGeometry(0.006,0.006,dv.length(),5), _iron());
    ch.position.copy(mid); ch.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dv.normalize()); group.add(_overTiles(ch)); }
  // stone abutment at the far bank
  const ab=new THREE.Mesh(new THREE.BoxGeometry(W*1.25,0.05,0.07*k), _stone()); ab.position.set(-ux*len*0.47, TOP+0.025, -uz*len*0.47); ab.rotation.y=ang; group.add(_overTiles(ab));
}
/* KEEP: a tall square donjon with corner turrets and a central great tower, roofed + flagged — the castle's
   landmark, clearly taller than the curtain walls and halls around it. */
// N = keep size (1 = the original 1-tile keep; 2..4 = a 2×2 … 4×4-square keep block, hex: 7/19/37 hexes). The
// footprint scales with the block; height grows more gently so a big keep reads as MASSIVE, not a needle.
// Bigger keeps also gain mid-wall towers (N≥2) and an inner ring of turrets round the great tower (N≥3).
function keepTower(group, gridKind, N){
  N = N||1; const base = gridKind==='hex' ? 0.62 : 1;
  const k = N===1 ? base : (gridKind==='hex' ? 0.62*(2*N-1)*0.72 : N*0.92);           // footprint scale
  const kh = N===1 ? base : base*(1+(k/base-1)*0.45);                                 // height scale
  const w=0.36*k, h=0.62*kh, st=_stone();
  const body=new THREE.Mesh(new THREE.BoxGeometry(w,h,w), st); body.position.y=TOP+h/2; body.castShadow=true; group.add(_overTiles(body));
  const n=4+(N-1)*3; for(let side=0;side<4;side++) for(let i=0;i<n;i++){ const s=(i/(n-1)-0.5)*w*0.86, m=new THREE.Mesh(new THREE.BoxGeometry(0.045*kh,0.055*kh,0.045*kh), _stoneLt());
    const [x,z] = side===0?[s,-w/2]:side===1?[w/2,s]:side===2?[s,w/2]:[-w/2,s]; m.position.set(x, TOP+h+0.028*kh, z); group.add(_overTiles(m)); }
  for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]) _tower(group, sx*w/2, sz*w/2, 0.055*k, h*1.2, kh, 0.15*kh);
  if(N>=2) for(const [sx,sz] of [[0,-1],[1,0],[0,1],[-1,0]]) _tower(group, sx*w/2, sz*w/2, 0.045*k, h*1.1, kh, 0.12*kh);   // mid-wall towers
  if(N>=3) for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]) _tower(group, sx*w*0.22, sz*w*0.22, 0.05*k, h+0.25*kh, kh, 0.16*kh);   // inner turrets
  const gh=0.5*kh; _tower(group, 0, 0, 0.11*k, h+gh, kh, 0.28*kh);                                   // central great tower
  const topY=TOP+h+gh+0.3*kh;
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.006*kh,0.006*kh,0.16*kh,5), _iron()); pole.position.set(0, topY+0.08*kh, 0); group.add(_overTiles(pole));
  const flag=new THREE.Mesh(new THREE.PlaneGeometry(0.1*kh,0.06*kh), mat(0xb3262e,{side:THREE.DoubleSide,roughness:0.9})); flag.position.set(0.05*kh, topY+0.13*kh, 0); group.add(_overTiles(flag));
  // window slits (more rows / columns on a bigger keep)
  const slit=mat(0x1c1c22), cols=N===1?1:N+1; for(let side=0;side<4;side++) for(const fy of [0.35,0.65]) for(let c=0;c<cols;c++){ const sl=new THREE.Mesh(new THREE.BoxGeometry(0.018*kh,0.06*kh,0.004), slit);
    const a=side*Math.PI/2, off=cols===1?0:(c/(cols-1)-0.5)*w*0.6, nx=Math.sin(a), nz=Math.cos(a);
    sl.position.set(nx*(w/2+0.002)+nz*off, TOP+h*fy, nz*(w/2+0.002)-nx*off); sl.rotation.y=a; group.add(_overTiles(sl)); }
}
// the low curtain wall around a BIG keep's block (gates mid-side), in the block's own frame
function _keepBlockWall(group, gridKind, N){
  if(gridKind==='hex'){ const rr=(N-0.5)*0.75, n=10*N; for(let i=0;i<n;i++){ const a=(i+0.5)/n*Math.PI*2, ex=Math.sin(a)*rr, ez=Math.cos(a)*rr, L=2*Math.PI*rr/n*1.04;
      if(i%Math.round(n/4)===0) archGate(group, ex, ez, L*1.6, 0.22); else wallSeg(group, ex, ez, L, 0.22); } return; }
  const half=N/2*0.93;
  for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]) _tower(group, sx*half, sz*half, 0.085, 0.3, 1, null);   // corner towers close the wall's corners
  for(let side=0;side<4;side++) for(let i=0;i<N;i++){ const t=-N/2+0.5+i;
    const [ex,ez] = side===0?[t,-half]:side===1?[half,t]:side===2?[t,half]:[-half,t];
    const nx = side===1?1:side===3?-1:0, nz = side===2?1:side===0?-1:0;             // wallSeg orients from the outward normal
    const sub=new THREE.Group(); sub.position.set(ex-nx*0.5, 0, ez-nz*0.5); group.add(sub);
    if(i===Math.floor(N/2)) archGate(sub, nx*0.5, nz*0.5, 1, 0.22); else wallSeg(sub, nx*0.5, nz*0.5, 1, 0.22); }
}
// a raised plateau's cliff: a slab of height h under a tile lifted by h (snowfields up in the mountains)
export function liftSkirt(gridKind, h){
  const g=TE.gridFor(gridKind), m=new THREE.Mesh(slabGeo(g.corners(), h), mat(0x9aa3ad,{roughness:0.95}));
  m.position.y=-h; m.receiveShadow=true; m.castShadow=true; return m; }

/* TUNNEL PORTAL on tile edge dir (a road / the highway entering the mountain): concrete facade with a dark arched
   bore, set into a rocky shoulder so the road visibly disappears INTO the mountain. big = the elevated highway. */
function _tunnelPortal(g, dir, big){ const grp=new THREE.Group(); const [ex,ez]=g.edgeMid(dir), L=Math.hypot(ex,ez), ux=ex/L, uz=ez/L;
  const inner=new THREE.Group(); inner.position.set(ex*0.86, 0, ez*0.86); inner.rotation.y=Math.atan2(ux,uz); grp.add(inner);   // local +z = out of the mountain
  const conc=mat(0xa7a39b,{roughness:0.9}), dark=mat(0x0e0f12,{roughness:1});
  const W=big?0.5:0.3, H=big?0.36:0.19, ow=big?0.4:0.2, oy0=big?0.1:0, oh=big?0.22:0.12;
  const face=new THREE.Mesh(new THREE.BoxGeometry(W,H,0.07),conc); face.position.set(0,TOP+H/2,0); face.castShadow=true; inner.add(_overTiles(face));
  const bore=new THREE.Mesh(new THREE.BoxGeometry(ow,oh,0.08),dark); bore.position.set(0,TOP+oy0+oh/2,0.004); inner.add(_overTiles(bore));
  const arch=new THREE.Mesh(new THREE.CylinderGeometry(ow/2,ow/2,0.08,16,1,false,0,Math.PI),dark); arch.rotation.z=Math.PI/2; arch.rotation.y=Math.PI/2; arch.position.set(0,TOP+oy0+oh,0.004); inner.add(_overTiles(arch));
  const cap=new THREE.Mesh(new THREE.BoxGeometry(W*1.06,0.03,0.09),mat(0x8f8b84,{roughness:0.9})); cap.position.set(0,TOP+H+0.015,0); inner.add(_overTiles(cap));
  for(const s of [-1,1]){ const w=new THREE.Mesh(new THREE.BoxGeometry(0.03,H*0.7,0.14),conc); w.position.set(s*(W/2-0.015),TOP+H*0.35,0.06); w.rotation.y=s*0.35; inner.add(_overTiles(w)); }   // wing walls
  const rock=peak(0,0,big?1.1:0.8,rng32((dir*977+13)>>>0)); rock.position.set(ex*0.6,0,ez*0.6); grp.add(rock);                  // the mountainside it's cut into
  return grp; }
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
  let f = def.feature;
  const take=(n)=>pts.slice(0,n);
  { const tun=/^tunnel(\d*)$/.exec(f||''); if(tun){ f='peaks';                                   // a mountain a road tunnels through: peaks + portals
      if(_scale!=='battle') for(const d of tun[1].split('').filter(Boolean).map(Number)){ const big=def.edges[d] && def.edges[d].path===P.HWY;
        if(_flat){ const [ex,ez]=g.edgeMid(d), m=new THREE.Mesh(new THREE.CircleGeometry(big?0.18:0.1,16,0,Math.PI),new THREE.MeshBasicMaterial({color:0x0e0f12,transparent:true,opacity:0.95,depthWrite:false}));
          m.rotation.x=-Math.PI/2; m.rotation.z=Math.atan2(ex,ez)+Math.PI; m.position.set(ex*0.92,TOP+0.056,ez*0.92); m.renderOrder=4; group.add(m); }
        else group.add(_tunnelPortal(g, d, big)); } } }
  // BATTLE SCALE: region features (forests, peaks, buildings) become board-level multi-tile props; a single
  // tile only keeps ground-level extras (water surface, a bridge, a shoreline). See makeBattleProp + host pass.
  if(_scale==='battle' && f!=='water' && f!=='bridge' && f!=='shore' && !/^drawbridge/.test(f||'')) return;
  // 2D BOARD MODE: flat top-down decals instead of raised geometry (textured biomes already read from above).
  if(_flat){
    { const mb=_modernBase(f); if(MODERN_FEATS.has(mb.f)){ modernFlat(group, mb.f, pts, r, mass, mb, gridKind, def.edges.map((e,i)=>e.path===P.RAIL?g.edgeMid(i):null).filter(Boolean)); return; } }
    if(f==='houses'||f==='buildings'){ const got=[]; for(const p of pts){ if(got.length>=(f==='buildings'?4:3)) break; if(got.every(q=>Math.hypot(q[0]-p[0],q[1]-p[1])>=0.24)) got.push(p); }
      got.forEach(([x,z])=> group.add(flatRoof(x,z,f==='buildings',r))); return; }
    { const km=/^keep(\d)?$/.exec(f||''); if(km){ const N=+(km[1]||1), off=(gridKind==='square'&&N>1)?(N-1)/2:0;
      const s = N===1 ? 1 : (gridKind==='hex' ? (2*N-1)*0.72 : N*0.92);
      const sub=new THREE.Group(); sub.position.set(off,0,off); group.add(sub);
      const k=flatDecal(0.34*s,0.34*s,0x8a8a92,0.98); k.position.y=TOP+0.05; sub.add(k);
      for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const t=flatDecal(0.1*s,0.1*s,0x6f676d,0.98); t.position.set(sx*0.15*s,TOP+0.052,sz*0.15*s); sub.add(t);}
      const gt=flatDecal(0.16*s,0.16*s,0x44495e,0.98); gt.position.y=TOP+0.054; sub.add(gt); return; } }
    if(f==='keepyard') return;
    { const cp=/^(gate|drawbridge)(\d)$/.exec(f||''); if(cp){ const [ex,ez]=g.edgeMid(+cp[2]), a=Math.atan2(ex,ez);
      if(cp[1]==='drawbridge'){ const d=flatDecal(0.34,Math.hypot(ex,ez)*2,0x7a5230,0.98); d.rotation.y=a; d.position.y=TOP+0.05; group.add(d); }
      else { const L=edgeLenOf(gridKind), tx=Math.sin(a+Math.PI/2), tz=Math.cos(a+Math.PI/2); for(const s of [-1,1]){ const t=flatDecal(0.2,0.2,0x6f676d,0.98); t.position.set(ex+tx*s*L*0.34, TOP+0.052, ez+tz*s*L*0.34); group.add(t); } }
      return; } }
    if(f==='peaks'){ const M=(typeof mass==='number')?mass:0.5; take(1+Math.round(M*3)).forEach(([x,z],i)=>{ const s=0.1+M*0.16*(i?0.6:1);
      const c=flatDecal(s,s,snowPeaks?0xdfe9f2:0x726a5c,0.92); c.position.set(x,TOP+0.05,z); c.rotation.y=r()*1.57; group.add(c);      // snow-white crag dots for the snow-capped variant
      if(snowPeaks){ const cap=flatDecal(s*0.5,s*0.5,0xffffff,0.95); cap.position.set(x,TOP+0.052,z); cap.rotation.y=c.rotation.y; group.add(cap); } }); return; }
    if(f==='trees'||f==='tufts'||f==='farm'||f==='treeline'||f==='foothills'||f==='citywall'||f==='field') return;   // carried by the painted top / omitted in 2D
    // water / bridge / shore fall through to their (already-flat) handlers below
  }
  const mbase=_modernBase(f), fM=mbase.f;                                     // homes<d> (faces the street on edge d) · skyscraper<N> · stadium<W>x<H>
  if(MODERN_FEATS.has(fM)){ const railDirs=def.edges.map((e,i)=>e.path===P.RAIL?g.edgeMid(i):null).filter(Boolean);
    const roomy=(x,z)=>{ if(hasPath && Math.hypot(x,z)<0.22) return false; for(const [ex,ez] of pathDirs){ const t=Math.max(0,Math.min(1,(x*ex+z*ez)/(ex*ex+ez*ez))); if(Math.hypot(x-ex*t,z-ez*t)<0.22) return false; } return true; };
    modernScatter(group, def, gridKind, fM, pts, r, mass, pathDirs, railDirs, roomy, mbase.face!=null?mbase.face:-1, mbase); return; }
  const cp=/^(gate|drawbridge)(\d)$/.exec(f||'');
  if(cp){ if(cp[1]==='gate') gatehouse(group, g, +cp[2], gridKind); else drawbridge(group, g, +cp[2], gridKind); return; }
  if(f==='trees')       take(8).forEach(([x,z])=> group.add(tree(x,z,0.8+r()*0.5)));
  else if(f==='tufts')  take(5).forEach(([x,z])=> group.add(tuft(x,z)));
  else if(f==='peaks'){ const M = (typeof mass==='number') ? mass : (0.35+r()*0.5);   // core=tall massif, fringe=small foothill
    const big = 0.6 + M*1.9, n = 1 + Math.round(M*3);
    group.add(peak((r()*2-1)*0.14, (r()*2-1)*0.14, big, r, snowPeaks));                 // central summit near tile centre
    for(let i=1;i<n;i++){ const [x,z]=pts[i]||[(r()*2-1)*rad,(r()*2-1)*rad]; group.add(peak(x,z, big*(0.38+r()*0.42), r, snowPeaks)); } }  // lower shoulders
  else if(f==='houses'||f==='buildings'){ // cottages / town houses spaced apart, each turned to face the lane through the middle of the plot
    const big=f==='buildings', want=big?4:3+((r()*2)|0), gap=big?0.27:0.23, got=[];
    const roomy=(x,z)=>{ if(hasPath && Math.hypot(x,z)<0.24) return false; for(const [ex,ez] of pathDirs){ const t=Math.max(0,Math.min(1,(x*ex+z*ez)/(ex*ex+ez*ez))); if(Math.hypot(x-ex*t,z-ez*t)<0.23) return false; } return true; };
    for(const p of pts){ if(got.length>=want) break; if(roomy(p[0],p[1]) && got.every(q=>Math.hypot(q[0]-p[0],q[1]-p[1])>=gap)) got.push(p); }
    got.forEach(([x,z])=>{ const face=Math.atan2(z, -x)+(r()-0.5)*0.5; group.add(house(x,z,face,big,r)); });   // local +x (the door) → toward the tile centre
    if(!big && got.length && r()<0.7){ const free=pts.filter(p=>got.every(q=>Math.hypot(q[0]-p[0],q[1]-p[1])>=0.15)); if(free[0]) group.add(_garden(free[0][0],free[0][1],r()*3.14,r)); } }
  else if(f==='farm' && pts[0]){ group.add(house(pts[0][0],pts[0][1],Math.atan2(pts[0][1],-pts[0][0]),false,r));
    const p2=pts.find(p=>Math.hypot(p[0]-pts[0][0],p[1]-pts[0][1])>0.2); if(p2) group.add(_garden(p2[0],p2[1],r()*3.14,r)); }
  else if(f==='keepyard'){ /* ground under a big keep — the anchor tile draws the whole keep */ }
  else if(/^keep\d?$/.test(f||'')){ // castle: tall keep (donjon + turrets + great tower) + ring wall around the perimeter (gap at the road/gate edge)
    const N=+((/^keep(\d)$/.exec(f)||[])[1]||1);
    if(N>1){ const off=gridKind==='square'?(N-1)/2:0, sub=new THREE.Group(); sub.position.set(off,0,off); group.add(sub);
      keepTower(sub, gridKind, N); _keepBlockWall(sub, gridKind, N); return; }
    keepTower(group, gridKind);
    for(let dir=0; dir<g.N; dir++){ const [ex,ez]=g.edgeMid(dir); const p=def.edges[dir].path;
      if(p===P.ROAD||p===P.TRAIL) archGate(group, ex*0.86, ez*0.86, edgeLenOf(gridKind), 0.24);     // arched gateway where the road enters
      else if(p===P.NONE) wallSeg(group, ex*0.86, ez*0.86, edgeLenOf(gridKind), 0.24); } }
  else if(f==='water'){ // a single TRANSPARENT glossy surface sitting on the deep-blue base slab → water you can
    // see into (depth), not a second stacked block. (Was a 0.02-thick slab which, after the slab-height fix,
    // stacked visibly on top of the base — Paul: "double stacked; I liked the transparent look before".)
    const w=new THREE.Mesh(topGeo(gridKind), new THREE.MeshStandardMaterial({ color:0x6fb8e6, roughness:0.16, metalness:0.35, transparent:true, opacity:0.55, depthWrite:false }));
    w.position.y=TOP+0.006; w.renderOrder=1; group.add(w); }
  else if(f==='bridge'){ const modernB=/^(urban|suburb|park|lot)$/.test(def.biome) || def.edges.some(e=>e.path===P.RAIL);   // concrete deck for streets / railways
    const pl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.04,modernB?0.34:0.26), mat(modernB?0x8e9196:0x6b4a2e,{roughness:1})); pl.position.y=TOP+0.05; group.add(pl); }
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
    else if (MODERN_FEATS.has(_modernBase(def.feature).f) || def.feature==='houses' || def.feature==='buildings' || def.feature==='farm' || /^keep\d?$/.test(def.feature||'') || def.feature==='peaks' || /^tunnel\d*$/.test(def.feature||'') || /^(gate|drawbridge)\d$/.test(def.feature||'')) scatter(grp, def, gridKind, seed||1, mass, variant);
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
// MODERN PACK strip textures: asphalt street (white edge lines, dashed yellow centre) · railway (ballast, sleepers, two rails)
let _streetTex, _streetPlainTex, _railTex;
function streetTex(){ return _streetTex || (_streetTex = makeStripTex((x,w,h)=>{
  x.fillStyle='#3e4044'; x.fillRect(0,0,w,h); for(let i=0;i<500;i++){ const v=50+Math.random()*30|0; x.fillStyle=`rgba(${v},${v},${v+3},.6)`; x.fillRect(Math.random()*w,Math.random()*h,1.2,1.2); }
  x.fillStyle='#a9abae'; x.fillRect(0,0,w*0.07,h); x.fillRect(w*0.93,0,w*0.07,h);                 // kerbs / sidewalk edge
  x.fillStyle='rgba(240,240,236,.85)'; x.fillRect(w*0.11,0,w*0.025,h); x.fillRect(w*0.865,0,w*0.025,h);
  x.fillStyle='#e8c230'; x.fillRect(w*0.485,0,w*0.03,h*0.55); },64,64)); }
function streetPlainTex(){ return _streetPlainTex || (_streetPlainTex = makeStripTex((x,w,h)=>{ x.fillStyle='#3e4044'; x.fillRect(0,0,w,h);
  for(let i=0;i<500;i++){ const v=50+Math.random()*30|0; x.fillStyle=`rgba(${v},${v},${v+3},.6)`; x.fillRect(Math.random()*w,Math.random()*h,1.2,1.2); } },64,64)); }
function railTex(){ return _railTex || (_railTex = makeStripTex((x,w,h)=>{
  x.fillStyle='#766c62'; x.fillRect(0,0,w,h); for(let i=0;i<700;i++){ const v=90+Math.random()*60|0; x.fillStyle=`rgba(${v},${v-6},${v-12},.7)`; x.fillRect(Math.random()*w,Math.random()*h,2,2); }
  x.fillStyle='#4a3524'; for(let y=2;y<h;y+=10) x.fillRect(w*0.14,y,w*0.72,5);                   // sleepers
  x.fillStyle='#c9ccd0'; x.fillRect(w*0.3,0,w*0.05,h); x.fillRect(w*0.65,0,w*0.05,h);            // rails
  x.fillStyle='rgba(0,0,0,.35)'; x.fillRect(w*0.35,0,w*0.015,h); x.fillRect(w*0.7,0,w*0.015,h); },64,60)); }
const DRAW_SPEC = {
  // modern streets + railways are DEPTH-TESTED: they lie on the ground, so skyscrapers, stadiums and trains hide them
  // properly (the classic always-on-top ribbons painted straight across a 40-storey tower)
  highwayflat: ()=>({ tex:highwayTex(), w:_scale==='battle'?3.2:0.34, y:TOP+0.045, ro:8, depth:true }),
  street: ()=>({ tex:streetTex(), w:_scale==='battle'?5:0.2, y:TOP+0.034, ro:7, depth:true }),
  rail:   ()=>({ tex:railTex(),   w:_scale==='battle'?2:0.13, y:TOP+0.037, ro:8, depth:true }),
  river: ()=>({ tex:riverTex(), w:_scale==='battle'?0.95:0.24, y:TOP+0.028, ro:5 }),
  trail: ()=>({ tex:trailTex(), w:_scale==='battle'?0.55:0.09, y:TOP+0.030, ro:6, blend:'multiply' }),   // World roads/trails halved — too thick for the map scale (Paul)
  road:  ()=>({ tex:roadTex(),  w:_scale==='battle'?0.90:0.11, y:TOP+0.034, ro:7 }),
  paved: ()=>({ tex:pavedTex(), w:_scale==='battle'?1.00:0.12, y:TOP+0.035, ro:7 }),
};
// a flat textured ribbon of the given type following world points [{x,z},…]
// The drawn points are the clicked connector dots; instead of hard straight segments between
// them we run a smooth spline THROUGH them (rounded corners), so a hand-drawn road bends like the
// per-tile roads do. Collinear runs stay straight; a turn at a corner becomes a gentle curve.
// widthClass (rivers): 1 = STREAM (narrow), 2 = RIVER (2× a stream), 3 = BIG RIVER (3×). Undefined keeps the classic width.
const RIVER_W = { world:{1:0.12, 2:0.25, 3:0.37}, battle:{1:0.48, 2:0.96, 3:1.44} };
export function pathRibbonAlong(points, type, widthClass){
  const s = DRAW_SPEC[type] && DRAW_SPEC[type]();
  if (!s || !points || points.length < 2) return null;
  if (type==='river' && widthClass && RIVER_W[_scale][widthClass]) s.w = RIVER_W[_scale][widthClass];
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
  const mo={ map:tt, transparent:true, depthTest:!!s.depth || _scale==='battle', depthWrite:false, side:THREE.DoubleSide };   // battle scale: tall buildings / trees must hide the road behind them
  if (s.blend==='multiply') mo.blending=THREE.MultiplyBlending;
  const m=new THREE.Mesh(g, new THREE.MeshBasicMaterial(mo)); m.renderOrder=s.ro; return m;
}
// a small textured patch that fills where drawn paths of a type meet — reads as the roads/trails
// merging into a Y/junction (same trick the per-tile renderer uses at 3-way hubs), positioned by caller.
export function pathPlate(type, radius){
  const s = DRAW_SPEC[type] && DRAW_SPEC[type]();
  if (!s) return null;
  const jt=(type==='street'?streetPlainTex():s.tex).clone(); jt.needsUpdate=true;   // street crossings: plain asphalt (no painted lines through the junction)
  const plate=new THREE.Mesh(new THREE.CircleGeometry(radius || s.w*0.5, 18),   // = the road's HALF-width so the merge patch fills the junction WITHOUT bulging past the road edges as a visible disc
    new THREE.MeshBasicMaterial({ map:jt, transparent:true, depthTest:!!s.depth, depthWrite:false,
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
export const MODERN_PROP_KINDS = ['car','taxi','police','pickup','bus','schoolbus','semi','tank','jeep','armytruck','helicopter','newscopter','airliner','jet','propplane','sailboat','motorboat'];   // Modern Pack
const _PROP_VEH_SCALE = { car:3.4, taxi:3.4, police:3.4, pickup:3.2, jeep:3.6, bus:2.2, schoolbus:2.2, semi:1.9, armytruck:2.4, tank:3.2, helicopter:2.4, newscopter:2.4, airliner:1.5, jet:2.2, propplane:2.6, sailboat:3, motorboat:3 };
function _vehIcon(kind, x, S){ const c=S/2, cols={car:'#c0392b',taxi:'#f2c200',police:'#f2f2f2',pickup:'#2c3e50',bus:'#2f6f9a',schoolbus:'#f2b600',semi:'#e9ecee',tank:'#5a6038',jeep:'#5f6a42',armytruck:'#5a5a3c',helicopter:'#4f5a3a',newscopter:'#1f4e8c',airliner:'#f2f4f6',jet:'#8a939c',propplane:'#e0a020',sailboat:'#ffffff',motorboat:'#ffffff'};
  const col=cols[kind]||'#888', rr=(x0,y0,w,h,f)=>{ x.fillStyle=f; x.beginPath(); x.roundRect(x0,y0,w,h,6); x.fill(); };
  if(kind==='airliner'||kind==='jet'||kind==='propplane'){ rr(c-8,c-52,16,104,col); rr(c-54,c-8,108,20,col); rr(c-22,c+38,44,10,col); x.fillStyle='#1c2733'; x.fillRect(c-4,c-44,8,10); return; }
  if(kind==='helicopter'||kind==='newscopter'){ rr(c-16,c-26,32,44,col); rr(c-4,c+14,8,40,col); x.strokeStyle='#222'; x.lineWidth=5; x.beginPath(); x.moveTo(c-50,c-50); x.lineTo(c+50,c+10); x.moveTo(c+50,c-50); x.lineTo(c-50,c+10); x.stroke(); return; }
  if(kind==='sailboat'||kind==='motorboat'){ x.fillStyle=col; x.beginPath(); x.moveTo(c,c-50); x.lineTo(c+20,c+10); x.lineTo(c+14,c+46); x.lineTo(c-14,c+46); x.lineTo(c-20,c+10); x.closePath(); x.fill(); x.strokeStyle='#8a939c'; x.lineWidth=2; x.stroke(); return; }
  const long=kind==='bus'||kind==='schoolbus'||kind==='semi'||kind==='armytruck', w=long?40:36, h=long?108:84;
  rr(c-w/2,c-h/2,w,h,col); x.strokeStyle='rgba(0,0,0,.35)'; x.lineWidth=2; x.strokeRect(c-w/2,c-h/2,w,h);
  if(kind==='tank'){ x.fillStyle='#3d4228'; x.beginPath(); x.arc(c,c+4,14,0,6.28); x.fill(); x.fillRect(c-3,c-52,6,50); return; }
  x.fillStyle='#1c2733'; x.fillRect(c-w/2+5,c-h/2+(long?6:16),w-10,long?10:14); if(!long) x.fillRect(c-w/2+5,c+h/2-26,w-10,10);
  if(kind==='semi'){ x.fillStyle='#b8322b'; x.fillRect(c-w/2,c-h/2,w,26); } if(kind==='police'){ x.fillStyle='#2060ff'; x.fillRect(c-10,c-4,10,8); x.fillStyle='#ff2a2a'; x.fillRect(c,c-4,10,8); } }
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
  else if(_PROP_VEH_SCALE[kind]) _vehIcon(kind, x, S);
  else if(kind==='pyramid'){ x.fillStyle='#c9b07a'; x.beginPath(); x.moveTo(c,c-46); x.lineTo(c+46,c+40); x.lineTo(c-46,c+40); x.closePath(); x.fill();   // pyramid seen from above (4 faces)
      x.fillStyle='#e0cc95'; x.beginPath(); x.moveTo(c,c-46); x.lineTo(c,c+40); x.lineTo(c-46,c+40); x.closePath(); x.fill();
      x.strokeStyle='#8a744a'; x.lineWidth=2; x.beginPath(); x.moveTo(c-46,c+40); x.lineTo(c,c-46); x.lineTo(c+46,c+40); x.moveTo(c,c-46); x.lineTo(c,c+40); x.stroke(); }
  const t=new THREE.CanvasTexture(cv); if('SRGBColorSpace' in THREE) t.colorSpace=THREE.SRGBColorSpace; t.needsUpdate=true; return _propIconCache[kind]=t;
}
function prop3D(kind){ const g=new THREE.Group();
  if(_PROP_VEH_SCALE[kind]){ const v=_veh(kind, rng32((kind.length*977)>>>0)); v.scale.setScalar(_PROP_VEH_SCALE[kind]); v.position.y=TOP; v.traverse(o=>{ if(o.isMesh){ o.castShadow=true; } }); g.add(v); return g; }
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
