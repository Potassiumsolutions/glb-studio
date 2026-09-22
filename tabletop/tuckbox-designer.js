/* ============================================================================
 * Box Designer  —  The Game Crafter packaging artwork generator
 * ----------------------------------------------------------------------------
 * Generates print-ready flat die-line ("net") PNGs for TGC boxes:
 *   • Tuck-lid boxes:  Poker 36/54/72/90/108 + Tarot  (exact per-panel layout)
 *   • Fold setup boxes (fit quad-fold boards): Small/Medium/Large Prototype +
 *     Large Retail  (one-piece tray+lid wraps)
 *
 * Output matches TGC's own template pixel size at 300 DPI, RGB, with the
 * built-in 1/8" bleed. A free LAYER system (text + image) with drag + panel /
 * sheet alignment lets users place & align anything on any panel, incl. the
 * tuck flaps (the background always fills the whole sheet, so tabs are covered).
 *
 * Authored in POINTS (72 pt = 1"); raster scales by 300/72.
 * ==========================================================================*/
import { FONTS } from './cards-deck.js';
export { FONTS };

const S3 = 'https://s3.amazonaws.com/www.thegamecrafter.com/templates/';

/* Tuck geometry measured from TGC template SVGs (points). Net = side|back|side|front|glue. */
const TUCK = {
  p36:{name:'Poker Tuck — 36 cards',cards:36,dims:'2.5×3.5 cards · 0.55" deep',vbW:504,vbH:432,band:[84.1,338.1],cols:[{t:'side',x0:9.1,x1:48.9,sx0:18.1,sx1:39.9},{t:'back',x0:48.2,x1:230.5,sx0:57.2,sx1:221.5},{t:'side',x0:231,x1:269.5,sx0:240,sx1:260.5},{t:'front',x0:271.3,x1:453.6,sx0:280.3,sx1:444.6}],glue:[453.6,495],png:'36-card-tuck-box.png'},
  p54:{name:'Poker Tuck — 54 cards',cards:54,dims:'2.5×3.5 cards · 0.78" deep',vbW:558,vbH:468,band:[103,357],cols:[{t:'side',x0:10,x1:66.3,sx0:19,sx1:57.3},{t:'back',x0:66.6,x1:249,sx0:75.6,sx1:240},{t:'side',x0:250.8,x1:305,sx0:259.8,sx1:296},{t:'front',x0:309,x1:488.8,sx0:318,sx1:479.8}],glue:[488.8,549],png:'54-card-tuck-box.png'},
  p72:{name:'Poker Tuck — 72 cards',cards:72,dims:'2.5×3.5 cards · 1.08" deep',vbW:612,vbH:468,band:[122.7,376.7],cols:[{t:'side',x0:8.8,x1:86.4,sx0:17.8,sx1:77.4},{t:'back',x0:87.8,x1:267.6,sx0:96.8,sx1:258.6},{t:'side',x0:270.6,x1:345.1,sx0:279.6,sx1:336.1},{t:'front',x0:348.4,x1:528.2,sx0:357.4,sx1:519.2}],glue:[528.2,603],png:'72-card-tuck-box.png'},
  p90:{name:'Jumbo Tuck — 90 cards',cards:90,dims:'2.5×3.5 cards · 1.31" deep',vbW:666,vbH:504,band:[143,397],cols:[{t:'side',x0:11,x1:105,sx0:20,sx1:96},{t:'back',x0:106.5,x1:286.3,sx0:115.5,sx1:277.3},{t:'side',x0:288.5,x1:384.3,sx0:297.5,sx1:375.3},{t:'front',x0:387.9,x1:567.8,sx0:396.9,sx1:558.8}],glue:[567.8,657],png:'90-card-tuck-box.png'},
  p108:{name:'Jumbo Tuck — 108 cards',cards:108,dims:'2.5×3.5 cards · 1.6" deep',vbW:738,vbH:540,band:[161.3,415.3],cols:[{t:'side',x0:18.3,x1:133.5,sx0:27.3,sx1:124.5},{t:'back',x0:135,x1:314.8,sx0:144,sx1:305.8},{t:'side',x0:315.2,x1:430.4,sx0:324.2,sx1:421.4},{t:'front',x0:431.4,x1:611.3,sx0:440.4,sx1:602.3}],glue:[611.3,729],png:'108-card-tuck-box.png'},
  tarot:{name:'Tarot Tuck — 60 cards',cards:60,dims:'2.75×4.75 cards · 1.31" deep',vbW:720,vbH:594,band:[143,487],cols:[{t:'side',x0:20,x1:114,sx0:29,sx1:105},{t:'back',x0:117.5,x1:313.3,sx0:126.5,sx1:304.3},{t:'side',x0:315.5,x1:411.3,sx0:324.5,sx1:402.3},{t:'front',x0:414.9,x1:610.5,sx0:423.9,sx1:601.5}],glue:[610.5,711],png:'tarot-tuck-box.png'},
};
/* Fold setup boxes — one-piece wraps. vb measured from TGC templates. These fit quad-fold boards. */
const FOLD = {
  smallpro:{name:'Small Box — 5.5×4×2.375"',dims:'5.5 × 4 × 2.375 in',vbW:1044,vbH:1080,png:'small-prototype-box.png'},
  medpro:{name:'Medium Box — 9.625×7×2"',dims:'9.625 × 7 × 2 in',vbW:1404,vbH:1296,png:'medium-prototype-box.png'},
  largepro:{name:'Large Box — 10.75×9.5×2.25"',dims:'10.75 × 9.5 × 2.25 in (fits a quad-fold board)',vbW:1836,vbH:1422,png:'large-prototype-box.png'},
  largeretail:{name:'Large Retail Box — 11.75×9.125×2"',dims:'11.75 × 9.125 × 2 in (fits quad-fold boards)',vbW:954,vbH:1134,png:'large-retail-box.png'},
};

