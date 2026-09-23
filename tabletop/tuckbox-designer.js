/* ============================================================================
 * Box Designer  —  The Game Crafter packaging artwork generator  (v2: real die-lines)
 * ----------------------------------------------------------------------------
 * Every box is built from TGC's OWN overlay template (box-templates/*.png, the
 * exact print size at 300 DPI incl. bleed). Each template is pre-split into its
 * real REGIONS — faces, sides, tuck flaps, dust flaps, walls, corner tabs, glue
 * flap — with their true polygon shape + TGC's blue safe zone (templates.js).
 *
 *   • Background (solid / gradient / image) covers the whole sheet.
 *   • Any region can take its own ART PATCH (image clipped to the flap's shape,
 *     auto-rotated to read upright once folded) or a colour fill.
 *   • Free TEXT / IMAGE layers on top (optionally clipped to one region).
 *   • Preview-only: TGC die-line overlay, region names, "add art" placeholders,
 *     selection. The exported PNG contains ONLY the artwork.
 *   • Two-piece boxes (Pro / Stout / Retail / Deck) have two sheets: Lid + Bottom.
 *
 * All coordinates are print PIXELS of the active sheet.
 * ==========================================================================*/
import { FONTS } from './cards-deck.js';
import { TEMPLATES } from './box-templates/templates.js';
export { FONTS, TEMPLATES };

export const BOXES = {};
for(const t of TEMPLATES) BOXES[t.id]=t;
export const DEFAULT_BOX='pokertuckbox54';
export function boxIds(){ return TEMPLATES.map(t=>t.id); }
export function getBox(id){ return BOXES[id]||BOXES[DEFAULT_BOX]; }
export function getSheet(boxId, sheetId){ const b=getBox(boxId); return b.sheets.find(s=>s.id===sheetId)||b.sheets[0]; }
export function getRegion(sheet, rid){ return sheet.regions.find(r=>r.id===rid)||null; }
/* old v0.82 ids → new */
export const LEGACY_IDS={ p36:'pokertuckbox36', p54:'pokertuckbox54', p72:'pokertuckbox72', p90:'pokertuckbox90', p108:'pokertuckbox108',
  tarot:'tarottuckbox90', smallpro:'smallprototypebox', medpro:'mediumprototypebox', largepro:'largeprototypebox', largeretail:'largeretailbox' };

/* rectangle to align against: TGC safe zone if present, else the region bbox */
export function regionRect(reg, safe=true){ const r=(safe&&reg.safe)?reg.safe:reg.bbox; return { x:r[0], y:r[1], w:r[2], h:r[3] }; }
export function sheetRect(sheet){ const bl=37; return { x:bl, y:bl, w:sheet.w-2*bl, h:sheet.h-2*bl }; }

