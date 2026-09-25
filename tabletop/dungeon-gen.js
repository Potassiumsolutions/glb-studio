/* ============================================================================
   DUNGEON & CAVE GENERATOR (5-ft battle scale) — pure data, no three.js.
   Output is in GRID UNITS (1 unit = one 5-ft square), origin = top-left corner
   of the map, x → right, y → down. The host (index.html) turns it into 3D rock,
   floors, doors and features, and the 🗺 VTT export turns `walls`/`doors`/lights
   into Universal VTT data — all from this ONE layout, so they always agree.

     DungeonGen.generate({kind:'dungeon'|'cave', cols, rows, seed})
       → { kind, cols, rows, res, floor:[0/1 × (cols·res)×(rows·res)], water:[…]|null,
           walls:[[{x,y}…closed loop]…], waterLoops:[…], doors:[{x1,y1,x2,y2,open}],
           rooms:[{x,y,w,h,type}], features:[{kind,x,y,w,d,face?}] }
   ============================================================================ */
(function(root){
  'use strict';
  function rng32(a){ a=(a>>>0)||1; return ()=>{ a=(a+0x6D2B79F5)>>>0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

  /* ---------- outlines ---------- */
  // axis-aligned boundary loops of a 0/1 grid (cell-edge exact). Traversal keeps a consistent winding.
  function gridLoops(m, W, H){
    const at=(x,y)=> x>=0&&y>=0&&x<W&&y<H && m[y*W+x]===1;
    const out=new Map(), key=(x,y)=>x+','+y, edges=[];
    const add=(ax,ay,bx,by)=>{ const e={ax,ay,bx,by,used:false}; edges.push(e); const k=key(ax,ay); (out.get(k)||out.set(k,[]).get(k)).push(e); };
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ if(!at(x,y)) continue;
      if(!at(x,y-1)) add(x+1,y, x,y); if(!at(x-1,y)) add(x,y, x,y+1); if(!at(x,y+1)) add(x,y+1, x+1,y+1); if(!at(x+1,y)) add(x+1,y+1, x+1,y); }
    const loops=[];
    for(const e0 of edges){ if(e0.used) continue; const pts=[]; let e=e0;
      while(e && !e.used){ e.used=true; pts.push({x:e.ax,y:e.ay}); const nx=(out.get(key(e.bx,e.by))||[]).filter(n=>!n.used);
        // at a pinch point (two regions touching at a corner) turn so each region keeps its own loop
        e = nx.length<=1 ? nx[0] : nx.sort((a,b)=>turn(e,a)-turn(e,b))[0]; }
      if(pts.length>=4) loops.push(simplify(pts)); }
    return loops;
    function turn(e,n){ const d1x=e.bx-e.ax, d1y=e.by-e.ay, d2x=n.bx-n.ax, d2y=n.by-n.ay; return d1x*d2y-d1y*d2x; }
  }
  // drop collinear points
  function simplify(p){ const o=[]; for(let i=0;i<p.length;i++){ const a=p[(i-1+p.length)%p.length], b=p[i], c=p[(i+1)%p.length];
      if(Math.abs((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x))>1e-9) o.push(b); } return o; }
  // marching squares on a scalar field sampled at cell centres → smooth closed loops (outside the grid counts as 0)
  function msLoops(f, W, H, iso){
    const v=(x,y)=> (x<0||y<0||x>=W||y>=H) ? 0 : f[y*W+x];
    const segs=[], P=(x,y)=>({x:x+0.5,y:y+0.5});
    const lerp=(a,b,va,vb)=>{ const t=(iso-va)/((vb-va)||1e-9); return {x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t}; };
    for(let y=-1;y<H;y++) for(let x=-1;x<W;x++){
      const a=v(x,y), b=v(x+1,y), c=v(x+1,y+1), d=v(x,y+1), A=P(x,y), B=P(x+1,y), C=P(x+1,y+1), D=P(x,y+1);
      const idx=(a>iso?8:0)|(b>iso?4:0)|(c>iso?2:0)|(d>iso?1:0); if(idx===0||idx===15) continue;
      const top=()=>lerp(A,B,a,b), right=()=>lerp(B,C,b,c), bot=()=>lerp(D,C,d,c), left=()=>lerp(A,D,a,d);
      const S=(p,q)=>segs.push([p,q]);
      switch(idx){ case 1: S(left(),bot()); break; case 2: S(bot(),right()); break; case 3: S(left(),right()); break; case 4: S(right(),top()); break;
        case 5: S(left(),top()); S(right(),bot()); break; case 6: S(bot(),top()); break; case 7: S(left(),top()); break; case 8: S(top(),left()); break;
        case 9: S(top(),bot()); break; case 10: S(top(),right()); S(bot(),left()); break; case 11: S(top(),right()); break; case 12: S(right(),left()); break;
        case 13: S(right(),bot()); break; case 14: S(bot(),left()); break; } }
    // chain segments into loops by shared endpoints
    const k=(p)=>Math.round(p.x*1000)+','+Math.round(p.y*1000), from=new Map();
    segs.forEach((s,i)=>{ const kk=k(s[0]); (from.get(kk)||from.set(kk,[]).get(kk)).push(i); });
    const used=new Uint8Array(segs.length), loops=[];
    for(let i=0;i<segs.length;i++){ if(used[i]) continue; const pts=[]; let j=i;
      while(j!=null && !used[j]){ used[j]=1; pts.push(segs[j][0]); const nx=(from.get(k(segs[j][1]))||[]).find(n=>!used[n]); j=nx; }
      if(pts.length>=6) loops.push(dp(pts,0.08)); }
    return loops;
  }
  // Douglas–Peucker on a closed loop (keeps VTT wall counts sane)
  function dp(pts,eps){ if(pts.length<8) return pts; const rec=(a,b,out)=>{ let md=0, mi=-1; const A=pts[a], B=pts[b], L=Math.hypot(B.x-A.x,B.y-A.y)||1e-9;
      for(let i=a+1;i<b;i++){ const d=Math.abs((B.x-A.x)*(A.y-pts[i].y)-(A.x-pts[i].x)*(B.y-A.y))/L; if(d>md){ md=d; mi=i; } }
      if(md>eps){ rec(a,mi,out); rec(mi,b,out); } else out.push(A); };
    const h=pts.length>>1, o=[]; rec(0,h,o); rec(h,pts.length-1,o); o.push(pts[pts.length-1]); return o; }
  // SEALED cells (dead-end passages): [[x,y],…] in whole squares. Later extensions never place rooms on / route through / next to them.
  function sealMask(sealed, cols, rows, res, margin){ res=res||1; margin=margin==null?1:margin; const W=cols*res, m=new Uint8Array(W*rows*res);
    for(const [cx,cy] of (sealed||[])) for(let y=(cy-margin)*res;y<(cy+margin+1)*res;y++) for(let x=(cx-margin)*res;x<(cx+margin+1)*res;x++) if(x>=0&&y>=0&&x<W&&y<rows*res) m[y*W+x]=1; return m; }
  const shiftSeal=(sealed,ox,oy)=>(sealed||[]).map(([x,y])=>[x+ox,y+oy]);
  const blur=(m,W,H,r)=>{ const o=new Array(W*H).fill(0); for(let y=0;y<H;y++) for(let x=0;x<W;x++){ let s=0,n=0; for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){ const X=x+dx, Y=y+dy; n++; if(X>=0&&Y>=0&&X<W&&Y<H) s+=m[Y*W+X]; } o[y*W+x]=s/n; } return o; };

  /* ---------- DUNGEON: rooms + A* corridors + doors ---------- */
  const ROOM_TYPES=['crypt','barracks','library','storeroom','shrine','hall','treasury','kitchen','guardroom'];
  // 🎨 STYLES (v1.25): same rooms + corridors engine, themed room types / dressing / look. classic = no style (unchanged output)
  const STYLE_TYPES={ mine:['stope','orevein','cartdepot','toolstore','bunkroom','collapse','powder'], sewer:['cistern','junction','pumproom','smugglers','overflow','storeroom'],
    temple:['chapel','cells','scriptorium','refectory','vestry','ossuary','reliquary'] };
  const STYLE_BIG={ mine:['stope','collapse'], sewer:['cistern','cistern'], temple:['chapel','ossuary'] };
  const STYLE_PILLARS={ mine:['stope'], sewer:['cistern'], temple:['chapel','ossuary','lair'] };
  // base (Extend): { floor, rooms, doors, features, region:{x0,y0,x1,y1} } already in the NEW grid's coords. The old
  // layout is kept exactly; new rooms go only inside `region` (the added strip) and are wired to the nearest old rooms.
  function dungeon(cols, rows, seed, base, arrivals, opt){ arrivals=arrivals||[]; opt=opt||{};
    const style=opt.style||(base&&base.style)||null, TYPES=STYLE_TYPES[style]||ROOM_TYPES, BIG=STYLE_BIG[style]||['hall','crypt'], PIL=STYLE_PILLARS[style]||['hall','crypt','lair'];
    const r=rng32(seed), ri=(n)=>Math.floor(r()*n), W=cols, H=rows, floor=base?base.floor.slice():new Array(W*H).fill(0), roomAt=new Int16Array(W*H).fill(-1);
    const R=base?base.region:{x0:2,y0:2,x1:W-2,y1:H-2}, RW=R.x1-R.x0, RH=R.y1-R.y0, SEAL=base&&base.sealed&&base.sealed.length?sealMask(base.sealed,W,H,1,1):null;
    const sealedRect=(x,y,w,h)=>{ if(!SEAL) return false; for(let yy=y-1;yy<y+h+1;yy++) for(let xx=x-1;xx<x+w+1;xx++) if(xx>=0&&yy>=0&&xx<W&&yy<H&&SEAL[yy*W+xx]) return true; return false; };
    const rooms=base?base.rooms.map(o=>({...o,old:true})):[], nOld=rooms.length;
    const water = style==='sewer' ? (base&&base.water ? base.water.slice() : new Array(W*H).fill(0)) : null;
    if(opt.force) for(const f of opt.force) rooms.push({...f});   // e.g. the temple's central nave
    const target=nOld+Math.max(base?1:3, Math.round(RW*RH/70)), small=W*H<520, G=small?2:3, maxS=small?4:5;
    // ARRIVAL rooms first: a room around every landing spot from the level above (stairs arrive on the SAME square)
    for(const a of arrivals){ const fx0=Math.floor(a.x-a.w/2+0.05), fx1=Math.floor(a.x+a.w/2-0.05), fy0=Math.floor(a.y-a.d/2+0.05), fy1=Math.floor(a.y+a.d/2-0.05);
      const w=Math.max(fx1-fx0+3, 4+ri(3)), h=Math.max(fy1-fy0+3, 4+ri(2));
      let x=fx0-1-ri(Math.max(1,w-(fx1-fx0+2))), y=fy0-1-ri(Math.max(1,h-(fy1-fy0+2)));
      x=Math.max(2,Math.min(W-2-w,x)); y=Math.max(2,Math.min(H-2-h,y));
      if(fx0<x||fx1>=x+w||fy0<y||fy1>=y+h){ x=Math.max(1,Math.min(fx0-1,W-1-w)); y=Math.max(1,Math.min(fy0-1,H-1-h)); }
      rooms.push({x,y,w,h,arrival:1}); }
    for(let t=0;t<600 && rooms.length<target;t++){ const big=!base && !opt.force && rooms.length===1 && W>=20 && H>=16;
      const w=big?7+ri(4):3+ri(maxS), h=big?6+ri(3):3+ri(maxS-1); if(w>RW-1||h>RH-1) continue;
      const x=R.x0+ri(RW-w), y=R.y0+ri(RH-h); if(x<2||y<2||x+w>W-2||y+h>H-2||sealedRect(x,y,w,h)) continue;
      if(opt.maxX && x+w>opt.maxX) continue;   // temple: rooms only on the half that gets mirrored
      if(rooms.some(o=>x<o.x+o.w+G && x+w+G>o.x && y<o.y+o.h+G && y+h+G>o.y)) continue;
      rooms.push({x,y,w,h}); }
    rooms.forEach((o,i)=>{ for(let y=o.y;y<o.y+o.h;y++) for(let x=o.x;x<o.x+o.w;x++){ if(!o.old) floor[y*W+x]=1; roomAt[y*W+x]=i; } });   // old rooms keep their exact floor (pillars stay rock)
    const cx=(o)=>o.x+o.w/2, cy=(o)=>o.y+o.h/2, dC=(a,b)=>Math.hypot(cx(rooms[a])-cx(rooms[b]),cy(rooms[a])-cy(rooms[b]));
    // connections: MST over the NEW rooms (+ a few loops); on Extend, also 1–2 links from new rooms to the nearest OLD rooms
    const fresh=[]; for(let i=nOld;i<rooms.length;i++) fresh.push(i);
    const edges=[];
    if(fresh.length){ const inT=new Set([fresh[0]]);
      while(inT.size<fresh.length){ let best=null; for(const a of inT) for(const b of fresh){ if(inT.has(b)) continue; const d=dC(a,b); if(!best||d<best.d) best={a,b,d}; } inT.add(best.b); edges.push([best.a,best.b]); }
      const extra=Math.round(fresh.length*0.25); for(let t=0;t<extra*6 && edges.length<fresh.length-1+extra;t++){ const a=fresh[ri(fresh.length)], b=fresh[ri(fresh.length)]; if(a===b||edges.some(e=>(e[0]===a&&e[1]===b)||(e[0]===b&&e[1]===a))) continue;
        if(dC(a,b)<Math.min(W,H)*0.6) edges.push([a,b]); } }
    if(base && fresh.length && nOld){ const pairs=[]; for(const a of fresh) for(let b=0;b<nOld;b++) if(rooms[b].type!=='deadend') pairs.push([a,b,dC(a,b)]); pairs.sort((p,q)=>p[2]-q[2]);
      const links=Math.min(fresh.length>=3?2:1, pairs.length), usedNew=new Set(), usedOld=new Set(); for(const [a,b] of pairs){ if(edges.filter(e=>e.link).length>=links) break; if(usedNew.has(a)||usedOld.has(b)) continue; const e=[a,b]; e.link=1; edges.unshift(e); usedNew.add(a); usedOld.add(b); } }
    const nearRoom=(x,y)=>{ for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy; if(X>=0&&Y>=0&&X<W&&Y<H&&roomAt[Y*W+X]>=0) return true; } return false; };
    const doorCells=new Set(), newDoors=[], doorOf=new Map();   // key "x,y" of the corridor cell just outside a door
    const pickDoor=(ai,bi)=>{ const A=rooms[ai], B=rooms[bi], dx=cx(B)-cx(A), dy=cy(B)-cy(A); let side;
      if(Math.abs(dx)>Math.abs(dy)) side=dx>0?1:3; else side=dy>0?2:0;
      const exist=[...doorOf.values()].find(d=>d.room===ai && d.side===side); if(exist) return exist;
      const span = side===0||side===2 ? A.w : A.h; if(span<1) return null; const t=span>=3 ? 1+ri(span-2) : ri(span);
      const ix = side===1 ? A.x+A.w-1 : side===3 ? A.x : A.x+t, iy = side===2 ? A.y+A.h-1 : side===0 ? A.y : A.y+t;
      const ox = ix+(side===1?1:side===3?-1:0), oy = iy+(side===2?1:side===0?-1:0);
      if(ox<1||oy<1||ox>=W-1||oy>=H-1) return null;
      const d={room:ai, side, ix, iy, ox, oy}; doorOf.set(ox+','+oy+':'+ai, d); doorCells.add(ox+','+oy); return d; };
    const astar=(s,g)=>{ const K=(x,y)=>y*W+x, open=[[0,s.x,s.y]], gs=new Map([[K(s.x,s.y),0]]), prev=new Map();
      while(open.length){ open.sort((a,b)=>a[0]-b[0]); const [,x,y]=open.shift(); if(x===g.x&&y===g.y) break;
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx, Y=y+dy; if(X<1||Y<1||X>=W-1||Y>=H-1) continue; if(roomAt[K(X,Y)]>=0) continue;
          const isEnd=(X===g.x&&Y===g.y)||doorCells.has(X+','+Y); if(SEAL && SEAL[K(X,Y)] && !isEnd) continue;   // never through / beside a sealed dead end
          const c=(floor[K(X,Y)]?0.35:1)+(!isEnd && nearRoom(X,Y)?6:0)+(dx!==0&&prev.get(K(x,y))!=null&&(prev.get(K(x,y))%W)===x?0.4:0);   // prefer existing halls; mild straightness
          const ng=gs.get(K(x,y))+c; if(ng<(gs.get(K(X,Y))??1e9)){ gs.set(K(X,Y),ng); prev.set(K(X,Y),K(x,y)); open.push([ng+Math.abs(X-g.x)+Math.abs(Y-g.y),X,Y]); } } }
      if(!gs.has(K(g.x,g.y))) return null; const path=[]; let k=K(g.x,g.y); while(k!=null){ path.push(k); k=prev.get(k); } return path; };
    const used=new Set();
    for(const [a,b] of edges){ const da=pickDoor(a,b), db=pickDoor(b,a); if(!da||!db) continue;
      const path=astar({x:da.ox,y:da.oy},{x:db.ox,y:db.oy}); if(!path) continue;
      for(const k of path) floor[k]=1; used.add(da); used.add(db);
      if(style==='sewer') for(const k of path){ const x=k%W, y=(k/W)|0; if(!nearRoom(x,y)) water[k]=1;
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy; if(X<1||Y<1||X>=W-1||Y>=H-1||roomAt[Y*W+X]>=0||nearRoom(X,Y)||(SEAL&&SEAL[Y*W+X])) continue; floor[Y*W+X]=1; } }
      else if(style==='mine') for(const k of path){ if(r()<0.12){ const x=k%W, y=(k/W)|0, [dx,dy]=[[1,0],[-1,0],[0,1],[0,-1]][ri(4)], X=x+dx, Y=y+dy; if(X>1&&Y>1&&X<W-2&&Y<H-2&&roomAt[Y*W+X]<0&&!nearRoom(X,Y)&&!(SEAL&&SEAL[Y*W+X])) floor[Y*W+X]=1; } } }
    const pOpen = style==='mine'?0.85 : style==='sewer'?0.6 : style==='temple'?0.45 : 0.28;
    for(const d of used){ const open = r()<pOpen;   // an open archway, else a door (a sewer's are iron grates)
      // the doorway is the shared edge between the room's border cell and the corridor cell outside it
      if(d.side===0) newDoors.push({x1:d.ix,y1:d.iy,x2:d.ix+1,y2:d.iy,open}); else if(d.side===2) newDoors.push({x1:d.ix,y1:d.iy+1,x2:d.ix+1,y2:d.iy+1,open});
      else if(d.side===3) newDoors.push({x1:d.ix,y1:d.iy,x2:d.ix,y2:d.iy+1,open}); else newDoors.push({x1:d.ix+1,y1:d.iy,x2:d.ix+1,y2:d.iy+1,open}); }
    if(style==='sewer') for(const d of newDoors) if(!d.open) d.grate=true;
    const doors=(base?base.doors:[]).concat(newDoors);
    // unreachable rooms go back to rock (keeps the map honest) — except ARRIVAL rooms, which get a passage dug to the rest
    const seen=new Uint8Array(W*H), flood=(from)=>{ const st=[from]; seen[from]=1; while(st.length){ const k=st.pop(), x=k%W, y=(k/W)|0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy, K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||seen[K]||!floor[K]) continue; seen[K]=1; st.push(K); } } };
    flood(rooms[0].y*W+rooms[0].x);
    for(const o of rooms){ if(!o.arrival || seen[o.y*W+o.x]) continue;
      const prev=new Int32Array(W*H).fill(-2), q=[]; for(let y=o.y;y<o.y+o.h;y++) for(let x=o.x;x<o.x+o.w;x++){ prev[y*W+x]=-1; q.push(y*W+x); }
      let hit=-1; for(let h=0;h<q.length&&hit<0;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<1||Y<1||X>=W-1||Y>=H-1||prev[K]!==-2) continue; prev[K]=k; if(seen[K]){ hit=K; break; } q.push(K); } }
      for(let k=hit;k>=0&&prev[k]!==-1;k=prev[k]) floor[k]=1; flood(o.y*W+o.x); }
    for(let k=0;k<W*H;k++) if(floor[k]&&!seen[k]) floor[k]=0;
    if(water) for(let k=0;k<W*H;k++) if(!floor[k]) water[k]=0;
    const live=rooms.map((o,i)=>seen[o.y*W+o.x]?i:-1).filter(i=>i>=0);
    const okC=(x,y)=>x>=0&&y>=0&&x<W&&y<H&&floor[y*W+x]&&seen[y*W+x];
    const doorsLive=doors.filter(d=> d.x1===d.x2 ? okC(d.x1-1,d.y1)&&okC(d.x1,d.y1) : okC(d.x1,d.y1-1)&&okC(d.x1,d.y1));   // both sides of the doorway reachable
    // room types: entrance (stairs up) = room 0, lair (stairs down) = farthest by corridor distance
    const dist=new Int32Array(W*H).fill(-1), q=[rooms[0].y*W+rooms[0].x]; dist[q[0]]=0;
    for(let h=0;h<q.length;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||dist[K]>=0||!floor[K]) continue; dist[K]=dist[k]+1; q.push(K); } }
    const liveNew=live.filter(i=>i>=nOld), hasLair=rooms.some(o=>o.old&&o.type==='lair');
    let far=liveNew[0]??live[0], fd=-1; for(const i of (base?liveNew:live)){ const o=rooms[i], dd=dist[Math.floor(cy(o))*W+Math.floor(cx(o))]; if(dd>fd){ fd=dd; far=i; } }
    const out=[]; for(const i of live){ const o=rooms[i]; if(o.old){ const k={x:o.x,y:o.y,w:o.w,h:o.h,type:o.type}; if(o.n) k.n=o.n; out.push(k); continue; }   // old rooms keep their key number
      if(o.arrival && i!==live[0]){ out.push({x:o.x,y:o.y,w:o.w,h:o.h,type:TYPES[ri(TYPES.length)],fresh:1,arrival:1}); continue; }
      out.push({x:o.x,y:o.y,w:o.w,h:o.h, type: (!base && i===live[0])?'entrance' : (i===far && (!base || !hasLair))?'lair' : (o.w>=6&&o.h>=5 ? (r()<0.5?BIG[0]:BIG[1]) : TYPES[ri(TYPES.length)]), fresh:1}); }
    // pillars: big halls / crypts get rows of 1-square stone columns (they're real walls for line of sight)
    for(const o of out){ if(!o.fresh || o.arrival || !PIL.includes(o.type) || o.w<6 || o.h<5) continue;
      for(let y=o.y+1;y<o.y+o.h-1;y+=2) for(let x=o.x+1;x<o.x+o.w-1;x+=Math.max(2,o.w-3)){ if(y===o.y+1||y>=o.y+o.h-2){ floor[y*W+x]=0; } } }
    styleRooms(style, out.filter(o=>o.fresh), floor, water, W, H, r, doorsLive);
    const arr=arrivals.map(a=>({...a, link:'up'}));
    const features=(base?base.features:[]).concat(arr, opt.noDress?[]:dungeonDressing(out.filter(o=>!base||o.fresh), doorsLive, floor, W, H, r, {allRooms:out, region:base?R:null, prior:(base?base.features:[]).concat(arr), noEntranceStairs:arr.length>0, style, water}));
    if(!base && !opt.noDress) drops(features, out, floor, W, H, r, 'dungeon', 1, false, water);
    out.forEach(o=>{ delete o.fresh; });
    const D={ kind:'dungeon', cols, rows, res:1, floor, water, walls:gridLoops(floor,W,H), waterLoops:water?gridLoops(water,W,H):[], doors:doorsLive, rooms:out, features, sealed:base&&base.sealed?base.sealed:[], newRooms:base?liveNew.length:out.length };
    if(style) D.style=style; return D;
  }
  function styleRooms(style, rooms, floor, water, W, H, r, doors){ if(!style) return;
    const nearDoor=(x,y)=>doors.some(d=>Math.hypot((d.x1+d.x2)/2-x-0.5,(d.y1+d.y2)/2-y-0.5)<1.6);
    for(const o of rooms){
      if(style==='mine' && o.w*o.h>=9 && !o.arrival){ for(let x=o.x;x<o.x+o.w;x++) for(const y of [o.y,o.y+o.h-1]){ if(r()<0.22 && !nearDoor(x,y)) floor[y*W+x]=0; }   // hewn, uneven walls
        for(let y=o.y+1;y<o.y+o.h-1;y++) for(const x of [o.x,o.x+o.w-1]){ if(r()<0.22 && !nearDoor(x,y)) floor[y*W+x]=0; }
        for(let x=o.x;x<o.x+o.w;x++) for(const y of [o.y-1,o.y+o.h]){ if(y>1&&y<H-2&&r()<0.18 && !nearDoor(x,y)) floor[y*W+x]=1; } }
      if(style==='sewer' && water){ if(o.type==='cistern'){ for(let y=o.y+1;y<o.y+o.h-1;y++) for(let x=o.x+1;x<o.x+o.w-1;x++) if(floor[y*W+x]) water[y*W+x]=1; }
        else if(o.type==='overflow'){ for(let y=o.y+Math.ceil(o.h/2);y<o.y+o.h-1;y++) for(let x=o.x+1;x<o.x+o.w-1;x++) if(floor[y*W+x]) water[y*W+x]=1; } } } }
  // 🏛 TEMPLE: rooms are laid out on the WEST half around a central nave, then mirrored east → a symmetric plan
  function temple(cols, rows, seed){ const W=cols, H=rows, half=Math.floor(W/2), odd=W%2;
    const nw=(W>=30?8:6)+odd, nh=Math.max(6, Math.min(H-6, Math.round(H*0.55))), nx=(W-nw)/2, ny=Math.floor((H-nh)/2);
    const L=dungeon(W,H,seed,null,[],{style:'temple', force:[{x:nx,y:ny,w:nw,h:nh}], maxX:half, noDress:true});
    const F=L.floor.slice(); for(let y=0;y<H;y++) for(let x=W-half;x<W;x++) F[y*W+x]=L.floor[y*W+(W-1-x)];
    const rooms=[]; for(const o of L.rooms){ if(o.x===nx && o.y===ny && o.w===nw && o.h===nh){ rooms.push({x:o.x,y:o.y,w:o.w,h:o.h,type:'entrance'}); continue; }
      if(o.x+o.w<=half){ rooms.push({x:o.x,y:o.y,w:o.w,h:o.h,type:o.type}); rooms.push({x:W-o.x-o.w,y:o.y,w:o.w,h:o.h,type:o.type==='lair'?'reliquary':o.type}); } }
    let doors=[]; for(const d of L.doors){ if(d.x1===d.x2){ if(d.x1*2<W){ doors.push({...d}); doors.push({...d, x1:W-d.x1, x2:W-d.x1}); } else if(d.x1*2===W) doors.push({...d}); }
      else { if(d.x1<half){ doors.push({...d}); doors.push({...d, x1:W-1-d.x1, x2:W-d.x1}); } else if(odd && d.x1===half) doors.push({...d}); } }
    // nave pillars: two symmetric rows, clear of the altar end and the way in
    for(let y=ny+2;y<ny+nh-2;y+=2){ F[y*W+nx+1]=0; F[y*W+nx+nw-2]=0; }
    // keep only what the nave reaches
    const seen=new Uint8Array(W*H), st=[(ny+nh-1)*W+nx+Math.floor(nw/2)]; seen[st[0]]=1;
    while(st.length){ const k=st.pop(), x=k%W, y=(k/W)|0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||seen[K]||!F[K]) continue; seen[K]=1; st.push(K); } }
    for(let k=0;k<W*H;k++) if(!seen[k]) F[k]=0;
    const R2=rooms.filter(o=>{ for(let y=o.y;y<o.y+o.h;y++) for(let x=o.x;x<o.x+o.w;x++) if(F[y*W+x]) return true; return false; });
    const T={floor:F, cols:W, rows:H, res:1}; doors=doors.filter(d=>doorOk(T,d));
    const r=rng32((seed^0x51ed270b)>>>0);
    const features=dungeonDressing(R2, doors, F, W, H, r, {allRooms:R2, style:'temple'}); drops(features, R2, F, W, H, r, 'dungeon');
    return { kind:'dungeon', style:'temple', cols, rows, res:1, floor:F, water:null, walls:gridLoops(F,W,H), waterLoops:[], doors, rooms:R2, features, sealed:[], newRooms:R2.length }; }
  // furniture / dressing per room type, kept clear of doorways; wall torches everywhere
  function dungeonDressing(rooms, doors, floor, W, H, r, opt){ opt=opt||{}; const allRooms=opt.allRooms||rooms, Rg=opt.region;
    const F=[], ri=(n)=>Math.floor(r()*n), WA=opt.water, ST=opt.style||null, isF=(x,y)=>x>=0&&y>=0&&x<W&&y<H&&floor[y*W+x]===1&&!(WA&&WA[y*W+x]);
    const occ=new Set(), cellK=(x,y)=>Math.floor(x)+','+Math.floor(y);
    for(const f of (opt.prior||[])){ if(f.flat) continue; const m=f.link?1:0;   // Extend / landings: reserve the whole footprint (+1 square round a landing)
      for(let y=Math.floor(f.y-f.d/2)-m;y<=Math.floor(f.y+f.d/2-0.01)+m;y++) for(let x=Math.floor(f.x-f.w/2)-m;x<=Math.floor(f.x+f.w/2-0.01)+m;x++) occ.add(x+','+y); }
    const doorNear=(x,y,rad)=>doors.some(d=>Math.hypot((d.x1+d.x2)/2-x,(d.y1+d.y2)/2-y)<rad);
    const put=(it)=>{ const cells=[]; for(let y=Math.floor(it.y-it.d/2+0.05);y<=Math.floor(it.y+it.d/2-0.05);y++) for(let x=Math.floor(it.x-it.w/2+0.05);x<=Math.floor(it.x+it.w/2-0.05);x++) cells.push([x,y]);
      if(cells.some(([x,y])=>!isF(x,y)||occ.has(x+','+y))) return false; if(doorNear(it.x,it.y,1.2)) return false; if(!it.flat) cells.forEach(([x,y])=>occ.add(x+','+y)); F.push(it); return true; };
    // against a wall of room o on side s (0 top,1 right,2 bottom,3 left); item length along the wall `len`, depth `dep`
    const wall=(o,s,len,dep,kind,tries)=>{ for(let t=0;t<(tries||6);t++){ const u=(o.w>=len+0.2 && (s===0||s===2)) ? o.x+len/2+r()*(o.w-len) : (o.h>=len+0.2 ? o.y+len/2+r()*(o.h-len) : null); if(u==null) return false;
        const it = s===0?{kind,x:u,y:o.y+dep/2+0.04,w:len,d:dep,face:0}: s===2?{kind,x:u,y:o.y+o.h-dep/2-0.04,w:len,d:dep,face:2}: s===3?{kind,x:o.x+dep/2+0.04,y:u,w:dep,d:len,face:3}:{kind,x:o.x+o.w-dep/2-0.04,y:u,w:dep,d:len,face:1};
        if(put(it)) return it; } return null; };
    const mid=(o,kind,w,d)=>put({kind,x:o.x+o.w/2,y:o.y+o.h/2,w,d});
    const scatter=(o,kind,n,s)=>{ for(let i=0;i<n;i++){ put({kind,x:o.x+0.5+ri(o.w)+ (r()-0.5)*0.2,y:o.y+0.5+ri(o.h)+(r()-0.5)*0.2,w:s,d:s}); } };
    for(const o of rooms){ const sides=[0,1,2,3].sort(()=>r()-0.5);
      switch(o.type){
        case 'entrance': if(!opt.noEntranceStairs){ let st=null; for(const sd of (ST==='temple'?[2,...sides]:sides)){ st=wall(o,sd,1.7,0.9,'stairs'); if(st) break; } if(st) st.link='up'; } scatter(o,'rubble',1,0.7); break;   // every wall is tried → the way in always has its stairs
        case 'lair': { let st=null; for(const sd of sides){ st=wall(o,sd,1.7,0.9,'stairs'); if(st) break; } if(st) st.link='down'; } if(ST) break; mid(o,'statue',0.9,0.9); wall(o,sides[1],1,0.9,'chest'); scatter(o,'bones',3,0.6); put({kind:'brazier',x:o.x+1.5,y:o.y+1.5,w:0.8,d:0.8}); put({kind:'brazier',x:o.x+o.w-1.5,y:o.y+o.h-1.5,w:0.8,d:0.8}); break;
        case 'crypt': for(let i=0;i<Math.min(4,Math.floor(o.w/2));i++) put({kind:'sarcophagus',x:o.x+1.5+i*2,y:o.y+o.h/2,w:0.8,d:1.8}); scatter(o,'bones',2,0.6); break;
        case 'barracks': for(let i=0;i<Math.max(2,Math.floor(o.w/1.5));i++) wall(o,i%2?0:2,0.8,1.5,'bed',3); wall(o,sides[1],1.2,0.35,'weaponrack'); wall(o,sides[2],1,0.8,'chest'); break;
        case 'library': for(const s of sides.slice(0,3)) wall(o,s,Math.min(2.4,(s%2?o.h:o.w)-1),0.35,'bookshelf'); mid(o,'table',1.4,0.8); break;
        case 'storeroom': scatter(o,'crate',3+ri(3),0.8); scatter(o,'barrel',2+ri(3),0.55); break;
        case 'shrine': mid(o,'altar',1.3,0.6); put({kind:'candles',x:o.x+o.w/2-1,y:o.y+o.h/2,w:0.3,d:0.3}); put({kind:'candles',x:o.x+o.w/2+1,y:o.y+o.h/2,w:0.3,d:0.3}); break;
        case 'hall': mid(o,'table',Math.min(o.w-3,4),1); put({kind:'brazier',x:o.x+1.5,y:o.y+o.h/2,w:0.8,d:0.8}); put({kind:'brazier',x:o.x+o.w-1.5,y:o.y+o.h/2,w:0.8,d:0.8}); break;
        case 'treasury': for(let i=0;i<3;i++) wall(o,sides[i%4],1,0.8,'chest'); scatter(o,'crate',1,0.8); break;
        case 'kitchen': wall(o,sides[0],1.3,0.6,'fireplace'); mid(o,'table',1.4,0.8); scatter(o,'barrel',2,0.55); put({kind:'cauldron',x:o.x+o.w/2+1,y:o.y+o.h/2+1,w:0.8,d:0.8}); break;
        case 'guardroom': mid(o,'table',1,0.8); wall(o,sides[0],1.2,0.35,'weaponrack'); scatter(o,'barrel',1,0.55); break;
        // ⛏ mine
        case 'stope': scatter(o,'ore',3,0.8); wall(o,sides[0],1.3,0.9,'minecart'); break;
        case 'orevein': for(let i=0;i<4;i++) wall(o,sides[i%4],0.9,0.5,'ore'); scatter(o,'rubble',1,0.7); break;
        case 'cartdepot': wall(o,sides[0],1.3,0.9,'minecart'); wall(o,sides[1],1.3,0.9,'minecart'); scatter(o,'crate',2,0.8); break;
        case 'toolstore': wall(o,sides[0],1.2,0.35,'toolrack'); scatter(o,'crate',2,0.8); scatter(o,'barrel',1,0.55); break;
        case 'bunkroom': for(let i=0;i<3;i++) wall(o,sides[i%2],1.5,0.6,'bedroll',4); mid(o,'table',1.2,0.8); break;
        case 'collapse': scatter(o,'rubble',6,0.8); scatter(o,'bones',1,0.6); break;
        case 'powder': scatter(o,'powder',3+ri(2),0.55); scatter(o,'crate',1,0.8); break;
        // 🕳 sewer
        case 'cistern': wall(o,sides[0],0.5,0.3,'pipe'); break;
        case 'junction': mid(o,'drain',0.8,0.8); wall(o,sides[0],0.5,0.3,'pipe'); break;
        case 'pumproom': wall(o,sides[0],1.2,0.6,'valve'); wall(o,sides[1],0.5,0.3,'pipe'); scatter(o,'crate',1,0.8); break;
        case 'smugglers': mid(o,'table',1.2,0.8); scatter(o,'crate',3,0.8); scatter(o,'barrel',2,0.55); break;
        case 'overflow': wall(o,sides[0],0.5,0.3,'pipe'); wall(o,sides[1],0.5,0.3,'pipe'); break;
        // 🏛 temple
        case 'chapel': wall(o,sides[0],1.3,0.6,'altar'); put({kind:'candles',x:o.x+o.w/2-1,y:o.y+o.h/2,w:0.3,d:0.3}); put({kind:'candles',x:o.x+o.w/2+1,y:o.y+o.h/2,w:0.3,d:0.3}); wall(o,sides[1],0.9,0.9,'statue'); break;
        case 'cells': for(let i=0;i<3;i++) wall(o,sides[i%2],0.8,1.5,'bed',4); break;
        case 'scriptorium': wall(o,sides[0],Math.min(2.4,(sides[0]%2?o.h:o.w)-1),0.35,'bookshelf'); wall(o,sides[1],Math.min(2.4,(sides[1]%2?o.h:o.w)-1),0.35,'bookshelf'); mid(o,'table',1.4,0.8); put({kind:'candles',x:o.x+o.w/2,y:o.y+o.h/2+1,w:0.3,d:0.3}); break;
        case 'refectory': mid(o,'table',Math.max(1.4,Math.min(o.w-2.5,4)),1); scatter(o,'barrel',1,0.55); break;
        case 'vestry': wall(o,sides[0],1,0.5,'wardrobe'); wall(o,sides[1],1,0.8,'chest'); break;
        case 'ossuary': for(let i=0;i<Math.min(4,Math.floor(o.w/2));i++) put({kind:'sarcophagus',x:o.x+1.5+i*2,y:o.y+o.h/2,w:0.8,d:1.8}); scatter(o,'bones',3,0.6); break;
        case 'reliquary': wall(o,sides[0],1,0.8,'chest'); wall(o,sides[1],1,0.8,'chest'); mid(o,'font',0.9,0.9); break; }
      if(ST==='temple' && o.type==='entrance'){ wall(o,0,1.6,0.7,'altar'); put({kind:'statue',x:o.x+1.5,y:o.y+1.5,w:0.9,d:0.9}); put({kind:'statue',x:o.x+o.w-1.5,y:o.y+1.5,w:0.9,d:0.9});   // the NAVE
        for(let y=o.y+3;y<o.y+o.h-2;y+=2){ put({kind:'pew',x:o.x+o.w/2-1.25,y:y+0.5,w:1.5,d:0.45}); put({kind:'pew',x:o.x+o.w/2+1.25,y:y+0.5,w:1.5,d:0.45}); }
        put({kind:'brazier',x:o.x+o.w/2-1.5,y:o.y+1.5,w:0.8,d:0.8}); put({kind:'brazier',x:o.x+o.w/2+1.5,y:o.y+1.5,w:0.8,d:0.8}); }
      if(ST && o.type==='lair'){ if(ST==='mine'){ scatter(o,'ore',2,0.8); wall(o,sides[1],1.3,0.9,'minecart'); scatter(o,'bones',2,0.6); }
        else if(ST==='sewer'){ scatter(o,'bones',4,0.6); scatter(o,'rubble',2,0.7); wall(o,sides[1],1,0.8,'chest'); }
        else { mid(o,'altar',1.3,0.6); wall(o,sides[1],0.9,0.9,'statue'); put({kind:'brazier',x:o.x+1.5,y:o.y+1.5,w:0.8,d:0.8}); put({kind:'brazier',x:o.x+o.w-1.5,y:o.y+o.h-1.5,w:0.8,d:0.8}); mid(o,'font',0.9,0.9); } }
      if(ST && o.type==='entrance' && ST!=='temple') scatter(o,'crate',ST==='mine'?2:1,0.8);
      // wall lights: torches (classic / temple), lanterns (mine), the odd lantern (sewer — mostly dark)
      const LK = !ST||ST==='temple' ? 'torch' : ST==='mine' ? 'lantern' : (r()<0.4?'lantern':null);
      if(LK) for(const s of sides.slice(0, o.w*o.h>30?2:1)) wall(o,s,0.3,0.3,LK,8);
    }
    // corridor torches + a little debris along the passages
    let n=0; for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++){ if(!isF(x,y) || allRooms.some(o=>x>=o.x&&x<o.x+o.w&&y>=o.y&&y<o.y+o.h)) continue;
      if(Rg && (x<Rg.x0-1||x>=Rg.x1+1||y<Rg.y0-1||y>=Rg.y1+1)) continue;   // Extend: only dress the new passages
      if(ST==='mine'||ST==='sewer'){ const hz=isF(x-1,y)||isF(x+1,y), vt=isF(x,y-1)||isF(x,y+1), h7=(x*7+y*13), wallS=!isF(x,y-1)?0:!isF(x+1,y)?1:!isF(x,y+1)?2:!isF(x-1,y)?3:-1;
        const onWall=(kind,sz)=>wallS>=0 && put({kind,x:x+0.5+(wallS===1?0.34:wallS===3?-0.34:0),y:y+0.5+(wallS===2?0.34:wallS===0?-0.34:0),w:sz,d:sz,face:wallS});
        if(ST==='mine'){ if(hz!==vt) put({kind:'rail',x:x+0.5,y:y+0.5,w:hz?1:0.6,d:hz?0.6:1,flat:1});   // rails along the drift
          if(h7%5===0 && hz && !vt && !isF(x,y-1) && !isF(x,y+1)) put({kind:'timber',x:x+0.5,y:y+0.5,w:0.25,d:1,flat:1});   // pit-prop frames across narrow drifts
          else if(h7%5===0 && vt && !hz && !isF(x-1,y) && !isF(x+1,y)) put({kind:'timber',x:x+0.5,y:y+0.5,w:1,d:0.25,flat:1});
          if(h7%23===0) onWall('lantern',0.3); else if(h7%53===0 && hz!==vt) put({kind:'minecart',x:x+0.5,y:y+0.5,w:hz?1.3:0.9,d:hz?0.9:1.3}); else if(r()<0.02) put({kind:'rubble',x:x+0.5,y:y+0.5,w:0.6,d:0.6}); }
        else { if(h7%17===0) onWall('pipe',0.4); else if(h7%41===0) onWall('lantern',0.3); else if(h7%29===0) put({kind:'drain',x:x+0.5,y:y+0.5,w:0.6,d:0.6,flat:1}); else if(r()<0.02) put({kind:r()<0.5?'rubble':'bones',x:x+0.5,y:y+0.5,w:0.6,d:0.6}); }
        continue; }
      if(((x*7+y*13)%23)===0){ const s=!isF(x,y-1)?0:!isF(x+1,y)?1:!isF(x,y+1)?2:!isF(x-1,y)?3:-1; if(s>=0 && put({kind:'torch',x:x+0.5+(s===1?0.34:s===3?-0.34:0),y:y+0.5+(s===2?0.34:s===0?-0.34:0),w:0.3,d:0.3,face:s})) n++; }
      else if(r()<0.02) put({kind:r()<0.5?'rubble':'bones',x:x+0.5,y:y+0.5,w:0.6,d:0.6}); }
    return F; }

  // DROPS to the level below: a well in a room, a trapdoor pit in a passage (dungeon) / a sinkhole (cave). link:'down'
  function drops(F, rooms, floor, W, H, r, kind, res, force, water){ res=res||1; const P=(p)=>force||r()<p; const cols=W/res, rows=H/res;
    const occ=new Set(); for(const f of F){ if(f.flat) continue; for(let y=Math.floor(f.y-f.d/2)-1;y<=Math.floor(f.y+f.d/2-0.01)+1;y++) for(let x=Math.floor(f.x-f.w/2)-1;x<=Math.floor(f.x+f.w/2-0.01)+1;x++) occ.add(x+','+y); }   // whole footprints + 1 square
    const cellFloor=(cx,cy)=>{ if(cx<1||cy<1||cx>=cols-1||cy>=rows-1) return false; for(let y=cy*res;y<cy*res+res;y++) for(let x=cx*res;x<cx*res+res;x++) if(!floor[y*W+x]||(water&&water[y*W+x])) return false; return true; };
    const inRoom=(x,y)=>rooms.some(o=>x>=o.x&&x<o.x+o.w&&y>=o.y&&y<o.y+o.h);
    const far=(x,y)=>F.every(f=>!f.link || Math.hypot(f.x-x-0.5,f.y-y-0.5)>5);
    const put=(it)=>{ const k=Math.floor(it.x)+','+Math.floor(it.y); if(occ.has(k)) return false; occ.add(k); F.push(it); return true; };
    if(kind==='dungeon'){
      if(P(0.55)){ const cand=rooms.filter(o=>o.type!=='entrance'&&o.type!=='lair'&&o.w*o.h>=12); for(let t=0;t<cand.length;t++){ const o=cand[Math.floor(r()*cand.length)], x=Math.floor(o.x+o.w/2), y=Math.floor(o.y+o.h/2); if(far(x,y) && put({kind:'well',x:x+0.5,y:y+0.5,w:0.9,d:0.9,link:'down'})) break; } }
      if(P(0.55) && !(force && F.some(f=>f.link==='down'))){ for(let t=0;t<200;t++){ const x=1+Math.floor(r()*(cols-2)), y=1+Math.floor(r()*(rows-2)); if(cellFloor(x,y)&&!inRoom(x,y)&&far(x,y)&&put({kind:'pit',x:x+0.5,y:y+0.5,w:0.9,d:0.9,link:'down'})) break; } } }
    else if(P(0.7)){ for(let t=0;t<300;t++){ const x=1+Math.floor(r()*(cols-2)), y=1+Math.floor(r()*(rows-2)); let open=true; for(let dy=-1;dy<=1&&open;dy++) for(let dx=-1;dx<=1;dx++) if(!cellFloor(x+dx,y+dy)){ open=false; break; }
        if(open&&far(x,y)&&put({kind:'sinkhole',x:x+0.5,y:y+0.5,w:1.4,d:1.4,link:'down'})) break; } } }
  // PAD a level with solid rock so every level of a stack keeps the same footprint when one of them is extended
  function pad(D, dir, E){ const cols=D.cols+(dir==='E'||dir==='W'?E:0), rows=D.rows+(dir==='N'||dir==='S'?E:0), ox=dir==='W'?E:0, oy=dir==='N'?E:0, res=D.res, W=cols*res, OW=D.cols*res;
    const floor=new Array(W*rows*res).fill(0), water=D.water?new Array(W*rows*res).fill(0):null;
    for(let y=0;y<D.rows*res;y++) for(let x=0;x<OW;x++){ const k=(y+oy*res)*W+x+ox*res; floor[k]=D.floor[y*OW+x]; if(water) water[k]=D.water[y*OW+x]; }
    const sh=(f)=>({...f,x:f.x+ox,y:f.y+oy}), rooms=D.rooms.map(o=>({...o,x:o.x+ox,y:o.y+oy})), doors=D.doors.map(d=>({...d,x1:d.x1+ox,x2:d.x2+ox,y1:d.y1+oy,y2:d.y2+oy}));
    if(D.kind==='cave'){ const o=caveOut(cols,rows,res,floor,water||new Array(W*rows*res).fill(0),D.features.map(sh)); o.sealed=shiftSeal(D.sealed,ox,oy); return o; }
    return { ...D, cols, rows, floor, water, walls:gridLoops(floor,W,rows), waterLoops:water?gridLoops(water,W,rows):[], doors, rooms, features:D.features.map(sh), sealed:shiftSeal(D.sealed,ox,oy) }; }
  // the landing below each way down: stairs arrive on the same square; a well lands in a pool, a pit/sinkhole on rubble
  function arrivalsFrom(D){ return D.features.filter(f=>f.link==='down').map(f=> f.kind==='stairs' ? {kind:'stairs',x:f.x,y:f.y,w:f.w,d:f.d,face:f.face}
      : f.kind==='well' ? {kind:'splash',x:f.x,y:f.y,w:1.2,d:1.2} : {kind:'rubble',x:f.x,y:f.y,w:1.1,d:1.1}); }

  /* ---------- CAVE: cellular-automata caverns on a 3×-finer sub-grid ---------- */
  const N4=[[1,0],[-1,0],[0,1],[0,-1]];
  // run the cave rule on the cells `mut(x,y)` allows to change (the rest — old cave on Extend — is fixed but still counts as neighbours)
  function caStep(m, W, H, mut, iters, floorOnly){ for(let it=0;it<iters;it++){ const n=m.slice(); for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++){ if(!mut(x,y)) continue;
      let rock=0; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) if(dx||dy) rock+= m[(y+dy)*W+x+dx]?0:1;
      let v = rock>=5 ? 0 : (rock<=3 ? 1 : m[y*W+x]); if(floorOnly && floorOnly(x,y) && m[y*W+x]) v=1; n[y*W+x]=v; } m=n; } return m; }
  function labels(m, W, H){ const lab=new Int32Array(W*H).fill(-1), size=[]; let id=0;
    for(let k=0;k<W*H;k++){ if(!m[k]||lab[k]>=0) continue; const st=[k]; lab[k]=id; let cnt=0; while(st.length){ const c=st.pop(); cnt++; const x=c%W,y=(c/W)|0; for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||!m[K]||lab[K]>=0) continue; lab[K]=id; st.push(K); } } size.push(cnt); id++; }
    return {lab,size}; }
  // carve a 3-wide tunnel from component `from` to the nearest cell of component `to` (BFS through rock)
  function tunnel(m, W, H, lab, from, to, block){ const prev=new Int32Array(W*H).fill(-2), q=[]; for(let k=0;k<W*H;k++) if(lab[k]===from){ prev[k]=-1; q.push(k); }
    let hit=-1; for(let h=0;h<q.length && hit<0;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<2||Y<2||X>=W-2||Y>=H-2||prev[K]!==-2||(block&&block[K]&&lab[K]!==to)) continue; prev[K]=k; if(lab[K]===to){ hit=K; break; } q.push(K); } }
    for(let k=hit;k>=0 && prev[k]!==-1;k=prev[k]){ const x=k%W, y=(k/W)|0; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){ const X=x+dx,Y=y+dy; if(X>1&&Y>1&&X<W-2&&Y<H-2) m[Y*W+X]=1; } } return hit>=0; }
  function pools(floor, water, W, H, r, n, inR){ const fl=[]; for(let k=0;k<W*H;k++) if(floor[k] && inR(k%W,(k/W)|0)) fl.push(k); if(!fl.length) return;
    for(let p=0;p<n;p++){ const s0=fl[Math.floor(r()*fl.length)], want=40+Math.floor(r()*70), q=[s0], seen=new Set([s0]);
      for(let h=0;h<q.length && seen.size<want;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of N4.slice().sort(()=>r()-0.5)){ const K=(y+dy)*W+x+dx; if(!floor[K]||seen.has(K)||!inR(K%W,(K/W)|0)) continue; let rockN=0; for(const [ex,ey] of N4) if(!floor[K+ey*W+ex]) rockN++; if(rockN) continue; seen.add(K); q.push(K); } }
      for(const k of seen) water[k]=1; } }
  // dressing (whole-square units) inside cell box R: a camp in the most open spot, glowing crystals + mushrooms by the walls, bones, rubble
  function caveDress(floor, water, cols, rows, res, r, R, prior, camp, style){ const W=cols*res; const CRY=style==='lava'?'obsidian':'crystals', MU=style==='ice'?'icespike':style==='lava'?'vent':'mushrooms'; if(style==='lava') camp=false;
    const cellFloor=(cx,cy)=>{ if(cx<0||cy<0||cx>=cols||cy>=rows) return false; for(let y=cy*res;y<cy*res+res;y++) for(let x=cx*res;x<cx*res+res;x++) if(!floor[y*W+x]||water[y*W+x]) return false; return true; };
    const open=(cx,cy)=>{ let n=0; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) if(cellFloor(cx+dx,cy+dy)) n++; return n; };
    const occ=new Set(), F=[];   // prior items (landings, old dressing) reserve their WHOLE footprint (+1 square round a landing)
    for(const f of (prior||[])){ const m=f.link?1:0; for(let y=Math.floor(f.y-f.d/2)-m;y<=Math.floor(f.y+f.d/2-0.01)+m;y++) for(let x=Math.floor(f.x-f.w/2)-m;x<=Math.floor(f.x+f.w/2-0.01)+m;x++) occ.add(x+','+y); }
    const nearLink=(x,y)=>(prior||[]).some(f=>f.link && Math.hypot(f.x-x-0.5,f.y-y-0.5)<4);
    const put=(it)=>{ const k=Math.floor(it.x)+','+Math.floor(it.y); if(occ.has(k)||!cellFloor(Math.floor(it.x),Math.floor(it.y))) return false; occ.add(k); F.push(it); return true; };
    const inR=(x,y)=>x>=R.x0&&y>=R.y0&&x<R.x1&&y<R.y1;
    if(camp){ let c=null; for(let y=Math.max(1,R.y0);y<Math.min(rows-1,R.y1);y++) for(let x=Math.max(1,R.x0);x<Math.min(cols-1,R.x1);x++){ if(open(x,y)===9 && !nearLink(x,y) && (c==null || r()<0.08)) c={x,y}; }
      if(c){ put({kind:'campfire',x:c.x+0.5,y:c.y+0.5,w:0.9,d:0.9}); for(const [dx,dy,w,d] of [[-1,0,0.6,1.5],[1,0,0.6,1.5],[0,1,1.5,0.6]]) if(cellFloor(c.x+dx,c.y+dy)) put({kind:'bedroll',x:c.x+dx+0.5,y:c.y+dy+0.5,w,d}); put({kind:'chest',x:c.x+0.5,y:c.y-0.5,w:0.9,d:0.6}); } }
    const edgeCells=[]; for(let y=R.y0;y<R.y1;y++) for(let x=R.x0;x<R.x1;x++) if(inR(x,y) && cellFloor(x,y) && open(x,y)<8) edgeCells.push({x,y});
    const pick=()=>edgeCells.splice(Math.floor(r()*edgeCells.length),1)[0], area=(R.x1-R.x0)*(R.y1-R.y0), k=Math.max(0.35,area/720);
    const nCry=Math.round((3+Math.floor(r()*4))*k), nMu=Math.round((3+Math.floor(r()*4))*k);
    for(let i=0;i<nCry && edgeCells.length;i++){ const c=pick(); put({kind:CRY,x:c.x+0.5,y:c.y+0.5,w:0.7,d:0.7}); }
    for(let i=0;i<nMu && edgeCells.length;i++){ const c=pick(); put({kind:MU,x:c.x+0.5,y:c.y+0.5,w:0.6,d:0.6}); }
    for(let i=0;i<Math.round(3*k) && edgeCells.length;i++){ const c=pick(); put({kind:'bones',x:c.x+0.5,y:c.y+0.5,w:0.6,d:0.6}); }
    for(let i=0;i<Math.round(5*k) && edgeCells.length;i++){ const c=pick(); put({kind:'rubble',x:c.x+0.5,y:c.y+0.5,w:0.8,d:0.8}); }
    return F; }
  function lavaLights(water, cols, rows, res, R){ const W=cols*res, H=rows*res, out=[], lab=new Int32Array(W*H).fill(-1); let id=0;
    for(let k=0;k<W*H;k++){ if(!water[k]||lab[k]>=0) continue; const st=[k]; lab[k]=id; let sx=0, sy=0, n=0; while(st.length){ const c=st.pop(), x=c%W, y=(c/W)|0; sx+=x; sy+=y; n++;
        for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||!water[K]||lab[K]>=0) continue; lab[K]=id; st.push(K); } }
      const cx=(sx/n+0.5)/res, cy=(sy/n+0.5)/res; id++; if(R && !(cx>=R.x0&&cx<R.x1&&cy>=R.y0&&cy<R.y1)) continue; out.push({kind:'lavalight', x:+cx.toFixed(3), y:+cy.toFixed(3), w:1, d:1, flat:1}); }
    return out; }
  function caveOut(cols, rows, res, floor, water, features){ const W=cols*res, H=rows*res;
    const walls=msLoops(blur(floor,W,H,1),W,H,0.5).map(l=>l.map(p=>({x:p.x/res,y:p.y/res})));
    const waterLoops=msLoops(blur(water,W,H,1),W,H,0.5).map(l=>l.map(p=>({x:p.x/res,y:p.y/res})));
    return { kind:'cave', cols, rows, res, floor, water, walls, waterLoops, doors:[], rooms:[], features }; }
  function cave(cols, rows, seed, arrivals, style){ arrivals=arrivals||[];
    const res=3, W=cols*res, H=rows*res; let floor, tries=0, s=seed;
    const fixed=new Uint8Array(W*H); for(const a of arrivals){ const cx=Math.floor(a.x*res), cy=Math.floor(a.y*res), R=Math.max(5,Math.ceil(Math.max(a.w,a.d)*res/2)+3);   // a guaranteed open chamber at every landing
      for(let y=cy-R;y<=cy+R;y++) for(let x=cx-R;x<=cx+R;x++) if(x>=2&&y>=2&&x<W-2&&y<H-2&&Math.hypot(x-cx,y-cy)<=R) fixed[y*W+x]=1; }
    for(;;){ const r=rng32(s); let m=new Array(W*H); for(let y=0;y<H;y++) for(let x=0;x<W;x++) m[y*W+x] = fixed[y*W+x] ? 1 : (x<2||y<2||x>=W-2||y>=H-2) ? 0 : (r()<0.53?1:0);   // 1 = floor
      m=caStep(m,W,H,(x,y)=>x>=2&&y>=2&&x<W-2&&y<H-2&&!fixed[y*W+x],6);
      let {lab,size}=labels(m,W,H); let best=0; size.forEach((n,i)=>{ if(n>size[best]) best=i; });   // keep the largest open region
      if(arrivals.length){ const ak=(a)=>Math.floor(a.y*res)*W+Math.floor(a.x*res); best=lab[ak(arrivals[0])];   // …or, below another level, the one holding the landings
        for(const a of arrivals.slice(1)){ const id=lab[ak(a)]; if(id!==best && id>=0){ tunnel(m,W,H,lab,id,best); ({lab,size}=labels(m,W,H)); best=lab[ak(arrivals[0])]; } } }
      for(let k=0;k<W*H;k++) m[k] = lab[k]===best ? 1 : 0;
      const frac=(size[best]||0)/(W*H); floor=m; if((frac>0.34 && frac<0.62) || ++tries>10) break; s=(s*48271+11)>>>0; }
    const r=rng32(seed^0x5bd1e995);
    // an entrance tunnel from the cave to the nearest map edge (the top level only — deeper levels are reached from above)
    if(!arrivals.length){ let bx=0,by=0,bd=1e9; for(let y=0;y<H;y++) for(let x=0;x<W;x++){ if(!floor[y*W+x]) continue; const d=Math.min(x,y,W-1-x,H-1-y); if(d<bd){ bd=d; bx=x; by=y; } }
      const dx = bx===Math.min(bx,by,W-1-bx,H-1-by)?-1 : (W-1-bx)===bd?1:0, dy = dx?0:(by===bd?-1:1);
      for(let t=0;t<=bd+1;t++){ const x=bx+dx*t, y=by+dy*t; for(let o=-1;o<=1;o++){ const X=x+(dy?o:0), Y=y+(dx?o:0); if(X>=0&&Y>=0&&X<W&&Y<H) floor[Y*W+X]=1; } } }
    const water=new Array(W*H).fill(0); pools(floor,water,W,H,r,1+Math.floor(r()*2),()=>true);
    const arr=arrivals.map(a=>({...a,link:'up'})); const F=arr.concat(caveDress(floor,water,cols,rows,res,r,{x0:0,y0:0,x1:cols,y1:rows},arr,true,style));
    drops(F,[],floor,W,H,r,'cave',res,false,style==='lava'?water:null);
    if(style==='lava') F.push(...lavaLights(water,cols,rows,res,null));
    const o=caveOut(cols,rows,res,floor,water,F); if(style) o.style=style; return o; }
  // EXTEND a cave: the old cave is copied untouched; the new strip grows with the same rule (the old edge band may only
  // OPEN into it), stray pockets tunnel back to the main cave, and new pools / dressing go only in the new strip.
  function caveExtend(D, cols, rows, ox, oy, R, seed){
    const res=D.res, W=cols*res, H=rows*res, OW=D.cols*res, OH=D.rows*res, r=rng32(seed);
    const floor=new Array(W*H).fill(0), water=new Array(W*H).fill(0);
    for(let y=0;y<OH;y++) for(let x=0;x<OW;x++){ const k=(y+oy*res)*W+x+ox*res; floor[k]=D.floor[y*OW+x]; water[k]=D.water?D.water[y*OW+x]:0; }
    const sx0=R.x0*res, sy0=R.y0*res, sx1=R.x1*res, sy1=R.y1*res, band=4;
    const inNew=(x,y)=>x>=sx0&&y>=sy0&&x<sx1&&y<sy1, nearSeam=(x,y)=>x>=sx0-band&&y>=sy0-band&&x<sx1+band&&y<sy1+band;
    const inside=(x,y)=>x>=2&&y>=2&&x<W-2&&y<H-2;
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const k=y*W+x; if(inNew(x,y)) floor[k] = inside(x,y) && r()<0.53 ? 1 : 0;
      else if(nearSeam(x,y) && inside(x,y) && !floor[k] && r()<0.5) floor[k]=1; }   // old ROCK by the seam is re-rolled too → no straight ridge along the old map edge (old floor never changes)
    const sealed=shiftSeal(D.sealed,ox,oy), SB=sealed.length?sealMask(sealed,cols,rows,res,1):null;
    if(SB) for(let k=0;k<W*H;k++) if(SB[k] && inNew(k%W,(k/W)|0)) floor[k]=0;
    let m=caStep(floor,W,H,(x,y)=>inside(x,y)&&nearSeam(x,y)&&!water[y*W+x]&&!(SB&&SB[y*W+x]),6,(x,y)=>!inNew(x,y));   // old cells: floor stays floor; sealed dead ends untouched
    // everything must hang off the ORIGINAL cave: tunnel big pockets back, drop small ones
    for(let pass=0;pass<6;pass++){ const {lab,size}=labels(m,W,H); let main=-1;
      for(let y=0;y<H && main<0;y++) for(let x=0;x<W;x++){ if(!inNew(x,y) && D.floor[(y-oy*res)*OW+(x-ox*res)] && m[y*W+x]){ main=lab[y*W+x]; break; } }
      let changed=false; for(let id=0;id<size.length;id++){ if(id===main) continue; if(size[id]>=24){ if(tunnel(m,W,H,lab,id,main,SB)){ changed=true; break; } } else { for(let k=0;k<W*H;k++) if(lab[k]===id) m[k]=0; } }
      if(!changed) break; }
    { const {lab}=labels(m,W,H); let main=-1; for(let k=0;k<W*H && main<0;k++){ const x=k%W,y=(k/W)|0; if(m[k]&&!inNew(x,y)&&D.floor[(y-oy*res)*OW+(x-ox*res)]) main=lab[k]; }
      for(let k=0;k<W*H;k++) if(m[k] && lab[k]!==main){ const x=k%W,y=(k/W)|0; if(inNew(x,y)||!D.floor[(y-oy*res)*OW+(x-ox*res)]) m[k]=0; } }   // final sweep: no stray pockets
    // no new cave reached the strip? force one tunnel in from the old cave
    let any=false; for(let y=sy0;y<sy1&&!any;y++) for(let x=sx0;x<sx1;x++) if(m[y*W+x]){ any=true; break; }
    if(!any){ const cxs=(sx0+sx1)>>1, cys=(sy0+sy1)>>1; for(let dy=-4;dy<=4;dy++) for(let dx=-4;dx<=4;dx++) if(inside(cxs+dx,cys+dy)) m[(cys+dy)*W+cxs+dx]=1; const {lab}=labels(m,W,H); let main=-1; for(let k=0;k<W*H && main<0;k++) if(m[k]&&!inNew(k%W,(k/W)|0)) main=lab[k]; tunnel(m,W,H,lab,lab[cys*W+cxs],main); }
    pools(m,water,W,H,r,r()<0.6?1:0,(x,y)=>inNew(x,y));
    const moved=D.features.map(f=>({...f,x:f.x+ox,y:f.y+oy}));
    const add=caveDress(m,water,cols,rows,res,r,R,moved, r()<0.35, D.style); if(D.style==='lava') add.push(...lavaLights(water,cols,rows,res,R));
    const out=caveOut(cols,rows,res,m,water, moved.concat(add)); out.sealed=sealed; if(D.style) out.style=D.style; return out; }

  // EXTEND any layout by E squares toward dir (N/S/E/W). Old content keeps its place (shifted when growing W/N).
  function extend(D, dir, E, seed){ E=Math.max(6,E|0||12);
    const cols=D.cols+(dir==='E'||dir==='W'?E:0), rows=D.rows+(dir==='N'||dir==='S'?E:0), ox=dir==='W'?E:0, oy=dir==='N'?E:0;
    const R = dir==='E'?{x0:D.cols,y0:0,x1:cols,y1:rows} : dir==='W'?{x0:0,y0:0,x1:E,y1:rows} : dir==='S'?{x0:0,y0:D.rows,x1:cols,y1:rows} : {x0:0,y0:0,x1:cols,y1:E};
    if(D.kind==='cave') return caveExtend(D,cols,rows,ox,oy,R,seed);
    const floor=new Array(cols*rows).fill(0); for(let y=0;y<D.rows;y++) for(let x=0;x<D.cols;x++) floor[(y+oy)*cols+x+ox]=D.floor[y*D.cols+x];
    let water=null; if(D.water){ water=new Array(cols*rows).fill(0); for(let y=0;y<D.rows;y++) for(let x=0;x<D.cols;x++) water[(y+oy)*cols+x+ox]=D.water[y*D.cols+x]; }
    const base={ floor, water, style:D.style, rooms:D.rooms.map(o=>({...o,x:o.x+ox,y:o.y+oy})), doors:D.doors.map(d=>({...d,x1:d.x1+ox,x2:d.x2+ox,y1:d.y1+oy,y2:d.y2+oy})),
      features:D.features.map(f=>({...f,x:f.x+ox,y:f.y+oy})), sealed:shiftSeal(D.sealed,ox,oy), region:{x0:Math.max(2,R.x0), y0:Math.max(2,R.y0), x1:Math.min(cols-2,R.x1), y1:Math.min(rows-2,R.y1)} };
    let best=null; for(let t=0;t<6;t++){ const g=dungeon(cols,rows,(seed+t*7919)>>>0,base); if(!best||g.newRooms>best.newRooms) best=g; if(g.newRooms>=2) break; }
    return best; }

  /* DEAD END: extend by E squares toward dir, but add only ONE winding passage from the nearest room / cavern on that side
     into the new strip, ending in a small chamber; the rest of the strip stays solid rock. end = 'none'|'stairs'|'well'|'pit'|'treasure'.
     The passage + chamber are SEALED: later extensions never route through or beside them. */
  function deadEnd(D, dir, E, seed, end){ E=Math.max(6,E|0||12); end=end||'none';
    const cols=D.cols+(dir==='E'||dir==='W'?E:0), rows=D.rows+(dir==='N'||dir==='S'?E:0), ox=dir==='W'?E:0, oy=dir==='N'?E:0, r=rng32(seed>>>0||1);
    const R = dir==='E'?{x0:D.cols,y0:0,x1:cols,y1:rows} : dir==='W'?{x0:0,y0:0,x1:E,y1:rows} : dir==='S'?{x0:0,y0:D.rows,x1:cols,y1:rows} : {x0:0,y0:0,x1:cols,y1:E};
    const toward=(x,y)=> dir==='E'?x : dir==='W'?-x : dir==='S'?y : -y;
    // the end chamber sits 35–55% into the strip (never at its far edge → the next extension can't touch it)
    const depth=Math.floor(E*(0.35+0.2*r())), span=(dir==='E'||dir==='W')?rows:cols, lat=3+Math.floor(r()*Math.max(1,span-8));
    const tx = dir==='E'?R.x0+depth : dir==='W'?R.x1-1-depth : lat, ty = dir==='S'?R.y0+depth : dir==='N'?R.y1-1-depth : lat;
    const sealed=shiftSeal(D.sealed,ox,oy), F=D.features.map(f=>({...f,x:f.x+ox,y:f.y+oy}));
    const endFeature=(cx,cy,chW,chH)=>{ const o=[];   // cx,cy = chamber centre (squares)
      if(end==='stairs'){ const alongX=dir==='N'||dir==='S'; o.push({kind:'stairs', x:cx+(dir==='E'?chW/2-0.5:dir==='W'?-chW/2+0.5:0), y:cy+(dir==='S'?chH/2-0.5:dir==='N'?-chH/2+0.5:0), w:alongX?1.7:0.9, d:alongX?0.9:1.7, face:({E:1,W:3,S:2,N:0})[dir], link:'down'}); }
      else if(end==='well') o.push({kind:'well',x:cx,y:cy,w:0.9,d:0.9,link:'down'});
      else if(end==='pit') o.push({kind:D.kind==='cave'?'sinkhole':'pit',x:cx,y:cy,w:D.kind==='cave'?1.4:0.9,d:D.kind==='cave'?1.4:0.9,link:'down'});
      else if(end==='treasure'){ o.push({kind:'chest',x:cx,y:cy,w:0.9,d:0.6}); o.push({kind:D.kind==='cave'?'crystals':'sarcophagus',x:cx+(dir==='E'||dir==='W'?0:1),y:cy+(dir==='E'||dir==='W'?1:0),w:D.kind==='cave'?0.7:0.8,d:D.kind==='cave'?0.7:1.6}); o.push({kind:'bones',x:cx-0.9,y:cy-0.9,w:0.6,d:0.6}); }
      else o.push({kind:'bones',x:cx,y:cy,w:0.6,d:0.6},{kind:'rubble',x:cx+0.9,y:cy+0.6,w:0.8,d:0.8});
      return o; };
    if(D.kind==='cave'){ const res=D.res, W=cols*res, H=rows*res, OW=D.cols*res, floor=new Array(W*H).fill(0), water=new Array(W*H).fill(0);
      for(let y=0;y<D.rows*res;y++) for(let x=0;x<OW;x++){ const k=(y+oy*res)*W+x+ox*res; floor[k]=D.floor[y*OW+x]; water[k]=D.water?D.water[y*OW+x]:0; }
      const SB=sealed.length?sealMask(sealed,cols,rows,res,1):null;
      let sx=-1, sy=-1, best=-1e9; for(let y=2;y<H-2;y++) for(let x=2;x<W-2;x++){ const k=y*W+x; if(!floor[k]||water[k]||(SB&&SB[k])) continue; const t=toward(x,y)+ (r()-0.5)*2; if(t>best){ best=t; sx=x; sy=y; } }
      const gx=tx*res+1, gy=ty*res+1, carved=new Set(); const dig=(x,y,rad)=>{ for(let dy=-rad;dy<=rad;dy++) for(let dx=-rad;dx<=rad;dx++){ const X=x+dx,Y=y+dy; if(X>1&&Y>1&&X<W-2&&Y<H-2&&dx*dx+dy*dy<=rad*rad+1){ floor[Y*W+X]=1; carved.add(Math.floor(X/res)+','+Math.floor(Y/res)); } } };
      let x=sx, y=sy; for(let step=0; step<4000 && Math.hypot(gx-x,gy-y)>2; step++){ const ang=Math.atan2(gy-y,gx-x)+(r()-0.5)*1.6; x=Math.round(x+Math.cos(ang)); y=Math.round(y+Math.sin(ang)); x=Math.max(3,Math.min(W-4,x)); y=Math.max(3,Math.min(H-4,y)); dig(x,y,1); }
      dig(gx,gy,4);   // the end chamber
      for(const k of carved){ const [cx,cy]=k.split(',').map(Number); if(!(cx>=R.x0&&cx<R.x1&&cy>=R.y0&&cy<R.y1)) continue; sealed.push([cx,cy]); }
      const o=caveOut(cols,rows,res,floor,water,F.concat(endFeature(tx+0.5,ty+0.5,3,3))); o.sealed=sealed; o.deadEnd=true; return o; }
    // dungeon: door on the nearest room's side facing the strip, a noisy A* passage, a small end chamber
    const W=cols, H=rows, floor=new Array(W*H).fill(0); for(let y=0;y<D.rows;y++) for(let x=0;x<D.cols;x++) floor[(y+oy)*W+x+ox]=D.floor[y*D.cols+x];
    let dwater=null; if(D.water){ dwater=new Array(W*H).fill(0); for(let y=0;y<D.rows;y++) for(let x=0;x<D.cols;x++) dwater[(y+oy)*W+x+ox]=D.water[y*D.cols+x]; }
    const rooms=D.rooms.map(o=>({...o,x:o.x+ox,y:o.y+oy})), doors=D.doors.map(d=>({...d,x1:d.x1+ox,x2:d.x2+ox,y1:d.y1+oy,y2:d.y2+oy}));
    const roomAt=new Int16Array(W*H).fill(-1); rooms.forEach((o,i)=>{ for(let y=o.y;y<o.y+o.h;y++) for(let x=o.x;x<o.x+o.w;x++) roomAt[y*W+x]=i; });
    const SEAL=sealed.length?sealMask(sealed,W,H,1,1):null;
    const cand=rooms.map((o,i)=>i).filter(i=>rooms[i].type!=='deadend').sort((a,b)=>toward(rooms[b].x+rooms[b].w/2,rooms[b].y+rooms[b].h/2)-toward(rooms[a].x+rooms[a].w/2,rooms[a].y+rooms[a].h/2));
    const cw=3+Math.floor(r()*2), ch=3; let chx=Math.max(2,Math.min(W-2-cw, tx-Math.floor(cw/2))), chy=Math.max(2,Math.min(H-2-ch, ty-1));
    for(const ai of cand.slice(0,3)){ const A=rooms[ai], side=({E:1,W:3,S:2,N:0})[dir], span=side===0||side===2?A.w:A.h; const t=span>=3?1+Math.floor(r()*(span-2)):Math.floor(r()*span);
      const ix=side===1?A.x+A.w-1:side===3?A.x:A.x+t, iy=side===2?A.y+A.h-1:side===0?A.y:A.y+t, sx=ix+(side===1?1:side===3?-1:0), sy=iy+(side===2?1:side===0?-1:0);
      if(sx<1||sy<1||sx>=W-1||sy>=H-1||(SEAL&&SEAL[sy*W+sx])) continue;
      // goal: the chamber cell nearest the start; noisy costs make the passage wind
      const inCh=(x,y)=>x>=chx&&x<chx+cw&&y>=chy&&y<chy+ch, noise=new Float32Array(W*H); for(let k=0;k<W*H;k++) noise[k]=r()*1.6;
      const K=(x,y)=>y*W+x, open=[[0,sx,sy]], gs=new Map([[K(sx,sy),0]]), prev=new Map(); let goal=-1;
      const nearFloor=(x,y)=>{ for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy; if(floor[Y*W+X]&&!(X===sx&&Y===sy)&&roomAt[Y*W+X]!==ai) return true; } return false; };
      while(open.length){ open.sort((a,b)=>a[0]-b[0]); const [,x,y]=open.shift(); if(inCh(x,y)){ goal=K(x,y); break; }
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy; if(X<2||Y<2||X>=W-2||Y>=H-2) continue; const k=K(X,Y);
          if(roomAt[k]>=0 || (floor[k]&&!inCh(X,Y)) || (SEAL&&SEAL[k]) ) continue; if(!inCh(X,Y) && nearFloor(X,Y) && Math.abs(X-sx)+Math.abs(Y-sy)>1) continue;   // stays its own passage — never merges into others
          const ng=gs.get(K(x,y))+1+noise[k]; if(ng<(gs.get(k)??1e9)){ gs.set(k,ng); prev.set(k,K(x,y)); open.push([ng+Math.abs(X-(chx+cw/2))+Math.abs(Y-(chy+1)),X,Y]); } } }
      if(goal<0) continue;
      for(let y=chy;y<chy+ch;y++) for(let x=chx;x<chx+cw;x++){ floor[y*W+x]=1; sealed.push([x,y]); }
      for(let k=goal;k!=null;k=prev.get(k)){ floor[k]=1; sealed.push([k%W,(k/W)|0]); }
      if(side===0) doors.push({x1:ix,y1:iy,x2:ix+1,y2:iy,open:r()<0.3}); else if(side===2) doors.push({x1:ix,y1:iy+1,x2:ix+1,y2:iy+1,open:r()<0.3});
      else if(side===3) doors.push({x1:ix,y1:iy,x2:ix,y2:iy+1,open:r()<0.3}); else doors.push({x1:ix+1,y1:iy,x2:ix+1,y2:iy+1,open:r()<0.3});
      rooms.push({x:chx,y:chy,w:cw,h:ch,type:'deadend'});
      const path=[]; for(let k=goal;k!=null;k=prev.get(k)) path.push(k); const mid=path[Math.floor(path.length/2)], mx=mid%W, my=(mid/W)|0;   // one torch half way along
      const fs2=!floor[(my-1)*W+mx]?0:!floor[my*W+mx+1]?1:!floor[(my+1)*W+mx]?2:!floor[my*W+mx-1]?3:-1;
      if(fs2>=0) F.push({kind:'torch',x:mx+0.5+(fs2===1?0.34:fs2===3?-0.34:0),y:my+0.5+(fs2===2?0.34:fs2===0?-0.34:0),w:0.3,d:0.3,face:fs2});
      const o2={ kind:'dungeon', cols, rows, res:1, floor, water:dwater, walls:gridLoops(floor,W,H), waterLoops:dwater?gridLoops(dwater,W,H):[], doors, rooms, features:F.concat(endFeature(chx+cw/2,chy+ch/2,cw,ch)), sealed, newRooms:0, deadEnd:true }; if(D.style) o2.style=D.style; return o2; }
    // no room could reach the strip: just grow the map with rock
    const o=pad(D,dir,E); o.deadEnd=false; return o; }
  // RETROFIT a landing onto an EXISTING level (a new way down was added above it): open the footprint (+1 square) and dig
  // the shortest passage from there to the level's nearest open floor; the landing arrives with link:'up'.
  function addArrival(L, a){ const res=L.res, W=L.cols*res, H=L.rows*res, floor=L.floor.slice(), water=L.water?L.water.slice():null;
    const x0=Math.max(1,Math.floor(a.x-a.w/2)-1), x1=Math.min(L.cols-2,Math.floor(a.x+a.w/2-0.01)+1), y0=Math.max(1,Math.floor(a.y-a.d/2)-1), y1=Math.min(L.rows-2,Math.floor(a.y+a.d/2-0.01)+1);
    const pre=floor.slice(), mine=new Uint8Array(W*H);
    for(let y=y0*res;y<(y1+1)*res;y++) for(let x=x0*res;x<(x1+1)*res;x++){ floor[y*W+x]=1; mine[y*W+x]=1; if(water) water[y*W+x]=0; }
    // shortest dig from the opened area to the pre-existing floor
    const prev=new Int32Array(W*H).fill(-2), q=[]; for(let k=0;k<W*H;k++) if(mine[k]){ prev[k]=-1; q.push(k); } let hit=-1;
    if(!q.some(k=>{ const x=k%W,y=(k/W)|0; return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>pre[(y+dy)*W+x+dx]&&!mine[(y+dy)*W+x+dx]); }))
      for(let h=0;h<q.length&&hit<0;h++){ const k=q[h],x=k%W,y=(k/W)|0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<res||Y<res||X>=W-res||Y>=H-res||prev[K]!==-2) continue; prev[K]=k; if(pre[K]){ hit=K; break; } q.push(K); } }
    for(let k=hit;k>=0&&prev[k]!==-1;k=prev[k]){ const x=k%W,y=(k/W)|0; for(let dy=0;dy<res;dy++) for(let dx=0;dx<res;dx++){ const X=x+dx-(res>1?1:0), Y=y+dy-(res>1?1:0); if(X>0&&Y>0&&X<W-1&&Y<H-1) floor[Y*W+X]=1; } }
    const features=L.features.filter(f=>f.link || !(Math.abs(f.x-a.x)<(f.w+a.w)/2+0.5 && Math.abs(f.y-a.y)<(f.d+a.d)/2+0.5)).concat([{...a, link:'up'}]);
    if(L.kind==='cave'){ const o=caveOut(L.cols,L.rows,res,floor,water||new Array(W*H).fill(0),features); o.sealed=L.sealed||[]; return {...L, ...o}; }
    return { ...L, floor, water, walls:gridLoops(floor,W,H), waterLoops:water?gridLoops(water,W,H):[], features, rooms:L.rooms.concat([{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1,type:'landing'}]) }; }

  /* ---------- 🔢 ROOM KEY (for the GM): stable numbers + a written description of every room / cavern ----------
     Numbers are STORED on the layout (dungeon: room.n · cave: D.chambers=[{x,y,n}] in squares) so they never change
     when the map is extended — new rooms / caverns just take the next numbers. New ones are numbered by walking
     distance from the way in (entrance room / landing / cave mouth). */
  const FAR=1e9;
  function walkDist(D, from){ const res=D.res||1, W=D.cols*res, H=D.rows*res, dist=new Int32Array(W*H).fill(-1), q=[];
    for(const k of from) if(k>=0 && k<W*H && D.floor[k] && dist[k]<0){ dist[k]=0; q.push(k); }
    for(let h=0;h<q.length;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||dist[K]>=0||!D.floor[K]) continue; dist[K]=dist[k]+1; q.push(K); } }
    return dist; }
  function keyStart(D){ const res=D.res||1, W=D.cols*res, H=D.rows*res, s=[];
    if(D.kind==='dungeon'){ const e=D.rooms.find(o=>o.type==='entrance') || D.rooms.slice().sort((a,b)=>(a.n||FAR)-(b.n||FAR))[0];
      if(e){ for(let y=e.y;y<e.y+e.h;y++) for(let x=e.x;x<e.x+e.w;x++) s.push(y*W+x); return s; } }
    const up=D.features.filter(f=>f.link==='up'); if(up.length){ for(const f of up) s.push(Math.floor(f.y*res)*W+Math.floor(f.x*res)); return s; }
    for(let x=0;x<W;x++) s.push(x,(H-1)*W+x); for(let y=0;y<H;y++) s.push(y*W,y*W+W-1);   // cave mouth: floor on the map edge
    return s; }
  function numberKey(D){ if(!D||!D.floor) return D; const res=D.res||1, W=D.cols*res, H=D.rows*res;
    let dist=null; const dAt=(x,y)=>{ if(!dist){ dist=walkDist(D,keyStart(D)); if(!dist.some(v=>v>=0)) dist=walkDist(D,[D.floor.indexOf(1)]); } const v=dist[Math.floor(y*res)*W+Math.floor(x*res)]; return v<0?FAR:v; };
    if(D.kind==='dungeon'){ let max=0; for(const o of D.rooms) if(o.n>max) max=o.n;
      const todo=D.rooms.filter(o=>!o.n); if(!todo.length) return D;
      const dRoom=(o)=>{ let m=FAR; for(let y=o.y;y<o.y+o.h;y++) for(let x=o.x;x<o.x+o.w;x++){ const v=dAt(x+0.5,y+0.5); if(v<m) m=v; } return m; };
      todo.map(o=>[o,dRoom(o)]).sort((a,b)=>(a[1]-b[1])||(a[0].y-b[0].y)||(a[0].x-b[0].x)).forEach(([o])=>{ o.n=++max; });
      return D; }
    // cave: chamber centres = the most open spots (distance-to-rock peaks) at least SP squares apart; old centres are kept
    const dt=new Int32Array(W*H).fill(-1), q=[]; for(let k=0;k<W*H;k++) if(!D.floor[k]){ dt[k]=0; q.push(k); }
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const k=y*W+x; if((x===0||y===0||x===W-1||y===H-1) && D.floor[k] && dt[k]<0){ dt[k]=1; q.push(k); } }   // the map edge counts as rock
    for(let h=0;h<q.length;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||dt[K]>=0) continue; dt[K]=dt[k]+1; q.push(K); } }
    const SP=6, ch=(D.chambers||[]).filter(c=>D.floor[Math.floor(c.y*res)*W+Math.floor(c.x*res)]).map(c=>({...c}));
    const cand=[]; for(let k=0;k<W*H;k++) if(dt[k]>=3) cand.push(k); cand.sort((a,b)=>(dt[b]-dt[a])||(a-b));
    if(!cand.length && !ch.length){ let bk=-1; for(let k=0;k<W*H;k++) if(D.floor[k] && (bk<0||dt[k]>dt[bk])) bk=k; if(bk>=0) cand.push(bk); }
    const fresh=[]; for(const k of cand){ const x=+((k%W+0.5)/res).toFixed(3), y=+((((k/W)|0)+0.5)/res).toFixed(3);
      if(ch.some(c=>Math.hypot(c.x-x,c.y-y)<SP) || fresh.some(c=>Math.hypot(c.x-x,c.y-y)<SP)) continue; fresh.push({x,y}); }
    let max=0; for(const c of ch) if(c.n>max) max=c.n;
    fresh.map(c=>[c,dAt(c.x,c.y)]).sort((a,b)=>(a[1]-b[1])||(a[0].y-b[0].y)||(a[0].x-b[0].x)).forEach(([c])=>{ c.n=++max; });
    D.chambers=ch.concat(fresh); return D; }
  const shiftCh=(D,ox,oy)=>(D.chambers||[]).map(c=>({...c,x:c.x+ox,y:c.y+oy}));
  const carryKey=(out,prev,ox,oy)=>{ if(out && prev && out.kind==='cave' && prev.chambers && out.chambers===undefined) out.chambers=shiftCh(prev,ox||0,oy||0); if(out && prev && prev.style && !out.style) out.style=prev.style; return out; };
  const offsetOf=(dir,E)=>({ox:dir==='W'?E:0, oy:dir==='N'?E:0});

  // words for the written key
  const KN={ sarcophagus:['sarcophagus','sarcophagi'], bed:['bed','beds'], chest:['chest','chests'], crate:['crate','crates'], barrel:['barrel','barrels'],
    bookshelf:['bookshelf','bookshelves'], table:['table','tables'], altar:['altar','altars'], statue:['statue','statues'], bones:['pile of bones','piles of bones'],
    rubble:['heap of rubble','heaps of rubble'], weaponrack:['weapon rack','weapon racks'], fireplace:['fireplace','fireplaces'], cauldron:['cauldron','cauldrons'],
    candles:['stand of candles','stands of candles'], brazier:['brazier','braziers'], torch:['wall torch','wall torches'], crystals:['cluster of glowing crystals','clusters of glowing crystals'],
    mushrooms:['patch of glowing mushrooms','patches of glowing mushrooms'], campfire:['campfire','campfires'], bedroll:['bedroll','bedrolls'],
    minecart:['mine cart','mine carts'], ore:['heap of ore','heaps of ore'], lantern:['lantern','lanterns'], toolrack:['rack of mining tools','racks of mining tools'],
    powder:['keg of blasting powder','kegs of blasting powder'], drain:['floor drain','floor drains'], pipe:['outflow pipe','outflow pipes'], valve:['great valve wheel','great valve wheels'],
    font:['stone font','stone fonts'], icespike:['cluster of ice spikes','clusters of ice spikes'], vent:['steaming vent','steaming vents'], obsidian:['obsidian outcrop','obsidian outcrops'],
    officedesk:['desk','desks'], conftable:['table with chairs','tables with chairs'], cellbars:['wall of cell bars','walls of cell bars'], lockers:['bank of lockers','banks of lockers'], labbench:['lab bench','lab benches'],
    fumehood:['fume hood','fume hoods'], tank:['specimen tank','specimen tanks'], serverrack:['server rack','server racks'], plant:['potted plant','potted plants'], sofa:['sofa','sofas'], bench:['bench','benches'], fridge:['fridge','fridges'],
    pew:['pew','pews'], desk:['desk','desks'], counter:['counter','counters'], shelf:['shelf','shelves'], wardrobe:['wardrobe','wardrobes'], rug:['rug','rugs'], stairs:['flight of stairs','flights of stairs'] };   // (+ building furniture, for the town key)
  const LIGHTK=new Set(['fireplace','torch','brazier','campfire','candles','crystals','mushrooms','lantern']), SKIPK=new Set(['rail','timber','lavalight']);
  const NUMW=['no','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
  const art=(s)=>(/^[aeiou]/i.test(s)?'an ':'a ')+s, cap=(s)=>s.charAt(0).toUpperCase()+s.slice(1);
  const cnt=(n,k)=>{ const p=KN[k]||[k,k+'s']; return n===1?art(p[0]):(NUMW[n]||n)+' '+p[1]; };
  const andJoin=(a)=>a.length<=1?(a[0]||''):a.slice(0,-1).join(', ')+' and '+a[a.length-1];
  const nums=(a)=>{ const s=[...new Set(a)].sort((x,y)=>x-y); return s.length>6 ? s.slice(0,6).join(', ')+'…' : andJoin(s.map(String)); };
  const SIDE=['north','east','south','west'];
  const DT={ entrance:'Entrance', lair:'Lair', crypt:'Crypt', barracks:'Barracks', library:'Library', storeroom:'Storeroom', shrine:'Shrine', hall:'Great hall',
    treasury:'Treasury', kitchen:'Kitchen', guardroom:'Guardroom', deadend:'Dead end', landing:'Landing',
    stope:'Ore working', orevein:'Ore vein', cartdepot:'Cart depot', toolstore:'Tool store', bunkroom:'Bunkroom', collapse:'Collapsed gallery', powder:'Powder store',
    cistern:'Cistern', junction:'Junction chamber', pumproom:'Pump room', smugglers:"Smugglers' den", overflow:'Overflow chamber',
    chapel:'Chapel', cells:"Monks' cells", scriptorium:'Scriptorium', refectory:'Refectory', vestry:'Vestry', ossuary:'Ossuary', reliquary:'Reliquary' };
  const DT_STYLE={ mine:{entrance:'Mine entrance', lair:'Deep workings'}, sewer:{entrance:'Access chamber', lair:"Rat king's nest"}, temple:{entrance:'Nave', lair:'Inner sanctum'} };
  const FLAV={
    entrance:['Cold air drifts down the steps behind you.','Old boot prints cross the dust here.','Someone has scratched a crude arrow on the wall, pointing deeper in.'],
    arrival:['Debris from above litters the floor.','The air here moves, as if a shaft opens somewhere overhead.','Your footsteps from the level above still echo down.'],
    lair:['The smell is strong here, and some of the bones are fresh.','Something large sleeps here often; the floor is worn smooth.','Claw marks score the walls up to head height.'],
    crypt:['The lids are carved with faces worn almost smooth.','Dust lies thick; nothing has been disturbed in years… almost.','One lid sits slightly askew.'],
    barracks:['The bunks are unmade, as if the guards left in a hurry.','A half-finished game of dice lies on a blanket.','The room smells of old sweat and lamp oil.'],
    library:['Many books have rotted; a few look recently read.','An open ledger lies on the table, written in a strange hand.','Loose pages are scattered across the floor.'],
    storeroom:['Most crates are empty; one is nailed shut.','Rats scatter from behind the barrels.','Sacks of grain here have gone to mould.'],
    shrine:['The altar is stained dark.','Coins and small bones lie as offerings before the altar.','A carved symbol above the altar has been chiselled away.'],
    hall:['The long table still holds plates and cups.','Banners hang in tatters from the walls.','Every sound echoes in this big room.'],
    treasury:['The chests are heavy and banded with iron.','A thin wire runs low across the floor near the door.','Coins lie scattered, as if someone left in a hurry.'],
    kitchen:['A pot still hangs over cold ashes.','Knives and cleavers hang in a neat row.','Something has been getting into the stores.'],
    guardroom:['A bell hangs by the door to raise the alarm.','Two stools, two mugs, one still half full.','A duty roster is pinned to the wall.'],
    deadend:['The passage ends here. Or does it?','Scratches on the end wall suggest someone tried to dig further.','The air is stale and still.'],
    landing:['Debris from above litters the floor.','The air here moves, as if a shaft opens somewhere overhead.'],
    stope:['Pick marks cover every wall.','A seam of ore glints in the lamplight.','The props here creak under the weight of the rock.'],
    orevein:['The vein sparkles when light falls on it.','Someone has chalked tally marks beside the richest seam.','Loose ore crunches underfoot.'],
    cartdepot:['One cart has a broken wheel.','The rails here are worn bright.','A chalkboard lists loads that were never collected.'],
    toolstore:['Picks and shovels hang in neat rows; one hook is empty.','The tools are rusty but usable.','A strongbox is bolted to the floor.'],
    bunkroom:['The bedrolls are damp and smell of mildew.','A tin plate still holds a half-eaten meal.','Names are carved into the wall above the bunks.'],
    collapse:['The roof came down here; fresh dust still hangs in the air.','Something is buried under the rubble.','The props on this side have snapped like twigs.'],
    powder:['A sign reads NO FLAME in big red letters.','One keg has split and spilled black powder across the floor.','The air is dry and smells of sulphur.'],
    cistern:['The water is black and very still.','Something moves under the surface.','Your light barely reaches the far side.'],
    junction:['Four channels meet here in a churn of foul water.','The noise of rushing water drowns out voices.','Old chalk arrows point in every direction.'],
    pumproom:['The great wheel is rusted almost solid.','The machinery still hums faintly.','A logbook lies open on a shelf.'],
    smugglers:['The crates are stamped with the mark of a merchant house.','A lantern has been left burning.','Fresh boot prints lead in and out.'],
    overflow:['Water pours from the pipes after rain.','A tide line runs round the walls at head height.','Debris is heaped against one wall.'],
    chapel:['Faded paintings of saints cover the walls.','Candle wax has built up in thick drifts.','A prayer is carved into the altar stone.'],
    cells:['Each cell holds a hard bed and nothing else.','A hair shirt hangs on a hook.','Scratched tallies mark long days of penance.'],
    scriptorium:['Ink pots have dried to black crusts.','A half-copied manuscript lies open.','The shelves hold scrolls in a forgotten script.'],
    refectory:['The long table is set for a meal that never came.','A lectern stands where a reader once spoke at meals.','Bowls are stacked neatly by the door.'],
    vestry:['Robes hang in a row, moth-eaten.','A silver censer lies on the floor.','A chest of vestments has been forced open.'],
    ossuary:['Skulls are stacked in careful patterns along the walls.','The bones are arranged by size.','A cold draught stirs the dust.'],
    reliquary:['A glass case holds a single finger bone.','The font holds water that never evaporates.','Gold leaf flakes from the walls.'],
    nave:['Light falls through a shaft high above onto the altar.','Every sound echoes up into the vaulted ceiling.','Rows of pews face the altar, some overturned.'],
    sanctum:['The air hums with old power.','The altar is carved from a single black stone.','Only the high priests were allowed in here.'],
    ice:['Your breath hangs in the air.','The walls are glassy with ice.','Something is frozen deep inside the ice.','Icicles ring like bells when you pass.','The floor is treacherously slick.','A frozen waterfall hangs in mid-fall.'],
    lava:['The heat is almost unbearable.','The rock glows dull red in places.','The air shimmers and smells of sulphur.','Bursts of steam hiss from cracks in the floor.','Obsidian glints like black glass.','The ground trembles now and then.'],
    cave:['Water drips steadily from the ceiling.','The floor is slick and uneven.','Your voices echo back strangely.','A cold breeze hints at another way out.','Bats rustle high in the dark.','Loose stones clatter underfoot.',
      'Pale roots hang through cracks in the ceiling.','A trickle of water runs along one wall.','The rock glitters with flecks of mica.','Stalactites hang low; tall creatures must duck.',
      'The ground is soft with dust and old droppings.','A sharp mineral smell hangs in the air.','Faded drawings in red ochre cover one wall.','The ceiling rises out of reach of your light.',
      'Old webs stretch across the upper corners.','Claw marks show where something sharpened its talons.'] };
  const h32=(a,b)=>{ let t=Math.imul((a^Math.imul(b,0x9e3779b1))>>>0,0x85ebca6b); t^=t>>>13; t=Math.imul(t,0xc2b2ae35); t^=t>>>16; return t>>>0; };
  // where a point sits in a rectangle o={x,y,w,h}
  const whereIn=(x,y,o)=>{ const fx=(x-o.x)/o.w, fy=(y-o.y)/o.h, hz=fx<0.3?'west':fx>0.7?'east':'', vt=fy<0.3?'north':fy>0.7?'south':'';
    return hz&&vt ? `in the ${vt}-${hz} corner` : (hz||vt) ? `by the ${vt||hz} wall` : 'in the middle'; };
  const whereFrom=(x,y,cx,cy)=>{ const dx=x-cx, dy=y-cy; if(Math.hypot(dx,dy)<1.5) return 'in the middle';
    const a=(Math.atan2(dy,dx)*180/Math.PI+360+22.5)%360, d=['east','south-east','south','south-west','west','north-west','north','north-east'][Math.floor(a/45)]; return `on the ${d} side`; };
  function linkText(f, lv, nL){ const below=lv<nL?`Level ${lv+1}`:'a deeper level', above=lv>1?`Level ${lv-1}`:'the surface';
    if(f.link==='down'){ if(f.kind==='stairs') return `stairs down to ${below}`; if(f.kind==='well') return `a well: its shaft drops into a pool on ${below}`;
      if(f.kind==='pit') return `a trapdoor pit: a fall to ${below}`; if(f.kind==='sinkhole') return `a sinkhole: a steep drop to ${below}`; return `a way down to ${below}`; }
    if(f.kind==='stairs') return `stairs up to ${above}`; if(f.kind==='splash') return `a pool under the well shaft from ${above}`;
    return `rubble under a hole in the ceiling (the drop from ${above})`; }
  const LINKT={stairs:'Stairs', well:'Well', pit:'Trapdoor pit', sinkhole:'Sinkhole', splash:'Pool', rubble:'Rubble'};
  function contents(F){ const c={}, L={}; for(const f of F){ if(f.link||f.kind==='splash'||SKIPK.has(f.kind)) continue; (LIGHTK.has(f.kind)?L:c)[f.kind]=((LIGHTK.has(f.kind)?L:c)[f.kind]||0)+1; }
    const order=(o)=>Object.keys(o).sort((a,b)=>o[b]-o[a]||a.localeCompare(b));
    return { things:order(c).map(k=>cnt(c[k],k)), lights:order(L).map(k=>cnt(L[k],k)), count:{...c,...L} }; }

  // roomKey(D, {level, levels, seed}) → { entries:[{n,x,y,title,lines:[…],flavor}], marks:[{id,x,y,title,lines}] }  (x,y in squares)
  function roomKey(D, o){ o=o||{}; numberKey(D); const lv=o.level||1, nL=o.levels||1, seed=(o.seed>>>0)||1, res=D.res||1, W=D.cols*res, H=D.rows*res;
    const used=new Set(), flav=(pool,n)=>{ const a=FLAV[pool]||FLAV.cave, i0=h32(seed,n*31+lv)%a.length; for(let j=0;j<a.length;j++){ const t=a[(i0+j)%a.length]; if(!used.has(t)){ used.add(t); return t; } } return a[i0]; };
    const cellK=(x,y)=>Math.floor(y*res)*W+Math.floor(x*res);
    const entries=[], marks=[];
    if(D.kind==='dungeon'){
      const R=D.rooms, roomAt=new Int32Array(W*H).fill(-1); R.forEach((r,i)=>{ for(let y=r.y;y<r.y+r.h;y++) for(let x=r.x;x<r.x+r.w;x++) if(x>=0&&y>=0&&x<W&&y<H) roomAt[y*W+x]=i; });
      const comp=new Int32Array(W*H).fill(-1); let nc=0;   // passages = connected floor outside every room
      for(let k=0;k<W*H;k++){ if(!D.floor[k]||roomAt[k]>=0||comp[k]>=0) continue; const st=[k]; comp[k]=nc;
        while(st.length){ const c=st.pop(), x=c%W, y=(c/W)|0; for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||comp[K]>=0||!D.floor[K]||roomAt[K]>=0) continue; comp[K]=nc; st.push(K); } } nc++; }
      const openings=(i)=>{ const r=R[i], out=[];
        const sides=[[0,t=>[r.x+t,r.y-1],t=>[r.x+t,r.y],r.w],[1,t=>[r.x+r.w,r.y+t],t=>[r.x+r.w-1,r.y+t],r.h],[2,t=>[r.x+t,r.y+r.h],t=>[r.x+t,r.y+r.h-1],r.w],[3,t=>[r.x-1,r.y+t],t=>[r.x,r.y+t],r.h]];
        for(const [s,outC,inC,len] of sides){ let run=null; for(let t=0;t<=len;t++){ let ok=false, oc=null;
            if(t<len){ const [ox,oy]=outC(t), [ix,iy]=inC(t); ok=ox>=0&&oy>=0&&ox<W&&oy<H && !!D.floor[oy*W+ox] && !!D.floor[iy*W+ix] && roomAt[oy*W+ox]!==i; oc=[ox,oy]; }
            if(ok){ if(!run) run={side:s,cells:[]}; run.cells.push(oc); } else if(run){ out.push(run); run=null; } } }
        return out; };
      const doorOn=(r,run)=>{ for(const [ox,oy] of run.cells) for(const d of D.doors){ const hz=d.y1===d.y2;
          if((run.side===0&&hz&&d.y1===r.y&&d.x1===ox)||(run.side===2&&hz&&d.y1===r.y+r.h&&d.x1===ox)||(run.side===1&&!hz&&d.x1===r.x+r.w&&d.y1===oy)||(run.side===3&&!hz&&d.x1===r.x&&d.y1===oy)) return d; } return null; };
      const OP=R.map((r,i)=>openings(i)), touch=[...Array(nc)].map(()=>new Set());
      OP.forEach((runs,i)=>runs.forEach(run=>run.cells.forEach(([x,y])=>{ const c=comp[y*W+x]; if(c>=0) touch[c].add(i); })));
      R.forEach((r,i)=>{ const inR=D.features.filter(f=>f.x>=r.x&&f.x<r.x+r.w&&f.y>=r.y&&f.y<r.y+r.h), C=contents(inR), lines=[];
        lines.push(`${r.w} × ${r.h} squares (${r.w*5} × ${r.h*5} ft).`);
        lines.push(C.things.length ? cap(andJoin(C.things))+'.' : 'Bare floor.');
        if(D.water){ let wn=0; for(let y=r.y;y<r.y+r.h;y++) for(let x=r.x;x<r.x+r.w;x++) if(D.water[y*W+x]) wn++; if(wn) lines.push(wn>=r.w*r.h*0.4 ? 'Dark water fills the middle; a narrow walkway runs round the edge.' : 'Part of the floor is under foul water.'); }
        for(const f of inR.filter(f=>f.link)) lines.push(cap(whereIn(f.x,f.y,r))+': '+linkText(f,lv,nL)+'.');
        if(r.type==='entrance' && lv===1 && !inR.some(f=>f.link==='up')) lines.push('The way in from the surface.');
        lines.push(C.lights.length ? 'Lit by '+andJoin(C.lights)+'.' : 'Dark.');
        const ex=OP[i].map(run=>{ const d=doorOn(r,run), ds=d&&doorState(d), what=d?(ds==='closed'&&d.grate?'iron grate':({open:'archway', closed:'door', locked:d.grate?'locked grate':'locked door', secret:'secret door'})[ds]):'opening', to=new Set();
          for(const [x,y] of run.cells){ const k=y*W+x; if(roomAt[k]>=0) to.add(R[roomAt[k]].n); else if(comp[k]>=0) for(const j of touch[comp[k]]) if(j!==i) to.add(R[j].n); }
          return `${what} ${SIDE[run.side]}` + (to.size ? ` (to ${nums([...to])})` : ' (a passage that leads nowhere else)'); });
        lines.push(ex.length ? 'Exits: '+ex.join(', ')+'.' : 'No exits.');
        const deep=r.type==='entrance'&&lv>1, SD=DT_STYLE[D.style]||{}, title=deep?(D.style==='temple'?'Nave':'Landing hall'):(SD[r.type]||DT[r.type]||cap(r.type||'room'));
        const fp = D.style==='temple'&&r.type==='entrance' ? 'nave' : D.style==='temple'&&r.type==='lair' ? 'sanctum' : (D.style&&(r.type==='entrance'||r.type==='lair')) ? (r.type==='lair'?(D.style==='mine'?'stope':'overflow'):'arrival') : deep?'arrival':(FLAV[r.type]?r.type:'cave');
        entries.push({n:r.n, x:r.x+r.w/2, y:r.y+r.h/2, title, type:r.type, lines, fp}); });
      // ways up / down out in the passages get letters
      let li=0; for(const f of D.features){ if(!f.link && f.kind!=='splash') continue; if(roomAt[cellK(f.x,f.y)]>=0) continue;
        let near=null, nd=FAR; for(const r of R){ const d=Math.hypot(r.x+r.w/2-f.x, r.y+r.h/2-f.y); if(d<nd){ nd=d; near=r; } }
        marks.push({id:String.fromCharCode(65+li++), x:f.x, y:f.y, title:LINKT[f.kind]||cap(f.kind), lines:[cap(linkText(f,lv,nL))+'.', near?`In the passage near ${near.n}.`:'In a passage.']}); }
    } else {
      const ch=D.chambers||[], reg=new Int32Array(W*H).fill(-1), q=[];
      ch.forEach((c,i)=>{ const k=cellK(c.x,c.y); if(D.floor[k]&&reg[k]<0){ reg[k]=i; q.push(k); } });
      for(let h=0;h<q.length;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||reg[K]>=0||!D.floor[K]) continue; reg[K]=reg[k]; q.push(K); } }
      const A=ch.map(()=>({cells:0, water:0, x0:FAR, y0:FAR, x1:-FAR, y1:-FAR, adj:new Set(), edge:new Set()}));
      for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const k=y*W+x, g=reg[k]; if(g<0) continue; const a=A[g]; a.cells++; if(D.water&&D.water[k]) a.water++;
        a.x0=Math.min(a.x0,x); a.y0=Math.min(a.y0,y); a.x1=Math.max(a.x1,x); a.y1=Math.max(a.y1,y);
        if(x+1<W && reg[k+1]>=0 && reg[k+1]!==g){ a.adj.add(reg[k+1]); A[reg[k+1]].adj.add(g); }
        if(y+1<H && reg[k+W]>=0 && reg[k+W]!==g){ a.adj.add(reg[k+W]); A[reg[k+W]].adj.add(g); }
        if(y===0) a.edge.add(0); if(x===W-1) a.edge.add(1); if(y===H-1) a.edge.add(2); if(x===0) a.edge.add(3); }
      const nearest=(x,y)=>{ let b=-1, bd=FAR; ch.forEach((c,i)=>{ const d=Math.hypot(c.x-x,c.y-y); if(d<bd){ bd=d; b=i; } }); return b; };
      const featOf=ch.map(()=>[]); for(const f of D.features){ let g=reg[cellK(f.x,f.y)]; if(g<0) g=nearest(f.x,f.y); if(g>=0) featOf[g].push(f); }
      ch.forEach((c,i)=>{ const a=A[i], F=featOf[i], C=contents(F), n=C.count, lines=[];
        const sq=Math.max(1,Math.round(a.cells/(res*res))), bw=Math.max(1,Math.round((a.x1-a.x0+1)/res)), bh=Math.max(1,Math.round((a.y1-a.y0+1)/res));
        const downs=F.filter(f=>f.link==='down'), ups=F.filter(f=>f.link==='up'), mouth=lv===1 && !D.features.some(f=>f.link==='up') && a.edge.size>0, pool=a.water/Math.max(1,a.cells)>0.12;
        const SY=D.style, title = mouth?'Cave mouth' : n.campfire?'Camp' : downs.some(f=>f.kind==='sinkhole')?'Sinkhole cavern' : ups.length?'Landing'
          : pool?(SY==='lava'?'Lava lake':SY==='ice'?'Frozen pool':'Underground pool') : (n.crystals||0)>=2?(SY==='ice'?'Ice grotto':'Crystal grotto') : (n.obsidian||0)>=2?'Obsidian field' : (n.vent||0)>=2?'Steam vents'
          : (n.icespike||0)>=2?'Ice-spike hall' : (n.mushrooms||0)>=2?'Mushroom grove' : n.chest?'Hidden nook' : (n.bones||0)>=2?'Bone-strewn cave'
          : sq<10?'Alcove' : sq<35?'Cave' : 'Great cavern';
        lines.push(`About ${sq} squares of floor, roughly ${bw} × ${bh} (${bw*5} × ${bh*5} ft).`);
        if(mouth) lines.push(`The way in from outside opens on the ${andJoin([...a.edge].sort().map(s=>SIDE[s]))} edge of the map.`);
        if(a.water) lines.push(D.style==='lava' ? (pool?'A lake of glowing lava covers much of the floor. Touching it is deadly.':'A small pool of lava bubbles here.')
          : D.style==='ice' ? (pool?'A frozen pool covers much of the floor; the ice is slick.':'A small frozen pool lies here.')
          : (pool ? 'A pool of still, dark water covers much of the floor.' : 'A small pool of water lies here.'));
        if(C.things.length) lines.push(cap(andJoin(C.things))+'.');
        for(const f of F.filter(f=>f.link)) lines.push(cap(whereFrom(f.x,f.y,c.x,c.y))+': '+linkText(f,lv,nL)+'.');
        lines.push(D.style==='lava'&&a.water ? 'Lit by the red glow of the lava'+(C.lights.length?' and '+andJoin(C.lights):'')+'.' : C.lights.length ? 'Lit by '+andJoin(C.lights)+'.' : 'Dark.');
        const adj=[...a.adj].map(j=>ch[j].n); lines.push(adj.length ? `Passages lead to ${nums(adj)}.` : 'No other way out.');
        entries.push({n:c.n, x:c.x, y:c.y, title, type:'cave', lines, fp:D.style==='ice'?'ice':D.style==='lava'?'lava':'cave'}); });
    }
    entries.sort((a,b)=>a.n-b.n); for(const e of entries){ e.flavor=flav(e.fp,e.n); delete e.fp; }   // in number order → no line repeats while the pool lasts
    return { kind:D.kind, level:lv, levels:nL, entries, marks }; }

  /* ---------- ✏ EDIT (v1.24): paint floor / rock, doors, furniture — every edit returns a NEW layout (levels stay
     immutable → Undo snapshots can share them by reference). Coordinates in whole squares. ---------- */
  const sqFloor=(D,cx,cy)=>{ const res=D.res||1, W=D.cols*res; if(cx<0||cy<0||cx>=D.cols||cy>=D.rows) return false; for(let y=cy*res;y<cy*res+res;y++) for(let x=cx*res;x<cx*res+res;x++) if(!D.floor[y*W+x]) return false; return true; };
  const doorOk=(D,d)=> d.x1===d.x2 ? sqFloor(D,d.x1-1,d.y1)&&sqFloor(D,d.x1,d.y1) : sqFloor(D,d.x1,d.y1-1)&&sqFloor(D,d.x1,d.y1);
  // paint whole squares: v=1 dig (floor) · v=0 fill (rock). The outer ring stays rock; squares under a way up / down can't be filled.
  function paint(D, cells, v){ const res=D.res||1, W=D.cols*res, H=D.rows*res, floor=D.floor.slice(), water=D.water?D.water.slice():null;
    const fixed=new Set(); for(const f of D.features) if(f.link) for(let y=Math.floor(f.y-f.d/2+0.05);y<=Math.floor(f.y+f.d/2-0.05);y++) for(let x=Math.floor(f.x-f.w/2+0.05);x<=Math.floor(f.x+f.w/2-0.05);x++) fixed.add(x+','+y);
    let n=0; for(const [cx,cy] of cells){ if(cx<1||cy<1||cx>=D.cols-1||cy>=D.rows-1 || (!v && fixed.has(cx+','+cy))) continue;
      for(let y=cy*res;y<cy*res+res;y++) for(let x=cx*res;x<cx*res+res;x++){ const k=y*W+x; if(floor[k]!==v){ floor[k]=v; n++; } if(water && !v) water[k]=0; } }
    if(!n) return D;
    const T={...D, floor}; const keep=(f)=> f.link || sqFloor(T,Math.floor(f.x),Math.floor(f.y));
    const features=D.features.filter(keep), doors=D.doors.filter(d=>doorOk(T,d));
    if(D.kind==='cave'){ const o=caveOut(D.cols,D.rows,res,floor,water||new Array(W*H).fill(0),features); return {...D, ...o, edited:true}; }
    return {...D, floor, water, walls:gridLoops(floor,W,H), waterLoops:water?gridLoops(water,W,H):[], doors, features, edited:true}; }
  // the door nearest (x,y) within ~⅔ square → index, else -1
  function doorAt(D, x, y){ let b=-1, bd=0.7; D.doors.forEach((d,i)=>{ const m=Math.hypot((d.x1+d.x2)/2-x,(d.y1+d.y2)/2-y); if(m<bd){ bd=m; b=i; } }); return b; }
  // the doorway a new door could go in at (x,y): a grid edge with floor on both sides that crosses a room wall or a 1-wide passage
  function doorwayAt(D, x, y){ if(D.kind!=='dungeon') return null; const F=(cx,cy)=>sqFloor(D,cx,cy);
    const room=(p)=>D.rooms.findIndex(o=>p[0]>=o.x&&p[0]<o.x+o.w&&p[1]>=o.y&&p[1]<o.y+o.h);
    const vx=Math.round(x), hy=Math.round(y), cx=Math.floor(x), cy=Math.floor(y);
    const C=[ {d:Math.abs(x-vx), e:{x1:vx,y1:cy,x2:vx,y2:cy+1}, a:[vx-1,cy], b:[vx,cy], s1:[[vx-1,cy-1],[vx,cy-1]], s2:[[vx-1,cy+1],[vx,cy+1]]},
              {d:Math.abs(y-hy), e:{x1:cx,y1:hy,x2:cx+1,y2:hy}, a:[cx,hy-1], b:[cx,hy], s1:[[cx-1,hy-1],[cx-1,hy]], s2:[[cx+1,hy-1],[cx+1,hy]]} ].sort((p,q)=>p.d-q.d);
    for(const c of C){ if(c.d>0.35 || !F(...c.a) || !F(...c.b)) continue;
      if(D.doors.some(d=>d.x1===c.e.x1&&d.y1===c.e.y1&&d.x2===c.e.x2&&d.y2===c.e.y2)) continue;
      const narrow=(!F(...c.s1[0])||!F(...c.s1[1])) && (!F(...c.s2[0])||!F(...c.s2[1]));
      if(room(c.a)!==room(c.b) || narrow) return c.e; }
    return null; }
  // door states: 'closed' · 'locked' · 'secret' (looks like wall; VTT gets a wall) · 'open' (archway) · 'none' (removed)
  const doorState=(d)=> d.secret?'secret' : d.lock?'locked' : d.open?'open' : 'closed';
  function setDoor(D, i, st){ const doors=D.doors.slice(); if(st==='none') doors.splice(i,1);
    else { const d={x1:doors[i].x1,y1:doors[i].y1,x2:doors[i].x2,y2:doors[i].y2, open:st==='open'}; if(st==='locked') d.lock=true; if(st==='secret') d.secret=true; if(doors[i].grate) d.grate=true; doors[i]=d; }
    return {...D, doors, edited:true}; }
  function addDoor(D, e){ return {...D, doors:D.doors.concat([{...e, open:false}]), edited:true}; }
  // furniture: move by whole squares (footprint must stay on open floor), rotate a quarter turn, delete, add
  const footOk=(D,it,skip)=>{ for(let y=Math.floor(it.y-it.d/2+0.05);y<=Math.floor(it.y+it.d/2-0.05);y++) for(let x=Math.floor(it.x-it.w/2+0.05);x<=Math.floor(it.x+it.w/2-0.05);x++){ if(!sqFloor(D,x,y)) return false; } return true; };
  function moveFeature(D, i, dx, dy){ const f=D.features[i]; if(!f || f.link || (!dx&&!dy)) return D; const it={...f, x:f.x+dx, y:f.y+dy}; if(!footOk(D,it)) return D;
    const features=D.features.slice(); features[i]=it; return {...D, features, edited:true}; }
  function rotateFeature(D, i){ const f=D.features[i]; if(!f || f.link) return D; const it={...f, w:f.d, d:f.w}; if(f.face!=null) it.face=(f.face+1)%4; if(!footOk(D,it)) return D;
    const features=D.features.slice(); features[i]=it; return {...D, features, edited:true}; }
  function deleteFeature(D, i){ const f=D.features[i]; if(!f || f.link) return D; const features=D.features.slice(); features.splice(i,1); return {...D, features, edited:true}; }
  function addFeature(D, it){ if(!footOk(D,it)) return D; return {...D, features:D.features.concat([it]), edited:true}; }

  root.DungeonGen = { generate(o){ o=o||{}; const cols=Math.max(12,o.cols|0||30), rows=Math.max(10,o.rows|0||24), seed=(o.seed>>>0)||1, arr=o.arrivals||[];
      if(o.kind==='cave') return numberKey(cave(cols,rows,seed,arr,o.style||null));
      if(o.style==='temple' && !arr.length && cols>=20 && rows>=14){ let best=null; for(let t=0;t<6;t++){ const g=temple(cols,rows,(seed+t*7919)>>>0); if(!best||g.rooms.length>best.rooms.length) best=g; if(g.rooms.length>=5) break; } return numberKey(best); }
      const sopt=o.style?{style:o.style}:undefined;
      let best=null; for(let t=0;t<8;t++){ const g=dungeon(cols,rows,(seed+t*7919)>>>0,null,arr,sopt); if(!best||g.rooms.length>best.rooms.length) best=g; if(g.rooms.length>=Math.min(4,Math.max(3,Math.round(cols*rows/120)))) return numberKey(g); } return numberKey(best); },   // retry a cramped layout
    extend(D, dir, E, seed){ const e=Math.max(6,E|0||12), {ox,oy}=offsetOf(dir,e); return numberKey(carryKey(extend(D,dir,E,seed),D,ox,oy)); },
    deadEnd(D, dir, E, seed, end){ const e=Math.max(6,E|0||12), {ox,oy}=offsetOf(dir,e); return numberKey(carryKey(deadEnd(D,dir,E,seed,end),D,ox,oy)); },
    addArrival(L, a){ return numberKey(addArrival(L,a)); },
    pad(D, dir, E){ const {ox,oy}=offsetOf(dir,E); return carryKey(pad(D,dir,E),D,ox,oy); },   // untouched levels keep their numbers as they are
    numberKey, roomKey, words:{cnt, andJoin, cap, SIDE},
    paint, doorAt, doorwayAt, doorState, setDoor, addDoor, moveFeature, rotateFeature, deleteFeature, addFeature, sqFloor:(D,x,y)=>sqFloor(D,x,y),
    arrivalsFrom, gridLoops, msLoops,
    // make sure a level has a way DOWN (for ⬇ Dig deeper): a well / pit (dungeon) or a sinkhole (cave), else a plain pit anywhere open
    ensureDown(D, seed){ if(D.features.some(f=>f.link==='down')) return D; const F=D.features.slice(), r=rng32(seed>>>0||1), W=D.cols*D.res, H=D.rows*D.res;
      drops(F, D.rooms, D.floor, W, H, r, D.kind, D.res, true);
      if(!F.some(f=>f.link==='down')){ for(let y=1;y<D.rows-1;y++){ for(let x=1;x<D.cols-1;x++){ let ok=true; for(let sy=0;sy<D.res&&ok;sy++) for(let sx=0;sx<D.res;sx++) if(!D.floor[(y*D.res+sy)*W+x*D.res+sx]){ ok=false; break; }
            if(ok && !F.some(f=>Math.floor(f.x)===x&&Math.floor(f.y)===y)){ F.push({kind:D.kind==='cave'?'sinkhole':'pit',x:x+0.5,y:y+0.5,w:D.kind==='cave'?1.4:0.9,d:D.kind==='cave'?1.4:0.9,link:'down'}); y=D.rows; break; } } } }
      return {...D, features:F}; } };
})(typeof self!=='undefined' ? self : this);