export const BOXES = {};
for(const id in TUCK){ BOXES[id]={ type:'tuck', bleed:9, guide:S3+TUCK[id].png, ...TUCK[id] }; }
for(const id in FOLD){ BOXES[id]={ type:'fold', bleed:9, guide:S3+FOLD[id].png, ...FOLD[id] }; }

export function boxIds(){ return Object.keys(BOXES); }
export function boxType(id){ return (BOXES[id]||BOXES.p54).type; }
export function boxPixels(id){ const b=BOXES[id]||BOXES.p54, k=300/72; return { w:Math.round(b.vbW*k), h:Math.round(b.vbH*k), name:b.name }; }

/* -------- alignment targets (panels for tuck, geometric regions for fold) -------- */
export function panelsFor(id){
  const b=BOXES[id]||BOXES.p54, bl=b.bleed, W=b.vbW, H=b.vbH;
  const sheet={ id:'sheet', name:'Whole sheet', rect:{x:bl,y:bl,w:W-2*bl,h:H-2*bl} };
  if(b.type==='tuck'){
    const [bt,bb]=b.band, bh=bb-bt, out=[sheet];
    const nm={front:'Front',back:'Back'}; let sideN=0;
    for(const c of b.cols){
      let label = c.t==='side' ? (sideN++===0?'Left spine':'Right spine') : nm[c.t];
      out.push({ id:label.toLowerCase().replace(/\s/g,''), name:label, rect:{x:c.x0,y:bt,w:c.x1-c.x0,h:bh} });
    }
    return out;
  }
  // fold: geometric regions of the sheet
  const iw=W-2*bl, ih=H-2*bl;
  return [ sheet,
    { id:'left',  name:'Left half',   rect:{x:bl,       y:bl, w:iw/2, h:ih} },
    { id:'right', name:'Right half',  rect:{x:bl+iw/2,  y:bl, w:iw/2, h:ih} },
    { id:'top',   name:'Top half',    rect:{x:bl, y:bl,       w:iw, h:ih/2} },
    { id:'bottom',name:'Bottom half', rect:{x:bl, y:bl+ih/2,  w:iw, h:ih/2} },
    { id:'center',name:'Center',      rect:{x:bl+iw*0.25, y:bl+ih*0.25, w:iw*0.5, h:ih*0.5} },
  ];
}

