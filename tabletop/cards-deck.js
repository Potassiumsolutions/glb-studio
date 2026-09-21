/* =====================================================================
   Cards — modular card / deck compositor  (Tabletop 🃏 tab)
   ---------------------------------------------------------------------
   Refined from the No-Kings-era "Custom Deck" configurator.  A card is
   composed of independent, swappable pads (layers):
       1. PAPER   — parchment ground + card edge            (framePad)
       2. CENTER  — pips (2-9) · mirrored court art · single full art
       3. FRAME   — plain keyline OR gilded acanthus scroll (frameVine)
       4. INDEX   — corner rank+suit badges (mirrored TL+BR)
   Everything is data-driven, so this is both a standard 52-card deck
   builder AND a custom deck designer (2-6 suits, custom ranks, and
   free-form "custom cards" with your own art + title).

   Print geometry is chosen from a table of real The-Game-Crafter card
   sizes; every layer lays out in fractions of the trim rect so it
   adapts to any size.  Exports are print-ready (finished size + 1/8"
   bleed, 300 DPI).
   ===================================================================== */

export const DPI = 300;

/* ---------- The Game Crafter card sizes (finished inches) ----------- *
   image px = finished*DPI + bleed*2  (bleed = 1/8")                     */
/* The Game Crafter's real card catalogue — finished (cut) sizes, verified from
   thegamecrafter.com. ids are stable so saved decks keep loading.                */
export const CARD_SIZES = {
  poker:       { id:'poker',       name:'Poker 2.5 × 3.5"',        tw:2.5,  th:3.5  },
  bridge:      { id:'bridge',      name:'Bridge 2.25 × 3.5"',      tw:2.25, th:3.5  },
  europoker:   { id:'europoker',   name:'Euro Poker 2.48 × 3.46"', tw:2.48, th:3.46 },
  mini:        { id:'mini',        name:'Mini 1.75 × 2.5"',        tw:1.75, th:2.5  },
  micro:       { id:'micro',       name:'Micro 1.25 × 1.75"',      tw:1.25, th:1.75 },
  tarot:       { id:'tarot',       name:'Tarot 2.75 × 4.75"',      tw:2.75, th:4.75 },
  jumbo:       { id:'jumbo',       name:'Jumbo 3.5 × 5.5"',        tw:3.5,  th:5.5  },
  square:      { id:'square',      name:'Square 3.5 × 3.5"',       tw:3.5,  th:3.5  },
  smallsquare: { id:'smallsquare', name:'Small Square 2.5 × 2.5"', tw:2.5,  th:2.5  },
  domino:      { id:'domino',      name:'Domino 1.75 × 3.5"',      tw:1.75, th:3.5  },
  business:    { id:'business',    name:'Business 2 × 3.5"',       tw:2,    th:3.5  },
  usgame:      { id:'usgame',      name:'US Game 2.2 × 3.43"',     tw:2.2,  th:3.43 },
  minttin:     { id:'minttin',     name:'Mint Tin 2.05 × 3.43"',   tw:2.05, th:3.43 },
};

/* mutable print geometry — recomputed by setCardSize() ---------------- */
export let SIZE_ID = 'poker';
export let TRIM  = { w: 2.5*DPI, h: 3.5*DPI };          // 750 x 1050
export let BLEED = 0.125*DPI;                            // 37.5
export let CARD  = { w: TRIM.w+BLEED*2, h: TRIM.h+BLEED*2 };
export let OX = BLEED, OY = BLEED;                       // trim origin
let CX = CARD.w/2, CY = CARD.h/2;                        // card centre
let TRIM_RECT = { x:OX, y:OY, w:TRIM.w, h:TRIM.h };

export function setCardSize(id){
  const s = CARD_SIZES[id] || CARD_SIZES.poker;
  SIZE_ID = s.id;
  TRIM  = { w: s.tw*DPI, h: s.th*DPI };
  BLEED = 0.125*DPI;
  CARD  = { w: TRIM.w+BLEED*2, h: TRIM.h+BLEED*2 };
  OX = BLEED; OY = BLEED;
  CX = CARD.w/2; CY = CARD.h/2;
  TRIM_RECT = { x:OX, y:OY, w:TRIM.w, h:TRIM.h };
  return { ...s, cardW:CARD.w, cardH:CARD.h };
}

/* shared palette ---------------------------------------------------- */
export const PAPER = '#f4ead1';
const PAPER_HI     = '#faf3de';
const GOLD         = '#b8933f';
const GOLD_LT      = '#e2c377';
const GOLD_DK      = '#8a6b26';

/* ---------- suit shape library ------------------------------------- *
   pip paths are authored in a 0..100 box, centred ~(50,50).  A suit may
   instead carry a `glyph` (unicode char) which is rendered as text — so
   users can invent suits (anvils, wheat, moons…) without drawing SVG.   */
