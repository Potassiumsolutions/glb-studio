// Merge a Rig Animator pack (rig-anim-pack.json) into the GLB Stitcher motion library.
// Usage:  node merge-into-stitcher.mjs [pack.json] ["path/to/GLB Stitcher/library"]
import fs from 'fs';
import path from 'path';

const packPath = process.argv[2] || 'rig-anim-pack.json';
const libDir   = process.argv[3] || '../GLB Stitcher/library';

if(!fs.existsSync(packPath)){ console.error('Pack not found:', packPath); process.exit(1); }
if(!fs.existsSync(path.join(libDir,'index.json'))){ console.error('Stitcher library not found at:', libDir); process.exit(1); }

const pack  = JSON.parse(fs.readFileSync(packPath,'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(libDir,'index.json'),'utf8'));
const posesPath = path.join(libDir,'poses.json');
const poses = fs.existsSync(posesPath) ? JSON.parse(fs.readFileSync(posesPath,'utf8')) : {};
const mDir  = path.join(libDir,'m'); if(!fs.existsSync(mDir)) fs.mkdirSync(mDir,{recursive:true});

index.skeletons = index.skeletons || {};
index.motions   = index.motions   || [];

let addedSk=0, addedMo=0, skippedMo=0, wroteClips=0;

// 1) skeletons (add new sigs only — never clobber an existing one)
for(const [sig,sk] of Object.entries(pack.skeletons||{})){
  if(!index.skeletons[sig]){ index.skeletons[sig]=sk; addedSk++; }
}
// 2) motions + clip shards + poses
const have = new Set(index.motions.map(m=>m.id));
for(const m of pack.motions||[]){
  if(have.has(m.id)){ skippedMo++; continue; }
  index.motions.push(m); have.add(m.id); addedMo++;
  if(pack.clips && pack.clips[m.id]){ fs.writeFileSync(path.join(mDir,m.id+'.json'), JSON.stringify(pack.clips[m.id])); wroteClips++; }
  if(pack.poses && pack.poses[m.id]){ poses[m.id]=pack.poses[m.id]; }
}

fs.writeFileSync(path.join(libDir,'index.json'), JSON.stringify(index));
fs.writeFileSync(posesPath, JSON.stringify(poses));

console.log(`Merged into ${libDir}`);
console.log(`  + ${addedSk} skeleton(s), + ${addedMo} motion(s) (${skippedMo} already present), ${wroteClips} clip shard(s) written.`);
console.log(`  library now has ${index.motions.length} motions across ${Object.keys(index.skeletons).length} skeletons.`);
