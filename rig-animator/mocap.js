// ===== 🎥 MOTION FROM VIDEO (2026-09-30) =====
// A video of a person (a file, or recorded with the camera) becomes a GLB Studio motion, entirely in the browser: Google's free
// MediaPipe pose + hand trackers (loaded from the CDN, run on this computer — the video never leaves it) give 3-D body and finger
// points for every frame; those are turned into bone rotations for the Animator's biped / fingered-biped rig and stored as one of
// "My motions" — so it plays here, can be edited with ✏, and ➕ Add sends it to the Studio Library / Stitcher like any other motion.
//
// How the solve works (directions only, so the person's size never matters):
//   • every point is turned into this rig's frame (MediaPipe's y-down camera axes → y-up, then turned about the vertical so the
//     person's average facing = the rig's forward) and smoothed over time;
//   • each frame starts from the rig's rest pose and turns bones top-down: hips (hip line + torso up), the three spine bones
//     share the chest's remaining turn, neck/head from the ears + nose, each arm/leg is AIMED at the next joint with its bend
//     plane set by the joint below (elbow / knee), hands from the wrist→knuckles line + the knuckle line, feet at the toes,
//     fingers segment by segment (fingered rigs, when a hand is seen);
//   • then the body is lowered/raised so the lowest foot stands on the floor.
import * as THREE from 'three';

const MP_VER = '1.0.1';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MODELS = {
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
};
// MediaPipe pose indices ("left" = the person's own left)
const P = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };
const SWAP = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
// hand landmark chains (21 points): thumb 1-4, index 5-8, middle 9-12, ring 13-16, pinky 17-20
const FCH = { Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12], Ring: [13, 14, 15, 16], Pinky: [17, 18, 19, 20] };