export const SUIT_SHAPES = {
  spades:   'M50 8 C50 8 88 40 88 62 C88 78 74 86 63 82 C58 80 55 76 54 71 C55 82 58 90 66 96 L34 96 C42 90 45 82 46 71 C45 76 42 80 37 82 C26 86 12 78 12 62 C12 40 50 8 50 8 Z',
  hearts:   'M50 92 C50 92 10 62 10 34 C10 18 22 10 34 12 C43 14 49 22 50 30 C51 22 57 14 66 12 C78 10 90 18 90 34 C90 62 50 92 50 92 Z',
  diamonds: 'M50 6 C64 32 74 42 92 50 C74 58 64 68 50 94 C36 68 26 58 8 50 C26 42 36 32 50 6 Z',
  clubs:    'M50 6 C60 6 68 14 68 24 C68 29 66 33 63 37 C70 32 80 34 84 42 C89 51 84 62 73 63 C66 64 60 60 56 55 C58 66 62 74 70 82 L30 82 C38 74 42 66 44 55 C40 60 34 64 27 63 C16 62 11 51 16 42 C20 34 30 32 37 37 C34 33 32 29 32 24 C32 14 40 6 50 6 Z',
};

/* ---------- suit STYLES: the pip shape shifts slightly with the chosen font -----
   Each is a subtle transform (scale about the pip centre) + optional edge, so a
   deck's suits echo its typography (tall & lean under a roman face, fuller under
   a heavy blackletter, etc.).  Authored as transforms so every suit adapts.       */
export const SUIT_STYLES = {
  classic: { sx:1.00, sy:1.00 },
  sleek:   { sx:0.88, sy:1.12 },                                  // tall & narrow — elegant serif / roman caps
  bold:    { sx:1.08, sy:1.02, strokeW:5, strokeCol:'rgba(0,0,0,.28)' },  // fuller, edged — heavy / blackletter
  round:   { sx:1.06, sy:0.94 },                                  // squat & round — soft geometric sans
};

/* ---------- font presets: a family + the suit style it pairs with ---------------
   Google families (Cinzel / UnifrakturMaguntia / Roboto Slab) are linked in the
   host <head>; the rest are system fonts so they always render, online or not.     */
export const FONTS = [
  { id:'georgia',  name:'Georgia — classic',        family:"Georgia,'Times New Roman',serif",              suit:'classic' },
  { id:'garamond', name:'Garamond — old-style',     family:"'Garamond','Palatino Linotype','Book Antiqua',serif", suit:'sleek' },
  { id:'cinzel',   name:'Cinzel — roman caps',      family:"'Cinzel',Georgia,serif",                       suit:'sleek' },
  { id:'fell',     name:'IM Fell — antique press',  family:"'IM Fell English',Georgia,serif",              suit:'classic' },
  { id:'gothic',   name:'Blackletter — gothic',     family:"'UnifrakturMaguntia','Old English Text MT',serif", suit:'bold' },
  { id:'slab',     name:'Roboto Slab — slab serif', family:"'Roboto Slab','Rockwell',serif",               suit:'bold' },
  { id:'modern',   name:'Modern — clean sans',      family:"'Segoe UI','Helvetica Neue',Arial,sans-serif", suit:'round' },
  { id:'mono',     name:'Typewriter — mono',        family:"'Courier New',ui-monospace,monospace",         suit:'classic' },
];

/* mutable typography state (recomputed by setFont / setSuitStyle) ---------------- */
export let FONT_FAMILY  = "Georgia,'Times New Roman',serif";
export let SUIT_STYLE_ID = 'classic';
export function setFont(family){ FONT_FAMILY = family || "Georgia,serif"; }
export function setSuitStyle(id){ SUIT_STYLE_ID = SUIT_STYLES[id] ? id : 'classic'; }
export function setFontById(id){ const f=FONTS.find(x=>x.id===id); if(f){ setFont(f.family); setSuitStyle(f.suit); } return f; }

/* ---------- deck model (configurable) ------------------------------ */
const STD_SUITS = [
  { id:'spades',   symbol:'♠', color:'#16181d', shape:'spades'   },
  { id:'hearts',   symbol:'♥', color:'#c62027', shape:'hearts'   },
  { id:'clubs',    symbol:'♣', color:'#16181d', shape:'clubs'    },
  { id:'diamonds', symbol:'♦', color:'#c62027', shape:'diamonds' },
];
const STD_RANKS = [
  { id:'A',  label:'A',  kind:'court', figure:'ace'    },
  { id:'2',  label:'2',  kind:'pip' },
  { id:'3',  label:'3',  kind:'pip' },
  { id:'4',  label:'4',  kind:'pip' },
  { id:'5',  label:'5',  kind:'pip' },
  { id:'6',  label:'6',  kind:'pip' },
  { id:'7',  label:'7',  kind:'pip' },
  { id:'8',  label:'8',  kind:'pip' },
  { id:'9',  label:'9',  kind:'pip' },
  { id:'10', label:'10', kind:'pip' },
  { id:'J',  label:'J',  kind:'court', figure:'jack'  },
  { id:'Q',  label:'Q',  kind:'court', figure:'queen' },
  { id:'K',  label:'K',  kind:'court', figure:'king'  },
];