/* -------- text measuring -------- */
let _mctx=null;
function mctx(){ if(!_mctx){ const c=document.createElement('canvas'); _mctx=c.getContext('2d'); } return _mctx; }
function famOf(id){ const f=FONTS.find(x=>x.id===id); return f?f.family:FONTS[0].family; }
function measureW(str,size,family,weight){ const c=mctx(); c.font=`${weight||'normal'} ${size}px ${family}`; return c.measureText(str).width; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function wrap(text,maxW,size,family,weight){
  const out=[];
  for(const para of String(text||'').split('\n')){
    if(!para.trim()){ out.push(''); continue; }
    let line='';
    for(const w of para.split(/\s+/)){ const t=line?line+' '+w:w;
      if(measureW(t,size,family,weight)<=maxW || !line) line=t; else { out.push(line); line=w; } }
    if(line) out.push(line);
  }
  return out.length?out:[''];
}
/* bounding box (pt) of a layer, for alignment */
export function layerBBox(layer, box){
  if(layer.kind==='image') return { w:layer.w, h:layer.h };
  const fam=famOf(layer.font|| (box&&box._font) || 'georgia');
  const lines=wrap(layer.text, layer.w, layer.size, fam, layer.weight);
  return { w:layer.w, h:Math.max(layer.size, lines.length*layer.size*1.18) };
}
/* move/resize a layer against a target rect */
export function alignLayer(layer, rect, op, box){
  const bb=layerBBox(layer, box);
  switch(op){
    case 'cx': layer.cx=rect.x+rect.w/2; break;
    case 'cy': layer.cy=rect.y+rect.h/2; break;
    case 'left':   layer.cx=rect.x+bb.w/2; break;
    case 'right':  layer.cx=rect.x+rect.w-bb.w/2; break;
    case 'top':    layer.cy=rect.y+bb.h/2; break;
    case 'bottom': layer.cy=rect.y+rect.h-bb.h/2; break;
    case 'fitw':   layer.w=rect.w; layer.cx=rect.x+rect.w/2; break;
    case 'fill':   if(layer.kind==='image'){ layer.w=rect.w; layer.h=rect.h; } else { layer.w=rect.w; } layer.cx=rect.x+rect.w/2; layer.cy=rect.y+rect.h/2; break;
  }
}

/* -------- layer presets -------- */
let _uid=1; export function uid(){ return 'L'+(_uid++)+'_'+Math.random().toString(36).slice(2,6); }
export function newLayer(kind, id){
  const b=BOXES[id]||BOXES.p54, W=b.vbW, H=b.vbH;
  const base={ id:uid(), kind, cx:W/2, cy:H/2, rot:0, panel:'sheet' };
  if(kind==='text') return { ...base, text:'New text', font:'', size:Math.round(W*0.05), color:'#ffffff', weight:'bold', align:'center', stroke:true, w:Math.round(W*0.5) };
  return { ...base, src:null, w:Math.round(W*0.3), h:Math.round(W*0.3), fit:'contain', round:0 };
}
export function defaultLayers(id){
  const b=BOXES[id]||BOXES.p54; const P=panelsFor(id);
  const R=n=>{ const p=P.find(p=>p.id===n)||P[0]; return p.rect; };
  const T=(o)=>({ id:uid(), kind:'text', rot:0, weight:'bold', align:'center', stroke:true, font:'', color:'#f3e8c8', ...o });
  if(b.type==='tuck'){
    const f=R('front'), bk=R('back'), sl=R('leftspine'), sr=R('rightspine');
    return [
      T({ text:'GAME\nTITLE', size:Math.round(f.w*0.2), color:'#f3e8c8', w:f.w*0.94, cx:f.x+f.w/2, cy:f.y+f.h*0.42, panel:'front' }),
      T({ text:'A game for 2–4 players', size:Math.round(f.w*0.08), weight:'normal', color:'#e8dcc0', w:f.w*0.9, cx:f.x+f.w/2, cy:f.y+f.h*0.62, panel:'front' }),
      T({ text:'HOW TO PLAY\n\nDeal the deck evenly. On your turn play a card and follow suit. Highest card wins the trick.', size:Math.round(bk.w*0.07), weight:'normal', color:'#e8dcc0', w:bk.w*0.9, cx:bk.x+bk.w/2, cy:bk.y+bk.h/2, panel:'back' }),
      T({ text:'GAME TITLE', size:Math.round(sl.w*0.5), color:'#f3e8c8', w:sl.h*0.9, cx:sl.x+sl.w/2, cy:sl.y+sl.h/2, rot:-90, panel:'leftspine' }),
      T({ text:'GAME TITLE', size:Math.round(sr.w*0.5), color:'#f3e8c8', w:sr.h*0.9, cx:sr.x+sr.w/2, cy:sr.y+sr.h/2, rot:-90, panel:'rightspine' }),
    ];
  }
  // fold: a cover title + subtitle centred on the sheet (drag onto the lid-top face using the die-line reference)
  const s=R('sheet');
  return [
    T({ text:'GAME TITLE', size:Math.round(b.vbW*0.05), color:'#ffffff', w:b.vbW*0.5, cx:s.x+s.w/2, cy:s.y+s.h*0.42, panel:'sheet' }),
    T({ text:'A board game', size:Math.round(b.vbW*0.024), weight:'normal', color:'#f0f0f0', w:b.vbW*0.5, cx:s.x+s.w/2, cy:s.y+s.h*0.42+b.vbW*0.05, panel:'sheet' }),
  ];
}
export function defaultState(id='p54'){
  return { box:id, font:'georgia',
    bg:{ type:'gradient', color:'#1f2f4d', color2:'#0c1524', angle:90, image:null },
    ink:'#f3e8c8', accent:'#c8a24a', glueWhite:true, showGuide:true,
    layers:defaultLayers(id), sel:null };
}

/* -------- gradient endpoints -------- */
function gradVec(angle){ const a=(angle||0)*Math.PI/180, dx=Math.cos(a), dy=Math.sin(a);
  return { x1:(0.5-dx*0.5)*100, y1:(0.5-dy*0.5)*100, x2:(0.5+dx*0.5)*100, y2:(0.5+dy*0.5)*100 }; }

/* -------- render one layer -------- */
function renderLayer(L, box, defFontId, i){
  const fam=famOf(L.font||defFontId);
  const rot = L.rot ? ` transform="rotate(${L.rot} ${L.cx} ${L.cy})"` : '';
  if(L.kind==='image'){
    if(!L.src) return '';
    const x=L.cx-L.w/2, y=L.cy-L.h/2, cid='licl'+i;
    const rx=L.round?Math.min(L.w,L.h)*L.round:0;
    return `<g${rot}><clipPath id="${cid}"><rect x="${x}" y="${y}" width="${L.w}" height="${L.h}" rx="${rx}"/></clipPath>`+
      `<image href="${L.src}" x="${x}" y="${y}" width="${L.w}" height="${L.h}" preserveAspectRatio="${L.fit==='cover'?'xMidYMid slice':'xMidYMid meet'}" clip-path="url(#${cid})"/></g>`;
  }
  const lines=wrap(L.text, L.w, L.size, fam, L.weight);
  const lineH=L.size*1.18, totH=lines.length*lineH;
  const anchor=L.align==='left'?'start':L.align==='right'?'end':'middle';
  const ax=L.align==='left'?L.cx-L.w/2:L.align==='right'?L.cx+L.w/2:L.cx;
  const strokeAttr = L.stroke ? ` style="paint-order:stroke" stroke="rgba(0,0,0,.32)" stroke-width="${L.size*0.045}"` : '';
  let y=L.cy-totH/2+L.size*0.82, out=`<g${rot} font-family="${fam}" font-weight="${L.weight}" font-size="${L.size}" fill="${L.color}">`;
  for(const ln of lines){ out+=`<text x="${ax}" y="${y}" text-anchor="${anchor}"${strokeAttr}>${esc(ln)}</text>`; y+=lineH; }
  return out+`</g>`;
}

/* -------- die-line guide (drawn) -------- */
function drawGuide(b){
  const g=[], W=b.vbW, H=b.vbH, bl=b.bleed;
  const label=(x,y,t,c,rot)=>`<g${rot?` transform="rotate(${rot} ${x} ${y})"`:''}><text x="${x}" y="${y}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-weight="700" font-size="${Math.max(9,W*0.016)}" fill="${c}" style="paint-order:stroke" stroke="rgba(0,0,0,.6)" stroke-width="2.6">${t}</text></g>`;
  g.push(`<rect x="${bl*0.4}" y="${bl*0.4}" width="${W-bl*0.8}" height="${H-bl*0.8}" fill="none" stroke="#ec1c24" stroke-width="${W*0.0016}" opacity="0.4" stroke-dasharray="4 4"/>`);
  if(b.type==='tuck'){
    const [bt,bb]=b.band, bh=bb-bt;
    for(const c of b.cols){
      g.push(`<rect x="${c.x0}" y="${bt}" width="${c.x1-c.x0}" height="${bh}" fill="none" stroke="#ec1c24" stroke-width="1" opacity="0.7"/>`);
      g.push(`<rect x="${c.sx0}" y="${bt+bl}" width="${c.sx1-c.sx0}" height="${bh-2*bl}" fill="none" stroke="#3aa0ff" stroke-width="0.9" stroke-dasharray="5 4" opacity="0.85"/>`);
      const nm=c.t==='front'?'FRONT':c.t==='back'?'BACK':'SPINE';
      g.push(label((c.x0+c.x1)/2, bt-5, nm, c.t==='front'?'#ffd479':'#cfe6ff'));
    }
    g.push(`<line x1="${b.cols[0].x0}" y1="${bt}" x2="${b.glue[1]}" y2="${bt}" stroke="#3fbf5f" stroke-width="0.9" stroke-dasharray="6 4" opacity="0.8"/>`);
    g.push(`<line x1="${b.cols[0].x0}" y1="${bb}" x2="${b.glue[1]}" y2="${bb}" stroke="#3fbf5f" stroke-width="0.9" stroke-dasharray="6 4" opacity="0.8"/>`);
    for(const c of b.cols) g.push(`<line x1="${c.x0}" y1="${bt}" x2="${c.x0}" y2="${bb}" stroke="#3fbf5f" stroke-width="0.8" stroke-dasharray="6 4" opacity="0.7"/>`);
    g.push(`<rect x="${b.glue[0]}" y="${bt}" width="${b.glue[1]-b.glue[0]}" height="${bh}" fill="rgba(150,150,150,.18)" stroke="#3fbf5f" stroke-width="0.8" stroke-dasharray="6 4"/>`);
    g.push(label((b.glue[0]+b.glue[1])/2,(bt+bb)/2,'GLUE','#cfcfcf',-90));
  } else {
    // fold: sheet trim + half guides + a note to use the real die-line reference
    const iw=W-2*bl, ih=H-2*bl;
    g.push(`<line x1="${bl+iw/2}" y1="${bl}" x2="${bl+iw/2}" y2="${H-bl}" stroke="#3fbf5f" stroke-width="${W*0.0013}" stroke-dasharray="10 8" opacity="0.5"/>`);
    g.push(`<line x1="${bl}" y1="${bl+ih/2}" x2="${W-bl}" y2="${bl+ih/2}" stroke="#3fbf5f" stroke-width="${W*0.0013}" stroke-dasharray="10 8" opacity="0.5"/>`);
    g.push(label(W/2, bl+18, 'centre lines · tap “Die-line” for TGC folds', '#cfe6ff'));
  }
  return `<g id="guide">${g.join('')}</g>`;
}

/* =====================  MAIN: build the net SVG (points)  ===================== */
export function renderNet(state, opts={}){
  const guide=!!opts.guide;
  const b=BOXES[state.box]||BOXES.p54;
  const W=b.vbW, H=b.vbH, bl=b.bleed;
  const defFontId=state.font||'georgia';
  const defs=[], layers=[];

  /* background across the whole sheet (covers every flap / tab) */
  const bg=state.bg||{};
  if(bg.type==='image' && bg.image){
    layers.push(`<image href="${bg.image}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`);
  } else if(bg.type==='gradient'){
    const v=gradVec(bg.angle);
    defs.push(`<linearGradient id="bgg" x1="${v.x1}%" y1="${v.y1}%" x2="${v.x2}%" y2="${v.y2}%"><stop offset="0" stop-color="${bg.color||'#1f2f4d'}"/><stop offset="1" stop-color="${bg.color2||'#0c1524'}"/></linearGradient>`);
    layers.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#bgg)"/>`);
  } else {
    layers.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${bg.color||'#1f2f4d'}"/>`);
  }

  /* glue tab kept white (tuck only) */
  if(b.type==='tuck' && state.glueWhite){
    const [bt,bb]=b.band; layers.push(`<rect x="${b.glue[0]}" y="${bt-2}" width="${W-b.glue[0]}" height="${bb-bt+4}" fill="#ffffff"/>`);
  }

  /* user layers, in order */
  (state.layers||[]).forEach((L,i)=> layers.push(renderLayer(L,b,defFontId,i)));

  /* selection outline (screen only) */
  if(guide && state.sel){ const L=(state.layers||[]).find(x=>x.id===state.sel);
    if(L){ const bb=layerBBox(L,{_font:defFontId}); const x=L.cx-(L.kind==='image'?L.w:bb.w)/2, y=L.cy-(L.kind==='image'?L.h:bb.h)/2, w=L.kind==='image'?L.w:bb.w, h=L.kind==='image'?L.h:bb.h;
      const rot=L.rot?` transform="rotate(${L.rot} ${L.cx} ${L.cy})"`:'';
      layers.push(`<g${rot}><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ffd479" stroke-width="${W*0.002}" stroke-dasharray="6 4"/></g>`); } }

  if(guide) layers.push(drawGuide(b));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}pt" height="${H}pt" viewBox="0 0 ${W} ${H}" font-family="${famOf(defFontId)}">`+
    (defs.length?`<defs>${defs.join('')}</defs>`:'')+ layers.join('') + `</svg>`;
}
