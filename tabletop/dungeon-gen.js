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
  const blur=(m,W,H,r)=>{ const o=new Array(W*H).fill(0); for(let y=0;y<H;y++) for(let x=0;x<W;x++){ let s=0,n=0; for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){ const X=x+dx, Y=y+dy; n++; if(X>=0&&Y>=0&&X<W&&Y<H) s+=m[Y*W+X]; } o[y*W+x]=s/n; } return o; };

  /* ---------- DUNGEON: rooms + A* corridors + doors ---------- */
  const ROOM_TYPES=['crypt','barracks','library','storeroom','shrine','hall','treasury','kitchen','guardroom'];
  // base (Extend): { floor, rooms, doors, features, region:{x0,y0,x1,y1} } already in the NEW grid's coords. The old
  // layout is kept exactly; new rooms go only inside `region` (the added strip) and are wired to the nearest old rooms.
  function dungeon(cols, rows, seed, base){
    const r=rng32(seed), ri=(n)=>Math.floor(r()*n), W=cols, H=rows, floor=base?base.floor.slice():new Array(W*H).fill(0), roomAt=new Int16Array(W*H).fill(-1);
    const R=base?base.region:{x0:2,y0:2,x1:W-2,y1:H-2}, RW=R.x1-R.x0, RH=R.y1-R.y0;
    const rooms=base?base.rooms.map(o=>({...o,old:true})):[], nOld=rooms.length;
    const target=nOld+Math.max(base?1:3, Math.round(RW*RH/70)), small=W*H<520, G=small?2:3, maxS=small?4:5;
    for(let t=0;t<600 && rooms.length<target;t++){ const big=!base && rooms.length===1 && W>=20 && H>=16;
      const w=big?7+ri(4):3+ri(maxS), h=big?6+ri(3):3+ri(maxS-1); if(w>RW-1||h>RH-1) continue;
      const x=R.x0+ri(RW-w), y=R.y0+ri(RH-h); if(x<2||y<2||x+w>W-2||y+h>H-2) continue;
      if(rooms.some(o=>x<o.x+o.w+G && x+w+G>o.x && y<o.y+o.h+G && y+h+G>o.y)) continue;
      rooms.push({x,y,w,h}); }
    rooms.forEach((o,i)=>{ for(let y=o.y;y<o.y+o.h;y++) for(let x=o.x;x<o.x+o.w;x++){ floor[y*W+x]=1; roomAt[y*W+x]=i; } });
    const cx=(o)=>o.x+o.w/2, cy=(o)=>o.y+o.h/2, dC=(a,b)=>Math.hypot(cx(rooms[a])-cx(rooms[b]),cy(rooms[a])-cy(rooms[b]));
    // connections: MST over the NEW rooms (+ a few loops); on Extend, also 1–2 links from new rooms to the nearest OLD rooms
    const fresh=[]; for(let i=nOld;i<rooms.length;i++) fresh.push(i);
    const edges=[];
    if(fresh.length){ const inT=new Set([fresh[0]]);
      while(inT.size<fresh.length){ let best=null; for(const a of inT) for(const b of fresh){ if(inT.has(b)) continue; const d=dC(a,b); if(!best||d<best.d) best={a,b,d}; } inT.add(best.b); edges.push([best.a,best.b]); }
      const extra=Math.round(fresh.length*0.25); for(let t=0;t<extra*6 && edges.length<fresh.length-1+extra;t++){ const a=fresh[ri(fresh.length)], b=fresh[ri(fresh.length)]; if(a===b||edges.some(e=>(e[0]===a&&e[1]===b)||(e[0]===b&&e[1]===a))) continue;
        if(dC(a,b)<Math.min(W,H)*0.6) edges.push([a,b]); } }
    if(base && fresh.length && nOld){ const pairs=[]; for(const a of fresh) for(let b=0;b<nOld;b++) pairs.push([a,b,dC(a,b)]); pairs.sort((p,q)=>p[2]-q[2]);
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
          const isEnd=(X===g.x&&Y===g.y)||doorCells.has(X+','+Y);
          const c=(floor[K(X,Y)]?0.35:1)+(!isEnd && nearRoom(X,Y)?6:0)+(dx!==0&&prev.get(K(x,y))!=null&&(prev.get(K(x,y))%W)===x?0.4:0);   // prefer existing halls; mild straightness
          const ng=gs.get(K(x,y))+c; if(ng<(gs.get(K(X,Y))??1e9)){ gs.set(K(X,Y),ng); prev.set(K(X,Y),K(x,y)); open.push([ng+Math.abs(X-g.x)+Math.abs(Y-g.y),X,Y]); } } }
      if(!gs.has(K(g.x,g.y))) return null; const path=[]; let k=K(g.x,g.y); while(k!=null){ path.push(k); k=prev.get(k); } return path; };
    const used=new Set();
    for(const [a,b] of edges){ const da=pickDoor(a,b), db=pickDoor(b,a); if(!da||!db) continue;
      const path=astar({x:da.ox,y:da.oy},{x:db.ox,y:db.oy}); if(!path) continue;
      for(const k of path) floor[k]=1; used.add(da); used.add(db); }
    for(const d of used){ const open = r()<0.28;   // an open archway, else a door
      // the doorway is the shared edge between the room's border cell and the corridor cell outside it
      if(d.side===0) newDoors.push({x1:d.ix,y1:d.iy,x2:d.ix+1,y2:d.iy,open}); else if(d.side===2) newDoors.push({x1:d.ix,y1:d.iy+1,x2:d.ix+1,y2:d.iy+1,open});
      else if(d.side===3) newDoors.push({x1:d.ix,y1:d.iy,x2:d.ix,y2:d.iy+1,open}); else newDoors.push({x1:d.ix+1,y1:d.iy,x2:d.ix+1,y2:d.iy+1,open}); }
    const doors=(base?base.doors:[]).concat(newDoors);
    // unreachable rooms go back to rock (keeps the map honest)
    const seen=new Uint8Array(W*H), st=[rooms[0].y*W+rooms[0].x]; seen[st[0]]=1;
    while(st.length){ const k=st.pop(), x=k%W, y=(k/W)|0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy, K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||seen[K]||!floor[K]) continue; seen[K]=1; st.push(K); } }
    for(let k=0;k<W*H;k++) if(floor[k]&&!seen[k]) floor[k]=0;
    const live=rooms.map((o,i)=>seen[o.y*W+o.x]?i:-1).filter(i=>i>=0);
    const okC=(x,y)=>x>=0&&y>=0&&x<W&&y<H&&floor[y*W+x]&&seen[y*W+x];
    const doorsLive=doors.filter(d=> d.x1===d.x2 ? okC(d.x1-1,d.y1)&&okC(d.x1,d.y1) : okC(d.x1,d.y1-1)&&okC(d.x1,d.y1));   // both sides of the doorway reachable
    // room types: entrance (stairs up) = room 0, lair (stairs down) = farthest by corridor distance
    const dist=new Int32Array(W*H).fill(-1), q=[rooms[0].y*W+rooms[0].x]; dist[q[0]]=0;
    for(let h=0;h<q.length;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<0||Y<0||X>=W||Y>=H||dist[K]>=0||!floor[K]) continue; dist[K]=dist[k]+1; q.push(K); } }
    const liveNew=live.filter(i=>i>=nOld), hasLair=rooms.some(o=>o.old&&o.type==='lair');
    let far=liveNew[0]??live[0], fd=-1; for(const i of (base?liveNew:live)){ const o=rooms[i], dd=dist[Math.floor(cy(o))*W+Math.floor(cx(o))]; if(dd>fd){ fd=dd; far=i; } }
    const out=[]; for(const i of live){ const o=rooms[i]; if(o.old){ out.push({x:o.x,y:o.y,w:o.w,h:o.h,type:o.type}); continue; }
      out.push({x:o.x,y:o.y,w:o.w,h:o.h, type: (!base && i===live[0])?'entrance' : (i===far && (!base || !hasLair))?'lair' : (o.w>=6&&o.h>=5 ? (r()<0.5?'hall':'crypt') : ROOM_TYPES[ri(ROOM_TYPES.length)]), fresh:1}); }
    // pillars: big halls / crypts get rows of 1-square stone columns (they're real walls for line of sight)
    for(const o of out){ if(!o.fresh || !(o.type==='hall'||o.type==='crypt'||o.type==='lair') || o.w<6 || o.h<5) continue;
      for(let y=o.y+1;y<o.y+o.h-1;y+=2) for(let x=o.x+1;x<o.x+o.w-1;x+=Math.max(2,o.w-3)){ if(y===o.y+1||y>=o.y+o.h-2){ floor[y*W+x]=0; } } }
    const features=(base?base.features:[]).concat(dungeonDressing(out.filter(o=>!base||o.fresh), doorsLive, floor, W, H, r, {allRooms:out, region:base?R:null, prior:base?base.features:[]}));
    out.forEach(o=>{ delete o.fresh; });
    return { kind:'dungeon', cols, rows, res:1, floor, water:null, walls:gridLoops(floor,W,H), waterLoops:[], doors:doorsLive, rooms:out, features, newRooms:base?liveNew.length:out.length };
  }
  // furniture / dressing per room type, kept clear of doorways; wall torches everywhere
  function dungeonDressing(rooms, doors, floor, W, H, r, opt){ opt=opt||{}; const allRooms=opt.allRooms||rooms, Rg=opt.region;
    const F=[], ri=(n)=>Math.floor(r()*n), isF=(x,y)=>x>=0&&y>=0&&x<W&&y<H&&floor[y*W+x]===1;
    const occ=new Set(), cellK=(x,y)=>Math.floor(x)+','+Math.floor(y);
    for(const f of (opt.prior||[])) if(!f.flat) occ.add(cellK(f.x,f.y));   // Extend: never stack on what's already there
    const doorNear=(x,y,rad)=>doors.some(d=>Math.hypot((d.x1+d.x2)/2-x,(d.y1+d.y2)/2-y)<rad);
    const put=(it)=>{ const cells=[]; for(let y=Math.floor(it.y-it.d/2+0.05);y<=Math.floor(it.y+it.d/2-0.05);y++) for(let x=Math.floor(it.x-it.w/2+0.05);x<=Math.floor(it.x+it.w/2-0.05);x++) cells.push([x,y]);
      if(cells.some(([x,y])=>!isF(x,y)||occ.has(x+','+y))) return false; if(doorNear(it.x,it.y,1.2)) return false; if(!it.flat) cells.forEach(([x,y])=>occ.add(x+','+y)); F.push(it); return true; };
    // against a wall of room o on side s (0 top,1 right,2 bottom,3 left); item length along the wall `len`, depth `dep`
    const wall=(o,s,len,dep,kind,tries)=>{ for(let t=0;t<(tries||6);t++){ const u=(o.w>=len+0.2 && (s===0||s===2)) ? o.x+len/2+r()*(o.w-len) : (o.h>=len+0.2 ? o.y+len/2+r()*(o.h-len) : null); if(u==null) return false;
        const it = s===0?{kind,x:u,y:o.y+dep/2+0.04,w:len,d:dep,face:0}: s===2?{kind,x:u,y:o.y+o.h-dep/2-0.04,w:len,d:dep,face:2}: s===3?{kind,x:o.x+dep/2+0.04,y:u,w:dep,d:len,face:3}:{kind,x:o.x+o.w-dep/2-0.04,y:u,w:dep,d:len,face:1};
        if(put(it)) return true; } return false; };
    const mid=(o,kind,w,d)=>put({kind,x:o.x+o.w/2,y:o.y+o.h/2,w,d});
    const scatter=(o,kind,n,s)=>{ for(let i=0;i<n;i++){ put({kind,x:o.x+0.5+ri(o.w)+ (r()-0.5)*0.2,y:o.y+0.5+ri(o.h)+(r()-0.5)*0.2,w:s,d:s}); } };
    for(const o of rooms){ const sides=[0,1,2,3].sort(()=>r()-0.5);
      switch(o.type){
        case 'entrance': wall(o,sides[0],1.7,0.9,'stairs'); scatter(o,'rubble',1,0.7); break;
        case 'lair': wall(o,sides[0],1.7,0.9,'stairs'); mid(o,'statue',0.9,0.9); wall(o,sides[1],1,0.9,'chest'); scatter(o,'bones',3,0.6); put({kind:'brazier',x:o.x+1.5,y:o.y+1.5,w:0.8,d:0.8}); put({kind:'brazier',x:o.x+o.w-1.5,y:o.y+o.h-1.5,w:0.8,d:0.8}); break;
        case 'crypt': for(let i=0;i<Math.min(4,Math.floor(o.w/2));i++) put({kind:'sarcophagus',x:o.x+1.5+i*2,y:o.y+o.h/2,w:0.8,d:1.8}); scatter(o,'bones',2,0.6); break;
        case 'barracks': for(let i=0;i<Math.max(2,Math.floor(o.w/1.5));i++) wall(o,i%2?0:2,0.8,1.5,'bed',3); wall(o,sides[1],1.2,0.35,'weaponrack'); wall(o,sides[2],1,0.8,'chest'); break;
        case 'library': for(const s of sides.slice(0,3)) wall(o,s,Math.min(2.4,(s%2?o.h:o.w)-1),0.35,'bookshelf'); mid(o,'table',1.4,0.8); break;
        case 'storeroom': scatter(o,'crate',3+ri(3),0.8); scatter(o,'barrel',2+ri(3),0.55); break;
        case 'shrine': mid(o,'altar',1.3,0.6); put({kind:'candles',x:o.x+o.w/2-1,y:o.y+o.h/2,w:0.3,d:0.3}); put({kind:'candles',x:o.x+o.w/2+1,y:o.y+o.h/2,w:0.3,d:0.3}); break;
        case 'hall': mid(o,'table',Math.min(o.w-3,4),1); put({kind:'brazier',x:o.x+1.5,y:o.y+o.h/2,w:0.8,d:0.8}); put({kind:'brazier',x:o.x+o.w-1.5,y:o.y+o.h/2,w:0.8,d:0.8}); break;
        case 'treasury': for(let i=0;i<3;i++) wall(o,sides[i%4],1,0.8,'chest'); scatter(o,'crate',1,0.8); break;
        case 'kitchen': wall(o,sides[0],1.3,0.6,'fireplace'); mid(o,'table',1.4,0.8); scatter(o,'barrel',2,0.55); put({kind:'cauldron',x:o.x+o.w/2+1,y:o.y+o.h/2+1,w:0.8,d:0.8}); break;
        case 'guardroom': mid(o,'table',1,0.8); wall(o,sides[0],1.2,0.35,'weaponrack'); scatter(o,'barrel',1,0.55); break; }
      // wall torches: one or two per room
      for(const s of sides.slice(0, o.w*o.h>30?2:1)) wall(o,s,0.3,0.3,'torch',8);
    }
    // corridor torches + a little debris along the passages
    let n=0; for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++){ if(!isF(x,y) || allRooms.some(o=>x>=o.x&&x<o.x+o.w&&y>=o.y&&y<o.y+o.h)) continue;
      if(Rg && (x<Rg.x0-1||x>=Rg.x1+1||y<Rg.y0-1||y>=Rg.y1+1)) continue;   // Extend: only dress the new passages
      if(((x*7+y*13)%23)===0){ const s=!isF(x,y-1)?0:!isF(x+1,y)?1:!isF(x,y+1)?2:!isF(x-1,y)?3:-1; if(s>=0 && put({kind:'torch',x:x+0.5+(s===1?0.34:s===3?-0.34:0),y:y+0.5+(s===2?0.34:s===0?-0.34:0),w:0.3,d:0.3,face:s})) n++; }
      else if(r()<0.02) put({kind:r()<0.5?'rubble':'bones',x:x+0.5,y:y+0.5,w:0.6,d:0.6}); }
    return F; }

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
  function tunnel(m, W, H, lab, from, to){ const prev=new Int32Array(W*H).fill(-2), q=[]; for(let k=0;k<W*H;k++) if(lab[k]===from){ prev[k]=-1; q.push(k); }
    let hit=-1; for(let h=0;h<q.length && hit<0;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of N4){ const X=x+dx,Y=y+dy,K=Y*W+X; if(X<2||Y<2||X>=W-2||Y>=H-2||prev[K]!==-2) continue; prev[K]=k; if(lab[K]===to){ hit=K; break; } q.push(K); } }
    for(let k=hit;k>=0 && prev[k]!==-1;k=prev[k]){ const x=k%W, y=(k/W)|0; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){ const X=x+dx,Y=y+dy; if(X>1&&Y>1&&X<W-2&&Y<H-2) m[Y*W+X]=1; } } return hit>=0; }
  function pools(floor, water, W, H, r, n, inR){ const fl=[]; for(let k=0;k<W*H;k++) if(floor[k] && inR(k%W,(k/W)|0)) fl.push(k); if(!fl.length) return;
    for(let p=0;p<n;p++){ const s0=fl[Math.floor(r()*fl.length)], want=40+Math.floor(r()*70), q=[s0], seen=new Set([s0]);
      for(let h=0;h<q.length && seen.size<want;h++){ const k=q[h], x=k%W, y=(k/W)|0; for(const [dx,dy] of N4.slice().sort(()=>r()-0.5)){ const K=(y+dy)*W+x+dx; if(!floor[K]||seen.has(K)||!inR(K%W,(K/W)|0)) continue; let rockN=0; for(const [ex,ey] of N4) if(!floor[K+ey*W+ex]) rockN++; if(rockN) continue; seen.add(K); q.push(K); } }
      for(const k of seen) water[k]=1; } }
  // dressing (whole-square units) inside cell box R: a camp in the most open spot, glowing crystals + mushrooms by the walls, bones, rubble
  function caveDress(floor, water, cols, rows, res, r, R, prior, camp){ const W=cols*res;
    const cellFloor=(cx,cy)=>{ if(cx<0||cy<0||cx>=cols||cy>=rows) return false; for(let y=cy*res;y<cy*res+res;y++) for(let x=cx*res;x<cx*res+res;x++) if(!floor[y*W+x]||water[y*W+x]) return false; return true; };
    const open=(cx,cy)=>{ let n=0; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) if(cellFloor(cx+dx,cy+dy)) n++; return n; };
    const occ=new Set((prior||[]).map(f=>Math.floor(f.x)+','+Math.floor(f.y))), F=[];
    const put=(it)=>{ const k=Math.floor(it.x)+','+Math.floor(it.y); if(occ.has(k)||!cellFloor(Math.floor(it.x),Math.floor(it.y))) return false; occ.add(k); F.push(it); return true; };
    const inR=(x,y)=>x>=R.x0&&y>=R.y0&&x<R.x1&&y<R.y1;
    if(camp){ let c=null; for(let y=Math.max(1,R.y0);y<Math.min(rows-1,R.y1);y++) for(let x=Math.max(1,R.x0);x<Math.min(cols-1,R.x1);x++){ if(open(x,y)===9 && (c==null || r()<0.08)) c={x,y}; }
      if(c){ put({kind:'campfire',x:c.x+0.5,y:c.y+0.5,w:0.9,d:0.9}); for(const [dx,dy,w,d] of [[-1,0,0.6,1.5],[1,0,0.6,1.5],[0,1,1.5,0.6]]) if(cellFloor(c.x+dx,c.y+dy)) put({kind:'bedroll',x:c.x+dx+0.5,y:c.y+dy+0.5,w,d}); put({kind:'chest',x:c.x+0.5,y:c.y-0.5,w:0.9,d:0.6}); } }
    const edgeCells=[]; for(let y=R.y0;y<R.y1;y++) for(let x=R.x0;x<R.x1;x++) if(inR(x,y) && cellFloor(x,y) && open(x,y)<8) edgeCells.push({x,y});
    const pick=()=>edgeCells.splice(Math.floor(r()*edgeCells.length),1)[0], area=(R.x1-R.x0)*(R.y1-R.y0), k=Math.max(0.35,area/720);
    const nCry=Math.round((3+Math.floor(r()*4))*k), nMu=Math.round((3+Math.floor(r()*4))*k);
    for(let i=0;i<nCry && edgeCells.length;i++){ const c=pick(); put({kind:'crystals',x:c.x+0.5,y:c.y+0.5,w:0.7,d:0.7}); }
    for(let i=0;i<nMu && edgeCells.length;i++){ const c=pick(); put({kind:'mushrooms',x:c.x+0.5,y:c.y+0.5,w:0.6,d:0.6}); }
    for(let i=0;i<Math.round(3*k) && edgeCells.length;i++){ const c=pick(); put({kind:'bones',x:c.x+0.5,y:c.y+0.5,w:0.6,d:0.6}); }
    for(let i=0;i<Math.round(5*k) && edgeCells.length;i++){ const c=pick(); put({kind:'rubble',x:c.x+0.5,y:c.y+0.5,w:0.8,d:0.8}); }
    return F; }
  function caveOut(cols, rows, res, floor, water, features){ const W=cols*res, H=rows*res;
    const walls=msLoops(blur(floor,W,H,1),W,H,0.5).map(l=>l.map(p=>({x:p.x/res,y:p.y/res})));
    const waterLoops=msLoops(blur(water,W,H,1),W,H,0.5).map(l=>l.map(p=>({x:p.x/res,y:p.y/res})));
    return { kind:'cave', cols, rows, res, floor, water, walls, waterLoops, doors:[], rooms:[], features }; }
  function cave(cols, rows, seed){
    const res=3, W=cols*res, H=rows*res; let floor, tries=0, s=seed;
    for(;;){ const r=rng32(s); let m=new Array(W*H); for(let y=0;y<H;y++) for(let x=0;x<W;x++) m[y*W+x] = (x<2||y<2||x>=W-2||y>=H-2) ? 0 : (r()<0.53?1:0);   // 1 = floor
      m=caStep(m,W,H,(x,y)=>x>=2&&y>=2&&x<W-2&&y<H-2,6);
      const {lab,size}=labels(m,W,H); let best=0; size.forEach((n,i)=>{ if(n>size[best]) best=i; });   // keep the largest open region
      for(let k=0;k<W*H;k++) m[k] = lab[k]===best ? 1 : 0;
      const frac=(size[best]||0)/(W*H); floor=m; if((frac>0.34 && frac<0.62) || ++tries>10) break; s=(s*48271+11)>>>0; }
    const r=rng32(seed^0x5bd1e995);
    // an entrance tunnel from the cave to the nearest map edge
    { let bx=0,by=0,bd=1e9; for(let y=0;y<H;y++) for(let x=0;x<W;x++){ if(!floor[y*W+x]) continue; const d=Math.min(x,y,W-1-x,H-1-y); if(d<bd){ bd=d; bx=x; by=y; } }
      const dx = bx===Math.min(bx,by,W-1-bx,H-1-by)?-1 : (W-1-bx)===bd?1:0, dy = dx?0:(by===bd?-1:1);
      for(let t=0;t<=bd+1;t++){ const x=bx+dx*t, y=by+dy*t; for(let o=-1;o<=1;o++){ const X=x+(dy?o:0), Y=y+(dx?o:0); if(X>=0&&Y>=0&&X<W&&Y<H) floor[Y*W+X]=1; } } }
    const water=new Array(W*H).fill(0); pools(floor,water,W,H,r,1+Math.floor(r()*2),()=>true);
    return caveOut(cols,rows,res,floor,water, caveDress(floor,water,cols,rows,res,r,{x0:0,y0:0,x1:cols,y1:rows},[],true)); }
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
    let m=caStep(floor,W,H,(x,y)=>inside(x,y)&&nearSeam(x,y)&&!water[y*W+x],6,(x,y)=>!inNew(x,y));   // old cells: floor stays floor
    // everything must hang off the ORIGINAL cave: tunnel big pockets back, drop small ones
    for(let pass=0;pass<6;pass++){ const {lab,size}=labels(m,W,H); let main=-1;
      for(let y=0;y<H && main<0;y++) for(let x=0;x<W;x++){ if(!inNew(x,y) && D.floor[(y-oy*res)*OW+(x-ox*res)] && m[y*W+x]){ main=lab[y*W+x]; break; } }
      let changed=false; for(let id=0;id<size.length;id++){ if(id===main) continue; if(size[id]>=24){ if(tunnel(m,W,H,lab,id,main)){ changed=true; break; } } else { for(let k=0;k<W*H;k++) if(lab[k]===id) m[k]=0; } }
      if(!changed) break; }
    { const {lab}=labels(m,W,H); let main=-1; for(let k=0;k<W*H && main<0;k++){ const x=k%W,y=(k/W)|0; if(m[k]&&!inNew(x,y)&&D.floor[(y-oy*res)*OW+(x-ox*res)]) main=lab[k]; }
      for(let k=0;k<W*H;k++) if(m[k] && lab[k]!==main){ const x=k%W,y=(k/W)|0; if(inNew(x,y)||!D.floor[(y-oy*res)*OW+(x-ox*res)]) m[k]=0; } }   // final sweep: no stray pockets
    // no new cave reached the strip? force one tunnel in from the old cave
    let any=false; for(let y=sy0;y<sy1&&!any;y++) for(let x=sx0;x<sx1;x++) if(m[y*W+x]){ any=true; break; }
    if(!any){ const cxs=(sx0+sx1)>>1, cys=(sy0+sy1)>>1; for(let dy=-4;dy<=4;dy++) for(let dx=-4;dx<=4;dx++) if(inside(cxs+dx,cys+dy)) m[(cys+dy)*W+cxs+dx]=1; const {lab}=labels(m,W,H); let main=-1; for(let k=0;k<W*H && main<0;k++) if(m[k]&&!inNew(k%W,(k/W)|0)) main=lab[k]; tunnel(m,W,H,lab,lab[cys*W+cxs],main); }
    pools(m,water,W,H,r,r()<0.6?1:0,(x,y)=>inNew(x,y));
    const moved=D.features.map(f=>({...f,x:f.x+ox,y:f.y+oy}));
    return caveOut(cols,rows,res,m,water, moved.concat(caveDress(m,water,cols,rows,res,r,R,moved, r()<0.35))); }

  // EXTEND any layout by E squares toward dir (N/S/E/W). Old content keeps its place (shifted when growing W/N).
  function extend(D, dir, E, seed){ E=Math.max(6,E|0||12);
    const cols=D.cols+(dir==='E'||dir==='W'?E:0), rows=D.rows+(dir==='N'||dir==='S'?E:0), ox=dir==='W'?E:0, oy=dir==='N'?E:0;
    const R = dir==='E'?{x0:D.cols,y0:0,x1:cols,y1:rows} : dir==='W'?{x0:0,y0:0,x1:E,y1:rows} : dir==='S'?{x0:0,y0:D.rows,x1:cols,y1:rows} : {x0:0,y0:0,x1:cols,y1:E};
    if(D.kind==='cave') return caveExtend(D,cols,rows,ox,oy,R,seed);
    const floor=new Array(cols*rows).fill(0); for(let y=0;y<D.rows;y++) for(let x=0;x<D.cols;x++) floor[(y+oy)*cols+x+ox]=D.floor[y*D.cols+x];
    const base={ floor, rooms:D.rooms.map(o=>({...o,x:o.x+ox,y:o.y+oy})), doors:D.doors.map(d=>({...d,x1:d.x1+ox,x2:d.x2+ox,y1:d.y1+oy,y2:d.y2+oy})),
      features:D.features.map(f=>({...f,x:f.x+ox,y:f.y+oy})), region:{x0:Math.max(2,R.x0), y0:Math.max(2,R.y0), x1:Math.min(cols-2,R.x1), y1:Math.min(rows-2,R.y1)} };
    let best=null; for(let t=0;t<6;t++){ const g=dungeon(cols,rows,(seed+t*7919)>>>0,base); if(!best||g.newRooms>best.newRooms) best=g; if(g.newRooms>=2) break; }
    return best; }

  root.DungeonGen = { generate(o){ o=o||{}; const cols=Math.max(12,o.cols|0||30), rows=Math.max(10,o.rows|0||24), seed=(o.seed>>>0)||1;
      if(o.kind==='cave') return cave(cols,rows,seed);
      let best=null; for(let t=0;t<8;t++){ const g=dungeon(cols,rows,(seed+t*7919)>>>0); if(!best||g.rooms.length>best.rooms.length) best=g; if(g.rooms.length>=Math.min(4,Math.max(3,Math.round(cols*rows/120)))) return g; } return best; },   // retry a cramped layout
    extend, gridLoops, msLoops };
})(typeof self!=='undefined' ? self : this);