// module deck state
export let DECK = {
  suits: STD_SUITS.map(s=>({...s})),
  ranks: STD_RANKS.map(r=>({...r})),
  jokers: ['red','black'],   // [] for none
  custom: [],                // free-form cards: {id,title,suit?,corner?}
};
export function configureDeck(patch={}){
  if(patch.suits)  DECK.suits  = patch.suits;
  if(patch.ranks)  DECK.ranks  = patch.ranks;
  if(patch.jokers) DECK.jokers = patch.jokers;
  if('custom' in patch) DECK.custom = patch.custom || [];
  return DECK;
}
export function resetDeck(){ configureDeck({ suits:STD_SUITS.map(s=>({...s})), ranks:STD_RANKS.map(r=>({...r})), jokers:['red','black'], custom:[] }); return DECK; }
export function defaultSuits(){ return STD_SUITS.map(s=>({...s})); }
export function defaultRanks(){ return STD_RANKS.map(r=>({...r})); }
const suitById = id => DECK.suits.find(s=>s.id===id) || STD_SUITS[0];
const rankById = id => DECK.ranks.find(r=>r.id===id) || STD_RANKS[0];

/* ---------- pip layouts (fractions of the central pip window) ------- */
const L=0.30, C=0.50, R=0.70;
const yT=0.06, y2=0.28, yM=0.50, y3=0.72, yB=0.94;
const q1=0.06, q2=0.353, q3=0.647, q4=0.94;
const g1=0.28, g2=0.72;
export const PIP_LAYOUTS = {
  '1': [[C,yM,0]],
  '2': [[C,yT,0],[C,yB,1]],
  '3': [[C,yT,0],[C,yM,0],[C,yB,1]],
  '4': [[L,yT,0],[R,yT,0],[L,yB,1],[R,yB,1]],
  '5': [[L,yT,0],[R,yT,0],[C,yM,0],[L,yB,1],[R,yB,1]],
  '6': [[L,yT,0],[R,yT,0],[L,yM,0],[R,yM,0],[L,yB,1],[R,yB,1]],
  '7': [[L,q1,0],[R,q1,0],[C,q2,0],[L,q3,1],[R,q3,1],[L,q4,1],[R,q4,1]],   // evenly distributed (top pair · lone centre · two pairs) — balanced top-to-bottom
  '8': [[L,yT,0],[R,yT,0],[C,g1,0],[L,yM,0],[R,yM,0],[C,g2,1],[L,yB,1],[R,yB,1]],
  '9': [[L,q1,0],[R,q1,0],[L,q2,0],[R,q2,0],[C,yM,0],[L,q3,1],[R,q3,1],[L,q4,1],[R,q4,1]],
  '10':[[L,q1,0],[R,q1,0],[C,0.20,0],[L,q2,0],[R,q2,0],[L,q3,1],[R,q3,1],[C,0.80,1],[L,q4,1],[R,q4,1]],
};

/* ---------- small svg helpers -------------------------------------- */
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function pip(suit, cx, cy, size, rot){
  const s = suitById(suit), k = size/100, st = SUIT_STYLES[SUIT_STYLE_ID] || SUIT_STYLES.classic;
  // t centres the 0..100 box on (cx,cy): translate(-50 -50) is REQUIRED or the pip lands 50k off (and rot pips
  // shift the opposite way → collisions + asymmetry). The style scale is applied ABOUT the box centre, inside.
  const t = `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) scale(${k.toFixed(3)}) ${rot?'rotate(180)':''} translate(-50 -50)`;
  const styled = inner => (st.sx!==1||st.sy!==1) ? `<g transform="translate(50 50) scale(${st.sx} ${st.sy}) translate(-50 -50)">${inner}</g>` : inner;
  if(s.shape && SUIT_SHAPES[s.shape]){
    const edge = st.strokeW ? ` stroke="${st.strokeCol||'rgba(0,0,0,.25)'}" stroke-width="${st.strokeW}"` : '';
    return `<g transform="${t}">${styled(`<path d="${SUIT_SHAPES[s.shape]}" fill="${s.color}"${edge}/>`)}</g>`;
  }
  // glyph fallback: render the unicode symbol centred in the 0..100 box
  return `<g transform="${t}">${styled(`<text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI Symbol','Apple Symbols',serif" font-size="86" fill="${s.color}">${esc(s.symbol||'●')}</text>`)}</g>`;
}

/* ---------- PAPER pad ---------------------------------------------- */
export function framePad(opt={}){
  const paper = opt.paper || PAPER;
  const ink   = opt.ink   || '#20222a';
  const x=OX, y=OY, w=TRIM.w, h=TRIM.h, r=40;
  return `<g class="pad-paper">
    <rect x="0" y="0" width="${CARD.w}" height="${CARD.h}" fill="${paper}"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${ink}" stroke-width="2" opacity="0.55"/>
  </g>`;
}

/* ---------- FRAME pad: engraved acanthus-scroll border ------------- */
const acanthus = (fill) =>
  `<path d="M0 0 C -8 -8 -9 -22 -2 -34 C -3 -22 3 -18 9 -20 C 4 -13 5 -6 12 -3 C 5 -2 3 4 6 10 C 1 4 -4 1 0 0 Z" fill="${fill}"/>`;