/* rotation that makes art on this region read upright once the box is folded */
export function uprightRot(box, sheet, reg){
  const d=reg.dir, fam=box.family;
  if(d==='face'||d==='corner') return 0;
  if(fam==='two' && sheet.id==='top') return { top:180, bottom:0, left:90, right:-90 }[d]||0;   // lid walls fold DOWN
  if(fam==='two' || fam==='proto') return { top:0, bottom:180, left:-90, right:90 }[d]||0;      // tray walls fold UP
  // tuck: tall narrow panels (sides / glue) read along the spine
  const [,,w,h]=reg.bbox; return h>w*1.6 ? -90 : 0;
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
/* layer size (unrotated) in px */
export function layerBBox(L, defFont){
  if(L.kind==='image') return { w:L.w, h:L.h };
  const lines=wrap(L.text, L.w, L.size, famOf(L.font||defFont||'georgia'), L.weight);
  return { w:L.w, h:Math.max(L.size, lines.length*L.size*1.18) };
}
/* axis-aligned extent of a rotated layer (for aligning rotated text on spines) */
function rotExtent(L, defFont){ const bb=layerBBox(L,defFont), a=(L.rot||0)*Math.PI/180, c=Math.abs(Math.cos(a)), s=Math.abs(Math.sin(a));
  return { w:bb.w*c+bb.h*s, h:bb.w*s+bb.h*c }; }
export function alignLayer(L, rect, op, defFont){
  const e=rotExtent(L,defFont), rot90=Math.abs(Math.round((L.rot||0)/90))%2===1;
  switch(op){
    case 'cx': L.cx=rect.x+rect.w/2; break;
    case 'cy': L.cy=rect.y+rect.h/2; break;
    case 'left':   L.cx=rect.x+e.w/2; break;
    case 'right':  L.cx=rect.x+rect.w-e.w/2; break;
    case 'top':    L.cy=rect.y+e.h/2; break;
    case 'bottom': L.cy=rect.y+rect.h-e.h/2; break;
    case 'fitw':   L.w=rot90?rect.h:rect.w; L.cx=rect.x+rect.w/2; break;
    case 'fill':   if(L.kind==='image'){ L.w=rot90?rect.h:rect.w; L.h=rot90?rect.w:rect.h; } else { L.w=rot90?rect.h:rect.w; }
                   L.cx=rect.x+rect.w/2; L.cy=rect.y+rect.h/2; break;
  }
  L.cx=Math.round(L.cx); L.cy=Math.round(L.cy); L.w=Math.round(L.w); if(L.h) L.h=Math.round(L.h);
}

/* -------- layers + state -------- */
let _uid=1; export function uid(p='L'){ return p+(_uid++)+'_'+Math.random().toString(36).slice(2,6); }
export function newLayer(kind, sheet, at){
  const r=at||sheetRect(sheet);
  const base={ id:uid(), kind, cx:Math.round(r.x+r.w/2), cy:Math.round(r.y+r.h/2), rot:0, clip:null };
  if(kind==='text') return { ...base, text:'New text', font:'', size:Math.max(24,Math.round(Math.min(r.w,r.h)*0.16)), color:'#ffffff', weight:'bold', align:'center', stroke:true, w:Math.round(r.w*0.9) };
  const s=Math.round(Math.min(r.w,r.h)*0.8);
  return { ...base, img:null, w:s, h:s, fit:'contain', round:0 };
}
/* a text layer sized + rotated to sit upright inside one region */
export function textForRegion(box, sheet, reg, text, o={}){
  const r=regionRect(reg), rot=uprightRot(box,sheet,reg), side=Math.abs(rot)===90;
  const along=side?r.h:r.w, across=side?r.w:r.h;
  return { id:uid(), kind:'text', text, font:'', weight:'bold', align:'center', stroke:true, color:'#f3e8c8',
    size:Math.max(18,Math.round(Math.min(across*0.5, along*0.12))), w:Math.round(along*0.92),
    cx:Math.round(r.x+r.w/2), cy:Math.round(r.y+r.h/2), rot, clip:null, ...o };
}
function blankSheets(box){ const o={}; for(const s of box.sheets) o[s.id]={ patches:{}, layers:[] }; return o; }
export function defaultLayers(boxId, sheetId){
  const box=getBox(boxId), sh=getSheet(boxId,sheetId), R=n=>sh.regions.find(r=>r.name===n);
  const out=[];
  // stack a subtitle under the (possibly wrapped) title using its measured height
  const below=(t,sub)=>({ ...sub, cy:Math.round(t.cy+layerBBox(t).h/2+sub.size*0.9) });
  if(box.family==='tuck'){
    const f=R('Front'), bk=R('Back'), sl=R('Left side'), sr=R('Right side'), tp=R('Top');
    if(f){ const r=regionRect(f);
      out.push({ ...textForRegion(box,sh,f,'GAME\nTITLE'), size:Math.round(r.w*0.2), cy:Math.round(r.y+r.h*0.42) });
      out.push(below(out[out.length-1], { ...textForRegion(box,sh,f,'A game for 2–4 players'), size:Math.round(r.w*0.075), weight:'normal', color:'#e8dcc0' })); }
    if(bk){ const r=regionRect(bk); out.push({ ...textForRegion(box,sh,bk,'HOW TO PLAY\n\nDeal the deck evenly. On your turn play a card and follow suit. Highest card wins the trick.'), size:Math.round(r.w*0.065), weight:'normal', color:'#e8dcc0' }); }
    for(const s of [sl,sr]) if(s) out.push(textForRegion(box,sh,s,'GAME TITLE'));
    if(tp) out.push(textForRegion(box,sh,tp,'GAME TITLE'));
  } else {
    const face=sh.regions.find(r=>r.face && (sh.id!=='main' || r.name==='Lid top')) || sh.regions.find(r=>r.face);
    if(face && (sh.id!=='bottom')){ const r=regionRect(face);
      out.push({ ...textForRegion(box,sh,face,'GAME TITLE'), size:Math.round(Math.min(r.w,r.h)*0.14), cy:Math.round(r.y+r.h*0.44) });
      out.push(below(out[out.length-1], { ...textForRegion(box,sh,face,'A board game'), size:Math.round(Math.min(r.w,r.h)*0.06), weight:'normal', color:'#f0f0f0' }));
      // title on the outer walls of the lid (first ring only)
      for(const w of sh.regions.filter(r=>/ wall$/.test(r.name) && r.name.startsWith(face.name))) out.push(textForRegion(box,sh,w,'GAME TITLE'));
    }
  }
  return out;
}
export function defaultState(boxId=DEFAULT_BOX){
  const box=getBox(boxId), sheets=blankSheets(box);
  for(const s of box.sheets) sheets[s.id].layers=defaultLayers(box.id,s.id);
  return { v:3, box:box.id, sheet:box.sheets[0].id, font:'georgia',
    bg:{ type:'gradient', color:'#1f2f4d', color2:'#0c1524', angle:90, img:null },
    glueWhite:true, showDie:true, showLabels:true, images:{}, sheets, sel:null, selRegion:null };
}
/* make sure every sheet of the current box exists in state */
export function ensureSheets(st){ const box=getBox(st.box); st.sheets=st.sheets||{};
  for(const s of box.sheets) if(!st.sheets[s.id]) st.sheets[s.id]={ patches:{}, layers:[] };
  if(!box.sheets.some(s=>s.id===st.sheet)) st.sheet=box.sheets[0].id; return st; }

/* -------- hit tests (px) -------- */
function inPoly(x,y,p){ let c=false; for(let i=0,j=p.length-2;i<p.length;j=i,i+=2){ const xi=p[i],yi=p[i+1],xj=p[j],yj=p[j+1];
  if(((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) c=!c; } return c; }
export function hitRegion(sheet,x,y){ for(let k=sheet.regions.length-1;k>=0;k--){ const r=sheet.regions[k], b=r.bbox;
  if(x<b[0]||y<b[1]||x>b[0]+b[2]||y>b[1]+b[3]) continue; if(inPoly(x,y,r.poly)) return r; } return null; }
export function hitLayer(layers,x,y,defFont){
  for(let i=layers.length-1;i>=0;i--){ const L=layers[i]; if(L.kind==='image'&&!L.img) continue;
    const bb=layerBBox(L,defFont), a=-(L.rot||0)*Math.PI/180, dx=x-L.cx, dy=y-L.cy;
    const lx=dx*Math.cos(a)-dy*Math.sin(a), ly=dx*Math.sin(a)+dy*Math.cos(a);
    const pad=Math.max(8,bb.h*0.05);
    if(Math.abs(lx)<=bb.w/2+pad && Math.abs(ly)<=bb.h/2+pad) return L; }
  return null;
}

/* -------- render pieces -------- */
function gradVec(angle){ const a=(angle||0)*Math.PI/180, dx=Math.cos(a), dy=Math.sin(a);
  return { x1:(0.5-dx*0.5)*100, y1:(0.5-dy*0.5)*100, x2:(0.5+dx*0.5)*100, y2:(0.5+dy*0.5)*100 }; }
const pts=p=>{ let s=''; for(let i=0;i<p.length;i+=2) s+=p[i]+','+p[i+1]+' '; return s; };

function renderPatch(reg, P, url){
  const [x,y,w,h]=reg.bbox, cx=x+w/2+(P.ox||0), cy=y+h/2+(P.oy||0), rot=P.rot||0, z=P.zoom||1;
  const side=Math.abs(rot)%180===90, W=(side?h:w)*z, H=(side?w:h)*z;
  let s='';
  if(P.color) s+=`<polygon points="${pts(reg.poly)}" fill="${P.color}"/>`;
  if(P.img && url) s+=`<g clip-path="url(#rc_${reg.id})"><g transform="translate(${cx} ${cy}) rotate(${rot})"><image href="${url}" x="${-W/2}" y="${-H/2}" width="${W}" height="${H}" preserveAspectRatio="${P.fit==='contain'?'xMidYMid meet':'xMidYMid slice'}"/></g></g>`;
  return s;
}
function renderLayer(L, defFont, url){
  const rot=L.rot?` rotate(${L.rot})`:'';
  let inner='';
  if(L.kind==='image'){
    if(!url) return '';
    const rx=L.round?Math.min(L.w,L.h)*L.round:0, cid='lc_'+L.id;
    inner=`<clipPath id="${cid}"><rect x="${-L.w/2}" y="${-L.h/2}" width="${L.w}" height="${L.h}" rx="${rx}"/></clipPath>`+
      `<image href="${url}" x="${-L.w/2}" y="${-L.h/2}" width="${L.w}" height="${L.h}" preserveAspectRatio="${L.fit==='cover'?'xMidYMid slice':'xMidYMid meet'}" clip-path="url(#${cid})"/>`;
  } else {
    const fam=famOf(L.font||defFont), lines=wrap(L.text, L.w, L.size, fam, L.weight);
    const lineH=L.size*1.18, totH=lines.length*lineH;
    const anchor=L.align==='left'?'start':L.align==='right'?'end':'middle';
    const ax=L.align==='left'?-L.w/2:L.align==='right'?L.w/2:0;
    const sa=L.stroke?` style="paint-order:stroke" stroke="rgba(0,0,0,.35)" stroke-width="${L.size*0.05}" stroke-linejoin="round"`:'';
    let y=-totH/2+L.size*0.82;
    inner=`<g font-family="${fam}" font-weight="${L.weight}" font-size="${L.size}" fill="${L.color}">`;
    for(const ln of lines){ inner+=`<text x="${ax}" y="${y}" text-anchor="${anchor}"${sa}>${esc(ln)}</text>`; y+=lineH; }
    inner+='</g>';
  }
  return `<g data-lid="${L.id}"><g transform="translate(${L.cx} ${L.cy})${rot}">${inner}</g></g>`;
}

/* =====================  MAIN: one sheet as SVG (px)  =====================
 * opts.preview → die-line overlay, region labels, placeholders, selection
 * opts.url(imgId) → image URL (blob URL in preview, data URL for export)  */
export function renderSheet(st, opts={}){
  const box=getBox(st.box), sheet=getSheet(st.box, st.sheet), W=sheet.w, H=sheet.h;
  const S=(st.sheets&&st.sheets[sheet.id])||{patches:{},layers:[]};
  const pv=!!opts.preview, url=id=>id?(opts.url?opts.url(id):(st.images||{})[id]):null;
  const defFont=st.font||'georgia';
  const defs=[], out=[];
  const u=Math.max(W,H)/1000;   // ~1 "unit" for preview strokes / labels

  for(const r of sheet.regions) defs.push(`<clipPath id="rc_${r.id}"><polygon points="${pts(r.poly)}"/></clipPath>`);

  /* 1. background over the whole sheet (covers every flap / tab / bleed) */
  const bg=st.bg||{};
  if(bg.type==='image' && bg.img && url(bg.img)) out.push(`<image href="${url(bg.img)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`);
  else if(bg.type==='gradient'){ const v=gradVec(bg.angle);
    defs.push(`<linearGradient id="bgg" x1="${v.x1}%" y1="${v.y1}%" x2="${v.x2}%" y2="${v.y2}%"><stop offset="0" stop-color="${bg.color||'#1f2f4d'}"/><stop offset="1" stop-color="${bg.color2||'#0c1524'}"/></linearGradient>`);
    out.push(`<rect width="${W}" height="${H}" fill="url(#bgg)"/>`); }
  else out.push(`<rect width="${W}" height="${H}" fill="${bg.color||'#1f2f4d'}"/>`);

  /* 2. per-region art patches (clipped to the real flap shape) */
  for(const r of sheet.regions){ const P=S.patches[r.id]; if(P) out.push(renderPatch(r,P,url(P.img))); }

  /* 3. preview placeholders on empty regions */
  if(pv && st.showLabels!==false){
    defs.push(`<pattern id="phatch" width="${u*14}" height="${u*14}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="${u*14}" height="${u*14}" fill="rgba(255,255,255,0.05)"/><rect width="${u*3}" height="${u*14}" fill="rgba(255,255,255,0.13)"/></pattern>`);
    for(const r of sheet.regions){ const P=S.patches[r.id]; if(P&&(P.img||P.color)) continue;
      out.push(`<polygon points="${pts(r.poly)}" fill="url(#phatch)"/>`); }
  }

  /* 4. free layers (optionally clipped to a region) */
  for(const L of (S.layers||[])){ const g=renderLayer(L,defFont,L.kind==='image'?url(L.img):null); if(!g) continue;
    out.push(L.clip&&getRegion(sheet,L.clip) ? `<g clip-path="url(#rc_${L.clip})">${g}</g>` : g); }

  /* 5. glue flap kept white (tuck) — ink stops glue bonding */
  if(box.family==='tuck' && st.glueWhite) for(const r of sheet.regions) if(/^Glue flap/.test(r.name)) out.push(`<polygon points="${pts(r.poly)}" fill="#ffffff"/>`);

  if(pv){
    /* 6. TGC die-line overlay (cut red / fold green / safe blue, pink = trimmed off) */
    if(st.showDie!==false) out.push(`<image href="${sheet.overlay}" x="0" y="0" width="${W}" height="${H}" opacity="0.9" style="pointer-events:none"/>`);
    /* 7. region labels */
    if(st.showLabels!==false) for(const r of sheet.regions){ const [x,y,w,h]=r.bbox, tall=h>w*1.3;
      const fs=Math.max(u*9, Math.min(u*22, (tall?w:h)*0.16, (tall?h:w)/Math.max(6,r.name.length)*1.5));
      const P=S.patches[r.id], has=P&&(P.img||P.color);
      // big panels: name near the panel's leading edge so it doesn't sit on the centred title text
      const along=tall?h:w, across=tall?w:h, lead=across>fs*5 ? Math.max(fs*1.3, across*0.12) : across/2;
      const cx=tall?x+lead:x+w/2, cy=tall?y+h/2:y+lead, tr=tall?` transform="rotate(-90 ${cx} ${cy})"`:'';
      out.push(`<text x="${cx}" y="${cy}" dy="${-fs*0.1}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-weight="700" font-size="${fs}" fill="${has?'rgba(255,255,255,.55)':'rgba(255,255,255,.8)'}" style="paint-order:stroke;pointer-events:none" stroke="rgba(0,0,0,.55)" stroke-width="${fs*0.14}"${tr}>${esc(r.name)}${has?'':`<tspan x="${cx}" dy="${fs*1.15}" font-size="${fs*0.62}" font-weight="600">＋ click to add art</tspan>`}</text>`); }
    /* 8. selection */
    if(st.selRegion){ const r=getRegion(sheet,st.selRegion); if(r) out.push(`<polygon points="${pts(r.poly)}" fill="rgba(255,212,121,.12)" stroke="#ffd479" stroke-width="${u*4}" stroke-dasharray="${u*12} ${u*7}" style="pointer-events:none"/>`); }
    if(st.sel){ const L=(S.layers||[]).find(l=>l.id===st.sel);
      if(L){ const bb=layerBBox(L,defFont), p=u*5;
        out.push(`<g data-sel="${L.id}" style="pointer-events:none"><g transform="translate(${L.cx} ${L.cy})${L.rot?` rotate(${L.rot})`:''}"><rect x="${-bb.w/2-p}" y="${-bb.h/2-p}" width="${bb.w+2*p}" height="${bb.h+2*p}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="${u*5}"/><rect x="${-bb.w/2-p}" y="${-bb.h/2-p}" width="${bb.w+2*p}" height="${bb.h+2*p}" fill="none" stroke="#ffd479" stroke-width="${u*3}" stroke-dasharray="${u*12} ${u*7}"/></g></g>`); } }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${famOf(defFont)}"><defs>${defs.join('')}</defs>${out.join('')}</svg>`;
}