let _vision = null, _pose = null, _hand = null;
async function loadTrackers(onStatus, wantHands) {
  if (!_vision) { onStatus && onStatus('Loading the free pose tracker (first time only)…');
    const mod = await import(`${MP_BASE}/vision_bundle.mjs`); _vision = { mod, files: await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`) }; }
  const { mod, files } = _vision;
  const mk = async (Cls, url, extra) => { for (const delegate of ['GPU', 'CPU']) { try { return await Cls.createFromOptions(files, { baseOptions: { modelAssetPath: url, delegate }, runningMode: 'VIDEO', ...extra }); } catch (e) { if (delegate === 'CPU') throw e; } } };
  if (!_pose) _pose = await mk(mod.PoseLandmarker, MODELS.pose, { numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  if (wantHands && !_hand) { onStatus && onStatus('Loading the free hand tracker…'); _hand = await mk(mod.HandLandmarker, MODELS.hand, { numHands: 2, minHandDetectionConfidence: 0.4, minTrackingConfidence: 0.4 }); }
}

// ---- 1) track: video → per-frame points (in the rig's y-up frame, not yet turned to face forward) ----
// returns { fps, frames:[{ pose:[[x,y,z,vis]×33] | null, img:[[x,y]×33] | null, hands:{L:[[x,y,z]×21]|null, R:…} }] }
export async function trackVideo(src, opts, onProgress) {
  const o = Object.assign({ fps: 30, maxSec: 20, start: 0, end: null, hands: true, mirror: false }, opts || {});
  await loadTrackers(onProgress && (s => onProgress(0, s)), o.hands);
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.crossOrigin = 'anonymous';
  // a video given by address is read into memory first: seeking needs byte-range support, which simple local servers lack
  if (typeof src === 'string') src = await (await fetch(src)).blob();
  video.src = URL.createObjectURL(src);
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('This video could not be opened (try an .mp4 or .webm).')); });
  if (!isFinite(video.duration)) { video.currentTime = 1e9; await new Promise(r => { video.onseeked = r; }); }   // webm from MediaRecorder: duration unknown until seeked
  const t0 = Math.max(0, o.start || 0), t1 = Math.min(video.duration, o.end != null ? o.end : video.duration, t0 + o.maxSec);
  const n = Math.max(2, Math.floor((t1 - t0) * o.fps)); const frames = [];
  // each frame: seek, wait until that frame is really on screen, then copy it to a canvas and track the canvas
  // (tracking the <video> straight after a seek can read the previous frame again — every frame then looks the same)
  const cv = document.createElement('canvas'); const sc = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  cv.width = Math.round(video.videoWidth * sc); cv.height = Math.round(video.videoHeight * sc); const g = cv.getContext('2d', { willReadFrequently: true });
  const seek = t => new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } };
    video.onseeked = () => { if (video.requestVideoFrameCallback) { video.requestVideoFrameCallback(() => fin()); setTimeout(fin, 250); } else setTimeout(fin, 30); };
    video.currentTime = t; });
  for (let i = 0; i < n; i++) {
    await seek(t0 + i / o.fps); const ts = Math.round(1 + i * 1000 / o.fps);
    g.drawImage(video, 0, 0, cv.width, cv.height);
    const pr = _pose.detectForVideo(cv, ts); const fr = { pose: null, img: null, hands: { L: null, R: null } };
    if (pr && pr.worldLandmarks && pr.worldLandmarks[0]) {
      fr.pose = pr.worldLandmarks[0].map(l => [l.x, -l.y, -l.z, l.visibility == null ? 1 : l.visibility]);   // camera y-down → y-up (a turn about x: no mirror)
      fr.img = pr.landmarks[0].map(l => [l.x, l.y]); }
    if (o.hands && _hand && fr.img) {
      const hr = _hand.detectForVideo(cv, ts);
      (hr.worldLandmarks || []).forEach((wl, k) => { const w = hr.landmarks[k][0];   // match each hand to the nearer body wrist on screen (MediaPipe's own left/right label assumes a mirrored selfie)
        const dL = Math.hypot(w.x - fr.img[P.lWr][0], w.y - fr.img[P.lWr][1]), dR = Math.hypot(w.x - fr.img[P.rWr][0], w.y - fr.img[P.rWr][1]);
        const side = dL < dR ? 'L' : 'R'; if (Math.min(dL, dR) > 0.12) return; if (!fr.hands[side]) fr.hands[side] = wl.map(l => [l.x, -l.y, -l.z]); }); }
    if (o.mirror) mirrorFrame(fr);
    frames.push(fr); onProgress && onProgress((i + 1) / n, `Tracking the video… ${i + 1} / ${n} frames`);
  }
  URL.revokeObjectURL(video.src);
  return { fps: o.fps, frames };
}
function mirrorFrame(fr) {   // a selfie / mirrored video: flip left↔right
  if (fr.pose) { for (const p of fr.pose) p[0] = -p[0]; for (const [a, b] of SWAP) { const t = fr.pose[a]; fr.pose[a] = fr.pose[b]; fr.pose[b] = t; } }
  if (fr.img) { for (const p of fr.img) p[0] = 1 - p[0]; for (const [a, b] of SWAP) { const t = fr.img[a]; fr.img[a] = fr.img[b]; fr.img[b] = t; } }
  const L = fr.hands.L, R = fr.hands.R; fr.hands.L = R; fr.hands.R = L;
  for (const h of [fr.hands.L, fr.hands.R]) if (h) for (const p of h) p[0] = -p[0];
}

// ---- 2) clean up: fill gaps, smooth, turn the person to face the rig's forward ----
function smoothTracks(frames, key, nPts, win) {
  const N = frames.length, has = frames.map(f => !!(key === 'pose' ? f.pose : f.hands[key]));
  const get = i => key === 'pose' ? frames[i].pose : frames[i].hands[key];
  // fill a missing frame from the nearest seen frames (short gaps only), so smoothing and the solve always have points
  for (let i = 0; i < N; i++) if (!has[i]) { let a = i - 1, b = i + 1; while (a >= 0 && !has[a]) a--; while (b < N && !has[b]) b++;
    if ((a < 0 && b >= N) || Math.min(a < 0 ? 1e9 : i - a, b >= N ? 1e9 : b - i) > 15) continue;
    const A = a >= 0 ? get(a) : null, B = b < N ? get(b) : null, f = A && B ? (i - a) / (b - a) : 0;
    const fill = (A || B).map((p, k) => p.map((v, c) => A && B ? A[k][c] + (B[k][c] - A[k][c]) * f : v));
    if (key === 'pose') frames[i].pose = fill; else frames[i].hands[key] = fill; }
  const src = frames.map((f, i) => get(i) ? get(i).map(p => p.slice()) : null);
  const w = []; for (let k = -win; k <= win; k++) w.push(Math.exp(-(k * k) / (2 * (win / 2) ** 2)));
  for (let i = 0; i < N; i++) { const cur = get(i); if (!cur) continue;
    for (let k = 0; k < nPts; k++) for (let c = 0; c < 3; c++) { let s = 0, ws = 0;
      for (let d = -win; d <= win; d++) { const j = i + d; if (j < 0 || j >= N || !src[j]) continue; const wt = w[d + win] * (key === 'pose' ? Math.max(0.05, src[j][k][3] ?? 1) : 1); s += src[j][k][c] * wt; ws += wt; }
      if (ws > 0) cur[k][c] = s / ws; } }
}
// BONE LENGTHS: one camera sees depth poorly — a squat's knees come TOWARD the lens, the tracker under-reads that, and the legs
// look straight. A thigh or shin never changes length, so each segment's true length is taken from the frames where it looks
// longest (95th percentile), and a segment that looks shorter gets the missing length back as DEPTH (along the camera axis, z,
// before the person is turned to face forward). The joints below it move with it. The depth keeps the tracker's sign; when the
// tracker has none, a knee goes forward (the facing f), an ankle back, an elbow / wrist toward the camera.
function fixLengths(F, f) {
  const fz = Math.sign(f.z) || 1;
  const CH = [[P.lHip, P.lKnee, P.lAnk, [P.lHeel, P.lToe], fz, -fz], [P.rHip, P.rKnee, P.rAnk, [P.rHeel, P.rToe], fz, -fz],
    [P.lSh, P.lEl, P.lWr, [P.lPinky, P.lIndex, 21], 1, 1], [P.rSh, P.rEl, P.rWr, [P.rPinky, P.rIndex, 22], 1, 1]];
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const hipZ = fr => (fr.pose[P.lHip][2] + fr.pose[P.rHip][2]) / 2;
  for (const [a, b, c, tail, s1, s2] of CH) {
    const ref = [[a, b], [b, c]].map(([u, v]) => { const ls = F.filter(fr => fr.pose).map(fr => len(fr.pose[u], fr.pose[v])).sort((x, y) => x - y); return ls.length ? ls[Math.floor(ls.length * 0.95)] : 0; });
    const leg = a === P.lHip || a === P.rHip;
    for (const fr of F) { const p = fr.pose; if (!p) continue;
      if (leg && ref[0] > 0 && ref[1] > 0) {
        // LEGS: the knee's and ankle's depth are CHOSEN, not copied — the tracker often puts a squat's knees and feet behind the
        // hips. Every sign combination that keeps the real thigh / shin lengths is tried; a knee may only bend one way (the
        // shin swings back from the thigh); then the cheapest wins: near the tracker's own depth, the feet near under the
        // hips (standing balance), and a small cost for a knee behind the hip (hip flexion is far more common than extension).
        const H = p[a], K = p[b], A = p[c], fz2 = f.z >= 0 ? 1 : -1;
        const ft = Math.hypot(K[0] - H[0], K[1] - H[1]), fs = Math.hypot(A[0] - K[0], A[1] - K[1]);
        const ta = Math.sqrt(Math.max(0, ref[0] ** 2 - ft ** 2)), sb = Math.sqrt(Math.max(0, ref[1] ** 2 - fs ** 2));
        const zk0 = K[2] - H[2], za0 = A[2] - H[2], hz = hipZ(fr) - H[2];
        const sideX = a === P.lHip ? 1 : -1;   // the leg's own outward axis (x) — flexion turns the shin back about it
        let best = null;
        for (const sk of [1, -1]) for (const sa of [1, -1]) {
          const zk = sk * ta, za = zk + sa * sb;
          const th = [K[0] - H[0], K[1] - H[1], zk], sh = [A[0] - K[0], A[1] - K[1], za - zk];
          const flex = (th[1] * sh[2] - th[2] * sh[1]) * fz2;   // x of thigh × shin, facing-corrected: + = the knee bends the right way
          if (flex < -0.002 * ref[0] * ref[1] * 10) continue;
          const cost = Math.abs(zk - zk0) + Math.abs(za - za0) + 1.2 * Math.max(0, Math.abs((za - hz) * fz2) - 0.12) + (zk * fz2 < -0.05 ? 0.3 : 0);
          if (!best || cost < best.cost) best = { cost, zk, za }; }
        if (best) { const dk = best.zk - zk0, da = best.za - za0; K[2] += dk; A[2] += da; for (const k of tail) p[k][2] += da; }
        void sideX; continue; }
      [[a, b, [c, ...tail], ref[0], s1], [b, c, tail, ref[1], s2]].forEach(([u, v, below, Lr, sg]) => {
        const d = [p[v][0] - p[u][0], p[v][1] - p[u][1], p[v][2] - p[u][2]], l = Math.hypot(...d); if (!(Lr > 0) || l >= 0.97 * Lr) return;
        const flat = Math.hypot(d[0], d[1]); if (flat >= Lr) return;
        const dz = Math.sqrt(Lr * Lr - flat * flat) * (Math.abs(d[2]) > 0.02 * Lr ? Math.sign(d[2]) : sg), shift = dz - d[2];
        for (const k of [v, ...below]) p[k][2] += shift; }); } }
}
export function prepare(track, rigFwd) {
  const F = track.frames;
  smoothTracks(F, 'pose', 33, 3); smoothTracks(F, 'L', 21, 2); smoothTracks(F, 'R', 21, 2);
  // the person's average facing (hip + shoulder lines × up), over the whole clip
  const f = new THREE.Vector3(); for (const fr of F) { if (!fr.pose) continue; const p = fr.pose;
    const left = new THREE.Vector3(p[P.lHip][0] - p[P.rHip][0] + p[P.lSh][0] - p[P.rSh][0], 0, p[P.lHip][2] - p[P.rHip][2] + p[P.lSh][2] - p[P.rSh][2]);
    f.add(left.cross(new THREE.Vector3(0, 1, 0)).normalize()); }
  fixLengths(F, f);
  const turn = f.lengthSq() > 1e-6 ? Math.atan2(rigFwd.x, rigFwd.z) - Math.atan2(f.x, f.z) : 0, c = Math.cos(turn), s = Math.sin(turn);
  const rot = p => { const x = p[0] * c + p[2] * s, z = -p[0] * s + p[2] * c; p[0] = x; p[2] = z; };
  for (const fr of F) { if (fr.pose) fr.pose.forEach(rot); for (const h of ['L', 'R']) if (fr.hands[h]) fr.hands[h].forEach(rot); }
  return track;
}

// ---- 3) solve: points → bone rotations on the Animator rig ----
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();
function basis(a, b, m) { const x = a.clone().normalize(), z = new THREE.Vector3().crossVectors(x, b).normalize(), y = new THREE.Vector3().crossVectors(z, x); return m.makeBasis(x, y, z); }
function frameRot(a0, b0, a1, b1) {   // rotation taking frame (a0 primary, b0 secondary) onto (a1, b1)
  basis(a0, b0, _m0); basis(a1, b1, _m1); return new THREE.Quaternion().setFromRotationMatrix(_m1.multiply(_m0.transpose())); }
function turnWorld(bone, R, frac) {   // rotate a bone by R (a WORLD rotation, optionally only part of it) keeping its parent
  const q = frac == null || frac >= 1 ? R : new THREE.Quaternion().slerp(R, frac);
  const w = bone.getWorldQuaternion(new THREE.Quaternion()), pw = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(pw.invert().multiply(q.clone().multiply(w))); bone.updateMatrixWorld(true); }
const WP = b => b.getWorldPosition(new THREE.Vector3());
const ok = v => v && isFinite(v.x) && v.lengthSq() > 1e-10;

export function makeSolver(ctx) {
  // ctx: { bones:{name→Bone}, list:[names], resetPose(), animRoot }
  const B = ctx.bones;
  ctx.resetPose(); ctx.animRoot.updateMatrixWorld(true);
  const need = ['Hips', 'Spine', 'Spine01', 'Spine02', 'neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
  const missing = need.filter(n => !B[n]); if (missing.length) throw new Error('This rig is not a biped (missing ' + missing.join(', ') + ').');
  // rig facing, from its own rest pose
  const up = new THREE.Vector3(0, 1, 0);
  const left = WP(B.LeftUpLeg).sub(WP(B.RightUpLeg)).setY(0).normalize();
  const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
  const toes = WP(B.LeftToeBase).add(WP(B.RightToeBase)).sub(WP(B.LeftFoot)).sub(WP(B.RightFoot)).setY(0);
  if (toes.dot(fwd) < 0) fwd.negate();   // skeletons whose "Left" is on screen-left: trust the toes
  // vectors carried in each bone's own frame (so we always know where "its" forward / thumb side is now)
  const carry = {};
  const keep = (name, key, worldVec) => { const q = B[name].getWorldQuaternion(new THREE.Quaternion()).invert(); (carry[name] = carry[name] || {})[key] = worldVec.clone().normalize().applyQuaternion(q); };
  const now = (name, key) => carry[name][key].clone().applyQuaternion(B[name].getWorldQuaternion(new THREE.Quaternion()));
  keep('Hips', 'left', left); keep('Hips', 'up', up);
  keep('Spine02', 'left', left); keep('Spine02', 'up', up);
  keep('Head', 'left', left); keep('Head', 'fwd', fwd);
  for (const s of ['Left', 'Right']) {
    keep(s + 'Arm', 'bend', fwd);            // an elbow bends the forearm forward from the rest pose
    keep(s + 'UpLeg', 'bend', fwd.clone().negate());   // a knee bends the shin backward
    const hand = B[s + 'Hand'], mid = B[s + 'HandMiddle1'], i1 = B[s + 'HandIndex1'], p1 = B[s + 'HandPinky1'];
    keep(s + 'Hand', 'dir', mid ? WP(mid).sub(WP(hand)) : WP(hand).sub(WP(B[s + 'ForeArm'])));
    keep(s + 'Hand', 'thumb', i1 && p1 ? WP(i1).sub(WP(p1)) : fwd);
    for (const fn of Object.keys(FCH)) for (let k = 1; k <= 3; k++) { const b = B[s + 'Hand' + fn + k]; if (!b) continue;
      const nx = B[s + 'Hand' + fn + (k + 1)], pv = B[s + 'Hand' + fn + (k - 1)];
      const d = nx ? WP(nx).sub(WP(b)) : pv ? WP(b).sub(WP(pv)) : WP(b).sub(WP(hand)); keep(b.name, 'dir', d); } }
  const floor0 = Math.min(...['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map(n => WP(B[n]).y));
  const hasFingers = !!B.LeftHandIndex1;

  function aim(name, childName, target, bendKey, bendTarget) {   // point a bone at `target`, optionally setting its roll by a bend direction
    const b = B[name]; if (!b || !ok(target)) return;
    const cur = childName ? WP(B[childName]).sub(WP(b)) : now(name, 'dir');
    if (bendKey && ok(bendTarget)) { turnWorld(b, frameRot(cur, now(name, bendKey), target, bendTarget)); return; }
    turnWorld(b, new THREE.Quaternion().setFromUnitVectors(cur.normalize(), target.clone().normalize())); }

  function solve(fr) {
    ctx.resetPose(); ctx.animRoot.updateMatrixWorld(true);
    const p = fr.pose; if (!p) return false; const L = i => V(p[i]);
    const hipL = L(P.lHip), hipR = L(P.rHip), shL = L(P.lSh), shR = L(P.rSh), hipM = hipL.clone().add(hipR).multiplyScalar(0.5), shM = shL.clone().add(shR).multiplyScalar(0.5);
    const torsoUp = shM.clone().sub(hipM);
    // hips, then the chest's remaining turn shared by the three spine bones
    turnWorld(B.Hips, frameRot(now('Hips', 'up'), now('Hips', 'left'), torsoUp, hipL.clone().sub(hipR)));
    const chestLeft = shL.clone().sub(shR);
    for (const [bn, frac] of [['Spine', 1 / 3], ['Spine01', 1 / 2], ['Spine02', 1]]) turnWorld(B[bn], frameRot(now('Spine02', 'up'), now('Spine02', 'left'), torsoUp, chestLeft), frac);
    // neck + head: ears give the head's left, the nose its forward
    const earL = L(P.lEar), earR = L(P.rEar), earM = earL.clone().add(earR).multiplyScalar(0.5), hLeft = earL.clone().sub(earR), hFwd = L(P.nose).sub(earM);
    hFwd.sub(hLeft.clone().multiplyScalar(hFwd.dot(hLeft) / (hLeft.lengthSq() || 1)));
    if (ok(hLeft) && ok(hFwd)) { turnWorld(B.neck, frameRot(now('Head', 'left'), now('Head', 'fwd'), hLeft, hFwd), 0.5); turnWorld(B.Head, frameRot(now('Head', 'left'), now('Head', 'fwd'), hLeft, hFwd)); }
    for (const [s, sh, el, wr, ix, pk, hip, kn, an, he, to] of [['Left', P.lSh, P.lEl, P.lWr, P.lIndex, P.lPinky, P.lHip, P.lKnee, P.lAnk, P.lHeel, P.lToe], ['Right', P.rSh, P.rEl, P.rWr, P.rIndex, P.rPinky, P.rHip, P.rKnee, P.rAnk, P.rHeel, P.rToe]]) {
      // ARM: the upper arm's bend plane comes from the forearm; when the arm is nearly straight, from the thumb side of the hand
      const ua = L(el).sub(L(sh)), fa = L(wr).sub(L(el)), hand = fr.hands[s[0]];
      const knM = L(ix).add(L(pk)).multiplyScalar(0.5); let thumb = L(ix).sub(L(pk)), hdir = knM.sub(L(wr));
      if (hand) { const H = i => V(hand[i]); hdir = H(9).sub(H(0)); thumb = H(5).sub(H(17)); }
      const bendA = fa.clone().sub(ua.clone().multiplyScalar(fa.dot(ua) / (ua.lengthSq() || 1))); const wA = Math.min(1, bendA.length() / (0.35 * (fa.length() || 1)));
      const tA = thumb.clone().sub(ua.clone().multiplyScalar(thumb.dot(ua) / (ua.lengthSq() || 1)));
      const bendDir = ok(bendA) ? bendA.clone().normalize().multiplyScalar(wA).add(ok(tA) ? tA.clone().normalize().multiplyScalar(1 - wA) : new THREE.Vector3()) : tA;
      aim(s + 'Arm', s + 'ForeArm', ua, 'bend', bendDir);
      aim(s + 'ForeArm', s + 'Hand', fa);
      if (ok(hdir) && ok(thumb)) turnWorld(B[s + 'Hand'], frameRot(now(s + 'Hand', 'dir'), now(s + 'Hand', 'thumb'), hdir, thumb));
      // FINGERS (fingered rigs, when the hand tracker saw this hand): each segment aimed at the next knuckle
      if (hasFingers && hand) { const H = i => V(hand[i]);
        for (const [fn, ch] of Object.entries(FCH)) for (let k = 1; k <= 3; k++) { const bn = s + 'Hand' + fn + k; if (!B[bn]) continue;
          const nx = B[s + 'Hand' + fn + (k + 1)]; aim(bn, nx ? nx.name : null, H(ch[k]).sub(H(ch[k - 1]))); } }
      // LEG: thigh aimed at the knee, its bend plane from the shin (or, leg straight, from the toes); shin at the ankle; foot at the toes
      const th = L(kn).sub(L(hip)), sh2 = L(an).sub(L(kn)), toeDir = L(to).sub(L(he));
      const bendL = sh2.clone().sub(th.clone().multiplyScalar(sh2.dot(th) / (th.lengthSq() || 1))); const wL = Math.min(1, bendL.length() / (0.25 * (sh2.length() || 1)));
      const tL = toeDir.clone().negate().sub(th.clone().multiplyScalar(-toeDir.dot(th) / (th.lengthSq() || 1)));
      const bendDirL = ok(bendL) ? bendL.clone().normalize().multiplyScalar(wL).add(ok(tL) ? tL.clone().normalize().multiplyScalar(1 - wL) : new THREE.Vector3()) : tL;
      aim(s + 'UpLeg', s + 'Leg', th, 'bend', bendDirL);
      aim(s + 'Leg', s + 'Foot', sh2);
      aim(s + 'Foot', s + 'ToeBase', L(to).sub(L(an)));
    }
    // stand on the floor: the lowest foot point touches the rest pose's floor
    ctx.animRoot.updateMatrixWorld(true);
    const low = Math.min(...['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map(n => WP(B[n]).y));
    ctx.animRoot.position.y += floor0 - low; ctx.animRoot.updateMatrixWorld(true);
    return true;
  }
  return { solve, fwd, hasFingers };
}

// ---- 4) the whole thing: video → a "My motions" record ----
// record: { id, name, rig, kind:'mocap', fps, dur, bones:[names], q:{name:[x,y,z,w,…]} (4-decimal), rootY:[…], saved }
export async function videoToMotion(src, ctx, opts, onProgress) {
  const solver = makeSolver(ctx);
  const track = await trackVideo(src, Object.assign({ hands: solver.hasFingers }, opts), onProgress);
  const seen = track.frames.filter(f => f.pose).length;
  if (seen < Math.max(5, track.frames.length * 0.4)) throw new Error('No person was found in most of this video. Film the whole body, head to feet, with good light and the camera still.');
  prepare(track, solver.fwd);
  const bones = ctx.list.slice(), q = {}; for (const b of bones) q[b] = []; const rootY = [];
  let last = null;
  track.frames.forEach((fr, i) => { onProgress && onProgress(i / track.frames.length, 'Building the motion…');
    const good = solver.solve(fr);
    if (!good && last) { for (const b of bones) q[b].push(...last.q[b]); rootY.push(last.y); return; }
    const snap = { q: {}, y: +ctx.animRoot.position.y.toFixed(4) };
    for (const b of bones) { const Q = ctx.bones[b].quaternion; snap.q[b] = [+Q.x.toFixed(4), +Q.y.toFixed(4), +Q.z.toFixed(4), +Q.w.toFixed(4)]; q[b].push(...snap.q[b]); }
    rootY.push(snap.y); last = snap; });
  ctx.resetPose();
  // drop bones that never move (keeps the saved record small)
  const still = bones.filter(b => { const a = q[b]; for (let i = 4; i < a.length; i += 4) if (Math.abs(a[i] - a[0]) + Math.abs(a[i + 1] - a[1]) + Math.abs(a[i + 2] - a[2]) + Math.abs(a[i + 3] - a[3]) > 1e-3) return false; return true; });
  for (const b of still) { q[b] = q[b].slice(0, 4); }
  return { kind: 'mocap', fps: track.fps, dur: +(track.frames.length / track.fps).toFixed(3), bones, q, rootY, seen, frames: track.frames.length };
}

// playback of a saved record on the Animator rig (called from the motion's build(t))
export function applyRecord(rec, t, ctx) {
  const n = rec.rootY.length; const x = Math.max(0, Math.min(n - 1, t * rec.fps)); const i = Math.floor(x), f = x - i, j = Math.min(n - 1, i + 1);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  for (const b of rec.bones) { const bone = ctx.bones[b]; const a = rec.q[b]; if (!bone || !a) continue;
    if (a.length === 4) { bone.quaternion.set(a[0], a[1], a[2], a[3]); continue; }
    qa.fromArray(a, i * 4); qb.fromArray(a, j * 4); bone.quaternion.copy(qa).slerp(qb, f); }
  ctx.animRoot.position.y = rec.rootY[i] + (rec.rootY[j] - rec.rootY[i]) * f;
}