const CURL = `M0 0 C 16 -3 27 9 26 24 C 25 37 13 44 1 41 C -11 38 -17 25 -13 15 C -9 6 3 3 10 10 C 16 16 13 27 4 27 C -2 27 -5 22 -3 18`;
const volute = (stroke, sw=3) =>
  `<path d="${CURL}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
function scrollRun(len, g, gl){
  const U=44, n=Math.max(4, Math.round(len/U)), step=len/n, s=step/46;
  let ink='';
  for(let i=0;i<n;i++){
    const x=i*step, dir=i%2?1:-1;
    ink += `<g transform="translate(${x.toFixed(1)} 0) scale(${s.toFixed(3)} ${(s*dir).toFixed(3)})">
              ${volute(g,3)}<g transform="translate(20 22) scale(0.6)">${acanthus(g)}</g></g>`;
  }
  const layer=(col,dy)=>`<g transform="translate(0 ${dy})">
       <path d="M0 0 L ${len.toFixed(1)} 0" fill="none" stroke="${col}" stroke-width="2.4"/>
       ${ink.replaceAll(`stroke="${g}"`,`stroke="${col}"`)}</g>`;
  return `<g>${layer(GOLD_DK,1.4)}${layer(g,0)}
    <path d="M0 0 L ${len.toFixed(1)} 0" fill="none" stroke="${gl}" stroke-width="0.9" opacity="0.6"/></g>`;
}
function cornerCartouche(x,y,rot,g,gl){
  const body=(col)=>`<g transform="scale(0.95)">${volute(col,3.2)}</g>
    <g transform="rotate(90) scale(0.95)">${volute(col,3.2)}</g>
    <g transform="rotate(45) translate(0 6) scale(0.8)">${acanthus(col)}</g>`;
  return `<g transform="translate(${x} ${y}) rotate(${rot})">
    <g transform="translate(1.4 1.4)">${body(GOLD_DK)}</g>${body(g)}
    <circle cx="0" cy="0" r="5.4" fill="${g}"/><circle cx="0" cy="0" r="2.2" fill="${gl}"/></g>`;
}
export function frameVine(opt={}){
  const g=opt.accent||GOLD, gl=opt.accentLt||GOLD_LT, gd=GOLD_DK;
  const keyline=(ins,sw,stroke,op=1)=>
    `<rect x="${OX+ins}" y="${OY+ins}" width="${TRIM.w-2*ins}" height="${TRIM.h-2*ins}"
       rx="${Math.max(6,38-ins*0.35)}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
  const io=13, ii=64, ic=37;
  const Lx=OX+ic, Rr=OX+TRIM.w-ic, T=OY+ic, B=OY+TRIM.h-ic;
  return `<g class="pad-frame">
    ${keyline(io,2.6,gd)}${keyline(io+3.5,1,gl,0.6)}
    ${keyline(ii,2.8,g)}${keyline(ii+3.5,1,gl,0.7)}
    <g transform="translate(${Lx} ${T})">${scrollRun(Rr-Lx,g,gl)}</g>
    <g transform="translate(${Rr} ${T}) rotate(90)">${scrollRun(B-T,g,gl)}</g>
    <g transform="translate(${Rr} ${B}) rotate(180)">${scrollRun(Rr-Lx,g,gl)}</g>
    <g transform="translate(${Lx} ${B}) rotate(270)">${scrollRun(B-T,g,gl)}</g>
    ${cornerCartouche(Lx,T,0,g,gl)}${cornerCartouche(Rr,T,90,g,gl)}
    ${cornerCartouche(Rr,B,180,g,gl)}${cornerCartouche(Lx,B,270,g,gl)}</g>`;
}

/* ---------- INDEX pad: corner rank+suit pill ----------------------- */
export function indexPad(rankLabel, suit, opt={}){
  const s = suitById(suit);
  const gold = opt.accent || GOLD;
  const Rct = opt.rect || TRIM_RECT;
  const sc = Math.min(1, Math.max(0.72, Rct.w/560));
  const isTen = String(rankLabel).length>=2;
  const rfs = (isTen?84:100)*sc;
  const pw  = (isTen?96:80)*sc;
  const ph  = 158*sc;
  const badge=(cx,cy,rot)=>`<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) ${rot?'rotate(180)':''}">
      <rect x="${(-pw/2).toFixed(1)}" y="${(-ph/2).toFixed(1)}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" rx="${17*sc}"
            fill="${PAPER_HI}" stroke="${gold}" stroke-width="2.4" opacity="0.97"/>
      <text x="0" y="${(-ph/2+rfs*0.82+8*sc).toFixed(1)}" text-anchor="middle"
            font-family="${FONT_FAMILY}" font-weight="700"
            font-size="${rfs.toFixed(1)}" fill="${s.color}">${esc(rankLabel)}</text>
      ${pip(suit, 0, ph/2-40*sc, 54*sc, false)}</g>`;
  const cx = Rct.x+pw/2+16*sc, cy = Rct.y+ph/2+16*sc;
  return `<g class="pad-index">${badge(cx,cy,false)}${badge(CARD.w-cx,CARD.h-cy,true)}</g>`;
}

/* ---------- CENTER: pips ------------------------------------------- */
export function pipCenter(rankId, suit, rect){
  const R = rect || TRIM_RECT;
  const rk = rankById(rankId);
  const layout = PIP_LAYOUTS[rk.label] || PIP_LAYOUTS[rankId];
  if(!layout) return '';
  const padX=R.w*0.20, padY=R.h*0.11;
  const win={ x:R.x+padX, y:R.y+padY, w:R.w-2*padX, h:R.h-2*padY };
  const n = layout.length;
  const size=(n>=9?118:132)*Math.min(1,R.w/750);
  const cells=layout.map(([fx,fy,rot])=>pip(suit, win.x+fx*win.w, win.y+fy*win.h, size, rot)).join('');
  return `<g class="pad-center-pips">${cells}</g>`;
}

/* ---------- CENTER: mirrored court art ----------------------------- */
let _uid=0;
function mirroredArt(artUrl, box, rect){
  const R = rect || TRIM_RECT, mx=R.x+R.w/2, my=R.y+R.h/2;
  const id='th'+(++_uid);
  let x,y,W,H;
  if(box){
    const cw=box.x1-box.x0, chh=box.y1-box.y0;
    const topPad=R.h*0.02, over=R.h*0.10;
    const k=Math.min((my-(R.y+topPad)+over)/chh, (R.w*0.96)/cw);
    W=box.w*k; H=box.h*k;
    const axis=(box.ax!=null?box.ax:(box.x0+box.x1)/2);
    x=mx-axis*k; y=(my+over)-box.y1*k;
  } else { W=R.w; H=W*765/1024; x=mx-W/2; y=R.y; }
  const img=`<image href="${artUrl}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" preserveAspectRatio="none"/>`;
  const half=`<g clip-path="url(#${id})">${img}</g>`;
  return `<g class="pad-center-court">
      <defs><clipPath id="${id}"><rect x="${R.x.toFixed(1)}" y="${R.y.toFixed(1)}" width="${R.w.toFixed(1)}" height="${(my-R.y+0.5).toFixed(1)}"/></clipPath></defs>
      ${half}<g transform="rotate(180 ${mx.toFixed(1)} ${my.toFixed(1)})">${half}</g></g>`;
}
/* ---------- CENTER: single full-bleed art (custom cards) ----------- */
function singleArt(artUrl, rect){
  const R = rect || TRIM_RECT;
  return `<g class="pad-center-art"><image href="${artUrl}" x="${R.x.toFixed(1)}" y="${R.y.toFixed(1)}"
     width="${R.w.toFixed(1)}" height="${R.h.toFixed(1)}" preserveAspectRatio="xMidYMid slice"
     clip-path="inset(0 round 28)"/></g>`;
}

export function courtCenter(rankId, suit, artUrl, box, rect){
  const R = rect || TRIM_RECT;
  if(artUrl) return mirroredArt(artUrl, box, R);
  const rk=rankById(rankId), s=suitById(suit);
  const mx=R.x+R.w/2, my=R.y+R.h/2, ah=(my-R.y), ay=R.y;
  // scale the placeholder to the card so the two mirrored halves never collide on small/narrow sizes
  const ps=Math.min(R.w*0.26, ah*0.42), fs=Math.max(13,R.w*0.05);
  const half=`${pip(suit,mx,ay+ah*0.36,ps,false)}
      <text x="${mx}" y="${ay+ah*0.78}" text-anchor="middle" font-family="${FONT_FAMILY}"
            font-size="${fs.toFixed(0)}" fill="${s.color}" letter-spacing="${(fs*0.13).toFixed(1)}">${esc((rk.figure||rk.label).toUpperCase())}</text>`;
  return `<g class="pad-center-court placeholder">${half}
    <g transform="rotate(180 ${mx} ${my})">${half}</g></g>`;
}

/* ---------- frame resolution --------------------------------------- */
function resolveFrame(opt){
  const f=opt.frame;
  if(f && f.img && f.open){
    const o=f.open;
    const rect={ x:o.x*CARD.w, y:o.y*CARD.h, w:(o.x1-o.x)*CARD.w, h:(o.y1-o.y)*CARD.h };
    const img=`<image href="${f.img}" x="0" y="0" width="${CARD.w}" height="${CARD.h}" preserveAspectRatio="none"/>`;
    return { rect, img, kind:'image' };
  }
  if(f && f.id==='scroll') return { rect:TRIM_RECT, img:null, kind:'scroll' };
  return { rect:TRIM_RECT, img:null, kind:'plain' };
}
function plainKeyline(opt){
  const g=opt.accent||GOLD;
  const r1=(ins,sw,op=1)=>`<rect x="${OX+ins}" y="${OY+ins}" width="${TRIM.w-2*ins}" height="${TRIM.h-2*ins}"
     rx="${Math.max(8,34-ins*0.3)}" fill="none" stroke="${g}" stroke-width="${sw}" opacity="${op}"/>`;
  return `<g class="pad-frame-plain">${r1(20,3)}${r1(28,1.2,0.6)}</g>`;
}
function frameOverlay(fr,opt){
  return fr.kind==='scroll'?frameVine(opt):(fr.kind==='plain'?plainKeyline(opt):'');
}

/* ---------- assemble a standard rank+suit card --------------------- */
export function buildCard(rankId, suit, opt={}){
  const rk=rankById(rankId);
  const key=`${rankId}-${suit}`;
  const artUrl=opt.artUrl||(opt.artMap&&opt.artMap[key])||null;
  const box=opt.artBox&&opt.artBox[key];
  // Uploaded art fills the frame opening by default (a cropped photo/illustration = the whole card face).
  // Set opt.artMirror[key] (or opt.artMirror===true) to use the classic mirrored double-header instead.
  const mirror = artUrl && (opt.artMirror===true || (opt.artMirror && opt.artMirror[key]));
  const fr=resolveFrame(opt);
  const center = artUrl
      ? (mirror ? courtCenter(rankId, suit, artUrl, box, fr.rect)
                : singleArt(artUrl, fr.rect))              // uploaded art fills the card face
      : (rk.kind==='court' ? courtCenter(rankId, suit, null, box, fr.rect)
                           : pipCenter(rankId, suit, fr.rect));
  const body = fr.kind==='image'
      ? `${framePad(opt)}${fr.img}${center}`
      : `${framePad(opt)}${center}${frameOverlay(fr,opt)}`;
  return svg(`card`, rankId, suit, `${body}${indexPad(rk.label, suit, {...opt, rect:fr.rect})}`);
}

/* ---------- assemble a free-form custom card ----------------------- *
   spec: {id,title,suit?,corner?,art? (data url)}                        */
export function buildCustomCard(spec, opt={}){
  const artUrl = spec.art || opt.artUrl || (opt.artMap&&opt.artMap['custom-'+spec.id]) || null;
  const fr=resolveFrame(opt);
  const R=fr.rect;
  const s = spec.suit ? suitById(spec.suit) : null;
  const center = artUrl ? singleArt(artUrl, R)
    : `<g class="pad-center-art placeholder"><rect x="${R.x+R.w*0.1}" y="${R.y+R.h*0.12}" width="${R.w*0.8}" height="${R.h*0.62}" rx="20" fill="none" stroke="${opt.accent||GOLD}" stroke-width="3" opacity="0.6"/>
        <text x="${R.x+R.w/2}" y="${R.y+R.h*0.44}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="34" fill="#9aa3b2">drop art</text></g>`;
  // title banner near the bottom
  const ty=R.y+R.h*0.86;
  const title = spec.title ? `<g class="pad-title">
      <rect x="${R.x+R.w*0.06}" y="${(ty-46).toFixed(1)}" width="${R.w*0.88}" height="74" rx="14" fill="${PAPER_HI}" stroke="${opt.accent||GOLD}" stroke-width="2.4" opacity="0.96"/>
      <text x="${R.x+R.w/2}" y="${(ty+6).toFixed(1)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-weight="700" font-size="40" fill="#20222a">${esc(spec.title)}</text></g>` : '';
  const corner = (spec.corner||s) ? cornerBadge(spec.corner || (s?s.symbol:''), spec.suit, {...opt, rect:R}) : '';
  const body = fr.kind==='image' ? `${framePad(opt)}${fr.img}${center}`
      : `${framePad(opt)}${center}${frameOverlay(fr,opt)}`;
  return svg('card custom', 'custom', spec.id, `${body}${title}${corner}`);
}
function cornerBadge(text, suit, opt){
  const R=opt.rect||TRIM_RECT, gold=opt.accent||GOLD;
  const s=suit?suitById(suit):null, col=s?s.color:'#20222a';
  const one=(cx,cy,rot)=>`<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) ${rot?'rotate(180)':''}">
      <circle r="34" fill="${PAPER_HI}" stroke="${gold}" stroke-width="2.4"/>
      <text y="14" text-anchor="middle" font-family="${FONT_FAMILY}" font-weight="700" font-size="40" fill="${col}">${esc(text)}</text></g>`;
  const cx=R.x+46, cy=R.y+46;
  return `<g class="pad-corner">${one(cx,cy,false)}${one(CARD.w-cx,CARD.h-cy,true)}</g>`;
}

function svg(cls, rank, suit, inner){
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD.w} ${CARD.h}"
      class="${cls}" data-rank="${rank}" data-suit="${suit}" width="${CARD.w}" height="${CARD.h}">${inner}</svg>`;
}

/* ---------- whole deck --------------------------------------------- */
export function fullDeck(opt={}){
  const out=[];
  for(const s of DECK.suits) for(const r of DECK.ranks)
    out.push({ rank:r.id, suit:s.id, name:`${r.id}-${s.id}`, svg:buildCard(r.id, s.id, opt) });
  for(const v of (DECK.jokers||[]))
    out.push({ rank:'joker', suit:v, name:`joker-${v}`, svg:jokerCard(v, opt) });
  for(const c of (DECK.custom||[]))
    out.push({ rank:'custom', suit:c.id, name:`custom-${c.id}`, svg:buildCustomCard(c, opt) });
  return out;
}
export function deckCount(){
  return DECK.suits.length*DECK.ranks.length + (DECK.jokers||[]).length + (DECK.custom||[]).length;
}

/* ---------- CARD BACK (rotationally symmetric) --------------------- */
function starPath(cx,cy,outer,inner,points,rotDeg=-90){
  let d=''; const step=Math.PI/points, r0=rotDeg*Math.PI/180;
  for(let i=0;i<2*points;i++){ const rr=(i%2)?inner:outer, a=r0+i*step;
    d+=(i?'L':'M')+(cx+rr*Math.cos(a)).toFixed(1)+' '+(cy+rr*Math.sin(a)).toFixed(1); }
  return d+'Z';
}
export function cardBack(opt={}){
  const gold=opt.accent||GOLD, goldL=opt.accentLt||GOLD_LT, paper=opt.paper||PAPER;
  const field=opt.field||'#132038', field2=opt.field2||'#22365e', ink=opt.ink||'#0d1626';
  const u = Math.min(TRIM.w,TRIM.h)/750;   // scale everything off the poker baseline so the design stays centred + proportional at ANY card size
  const x=OX,y=OY,w=TRIM.w,h=TRIM.h,r=42*u,in1=26*u,in2=40*u, cx=CARD.w/2, cy=CARD.h/2;
  // Uploaded back ART: fill the whole card with the image, framed by the gold keylines. Returns early.
  if(opt.art){
    const bid='bkart'+(++_uid);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD.w} ${CARD.h}" class="card card-back" data-rank="back" data-suit="back" width="${CARD.w}" height="${CARD.h}">
      <defs><clipPath id="${bid}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath></defs>
      <rect x="0" y="0" width="${CARD.w}" height="${CARD.h}" fill="${paper}"/>
      <image href="${opt.art}" x="0" y="0" width="${CARD.w}" height="${CARD.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${bid})"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${ink}" stroke-width="2"/>
      <rect x="${x+in1}" y="${y+in1}" width="${w-in1*2}" height="${h-in1*2}" rx="${r-14*u}" fill="none" stroke="${gold}" stroke-width="${6*u}"/>
      <rect x="${x+in1+9*u}" y="${y+in1+9*u}" width="${w-(in1+9*u)*2}" height="${h-(in1+9*u)*2}" rx="${r-20*u}" fill="none" stroke="${goldL}" stroke-width="${1.4*u}" opacity="0.8"/>
    </svg>`;
  }
  const fx=x+in2,fy=y+in2,fw=w-in2*2,fh=h-in2*2,fr=r-24*u;
  const M=Math.min(246*u, Math.min(fw,fh)*0.46), ms=M/246;   // medallion outer radius, clamped to fit the field → scales with size
  const goldPip=(suit,px,py,size)=>{ const s=suitById(suit); if(!s) return ''; const k=size/100;
    if(s.shape&&SUIT_SHAPES[s.shape]) return `<path d="${SUIT_SHAPES[s.shape]}" fill="${gold}" transform="translate(${px} ${py}) scale(${k}) translate(-50 -50)"/>`;
    return `<text x="${px}" y="${py}" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI Symbol',serif" font-size="${size}" fill="${gold}">${esc(s.symbol||'●')}</text>`; };
  const orbit = DECK.suits.slice(0,4).map(s=>s.id);
  while(orbit.length<4) orbit.push(orbit[orbit.length-1]||'spades');
  const Rr=182*ms;
  const flourish=(px,py,sx,sy)=>`<g transform="translate(${px} ${py}) scale(${sx*u} ${sy*u})">
      <path d="M0 46 C0 20 20 0 46 0" fill="none" stroke="${gold}" stroke-width="${3/u}"/>
      <path d="M8 60 C8 30 30 8 60 8" fill="none" stroke="${gold}" stroke-width="${1.5/u}" opacity="0.7"/>
      <circle cx="52" cy="52" r="4" fill="${gold}"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD.w} ${CARD.h}"
      class="card card-back" data-rank="back" data-suit="back" width="${CARD.w}" height="${CARD.h}">
    <defs>
      <radialGradient id="bkField" cx="50%" cy="50%" r="72%"><stop offset="0%" stop-color="${field2}"/><stop offset="100%" stop-color="${field}"/></radialGradient>
      <pattern id="bkLattice" width="54" height="54" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d="M27 3 L51 27 L27 51 L3 27 Z" fill="none" stroke="${gold}" stroke-width="1.1" opacity="0.16"/>
        <circle cx="27" cy="27" r="2" fill="${gold}" opacity="0.22"/></pattern>
      <clipPath id="bkClip"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="${fr}"/></clipPath>
    </defs>
    <rect x="0" y="0" width="${CARD.w}" height="${CARD.h}" fill="${paper}"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${paper}" stroke="${ink}" stroke-width="2"/>
    <rect x="${x+in1}" y="${y+in1}" width="${w-in1*2}" height="${h-in1*2}" rx="${r-14}" fill="none" stroke="${gold}" stroke-width="6"/>
    <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="${fr}" fill="url(#bkField)"/>
    <g clip-path="url(#bkClip)"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="url(#bkLattice)"/>
      ${flourish(fx+14*u,fy+14*u,1,1)} ${flourish(fx+fw-14*u,fy+14*u,-1,1)}
      ${flourish(fx+14*u,fy+fh-14*u,1,-1)} ${flourish(fx+fw-14*u,fy+fh-14*u,-1,-1)}</g>
    <rect x="${fx+16*u}" y="${fy+16*u}" width="${fw-32*u}" height="${fh-32*u}" rx="${fr-8*u}" fill="none" stroke="${gold}" stroke-width="${1.5*u}" opacity="0.75"/>
    <circle cx="${cx}" cy="${cy}" r="${246*ms}" fill="url(#bkField)" opacity="0.55"/>
    <circle cx="${cx}" cy="${cy}" r="${246*ms}" fill="none" stroke="${gold}" stroke-width="${2.5*ms}"/>
    <circle cx="${cx}" cy="${cy}" r="${230*ms}" fill="none" stroke="${gold}" stroke-width="${6*ms}" opacity="0.9"/>
    <circle cx="${cx}" cy="${cy}" r="${216*ms}" fill="none" stroke="${goldL}" stroke-width="${1.4*ms}" opacity="0.8"/>
    ${goldPip(orbit[0],cx,cy-Rr,74*ms)}${goldPip(orbit[1],cx+Rr,cy,74*ms)}
    ${goldPip(orbit[2],cx,cy+Rr,74*ms)}${goldPip(orbit[3],cx-Rr,cy,74*ms)}
    <circle cx="${cx}" cy="${cy}" r="${150*ms}" fill="none" stroke="${gold}" stroke-width="${2*ms}"/>
    <path d="${starPath(cx,cy,138*ms,60*ms,8,-90)}" fill="${field}" stroke="${gold}" stroke-width="${2.5*ms}"/>
    <path d="${starPath(cx,cy,120*ms,52*ms,8,-67.5)}" fill="none" stroke="${goldL}" stroke-width="${1.4*ms}" opacity="0.85"/>
    <circle cx="${cx}" cy="${cy}" r="${40*ms}" fill="${field2}" stroke="${gold}" stroke-width="${2.5*ms}"/>
    <path d="${starPath(cx,cy,30*ms,12*ms,4,-90)}" fill="${gold}"/><circle cx="${cx}" cy="${cy}" r="${6*ms}" fill="${goldL}"/>
  </svg>`;
}

/* ---------- JOKERS ------------------------------------------------- */
export function jokerCard(variant='red', opt={}){
  const col = variant==='red'?'#c62027':'#16181d';
  const artUrl=opt.artUrl||(opt.artMap&&opt.artMap[`joker-${variant}`])||null;
  const box=opt.artBox&&opt.artBox[`joker-${variant}`];
  const fr=resolveFrame(opt);
  const R=fr.rect, mx=R.x+R.w/2, my=R.y+R.h/2;
  let center;
  if(artUrl){ center=mirroredArt(artUrl, box, R); }
  else {
    const ah=my-R.y, so=Math.min(R.w*0.17, ah*0.30), si=so*0.42, jfs=Math.max(13,R.w*0.048);
    const half=`<path d="${starPath(mx,R.y+ah*0.36,so,si,5,-90)}" fill="${col}"/>
      <text x="${mx}" y="${R.y+ah*0.80}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${jfs.toFixed(0)}" fill="${col}" letter-spacing="${(jfs*0.19).toFixed(1)}">JOKER</text>`;
    center=`<g class="pad-center-court placeholder">${half}<g transform="rotate(180 ${mx} ${my})">${half}</g></g>`;
  }
  const letters='JOKER'.split(''), sc=Math.min(1,Math.max(0.72,R.w/560));
  const stack=(x,y,rot)=>`<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) ${rot?'rotate(180)':''}" text-anchor="middle"
      font-family="${FONT_FAMILY}" font-weight="700" font-size="${(34*sc).toFixed(1)}" fill="${col}">
      ${letters.map((c,i)=>`<text y="${(i*35*sc).toFixed(1)}">${c}</text>`).join('')}
      <path d="${starPath(0,letters.length*35*sc+6,17*sc,7*sc,5,-90)}" fill="${col}"/></g>`;
  const ix=R.x+30*sc, iy=R.y+42*sc;
  const body=fr.kind==='image'?`${framePad(opt)}${fr.img}${center}`:`${framePad(opt)}${center}${frameOverlay(fr,opt)}`;
  return svg('card joker','joker',variant,`${body}${stack(ix,iy,false)}${stack(CARD.w-ix,CARD.h-iy,true)}`);
}

/* ---------- print-size helpers ------------------------------------- */
export function currentPixels(){ return { w:Math.round(CARD.w), h:Math.round(CARD.h), name:CARD_SIZES[SIZE_ID].name }; }
