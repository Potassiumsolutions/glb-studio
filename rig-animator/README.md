# 🐾 Rig Animator

Procedurally generate animations for your **quadruped** and **bird** rigs, then import them into the
**GLB Stitcher** motion library so they work exactly like the 579 biped ones.

## Run
Double-click **`Start Rig Animator.bat`** (or `python -m http.server 8779` in this folder) and open
<http://localhost:8779>. A local server is only needed so the ES-module build loads.

## Use
1. Pick a **rig type**: Quadruped (27-bone), Bird — flight (35-bone UniRig, wings spread), or Bird — perched (wings folded).
2. Click an **animation** in the list — it plays on a proxy creature (capsule limbs). Drag to orbit, wheel to zoom.
3. **Tune** Speed / Amplitude / Loop length; scrub or play/pause/loop with the bar.
4. **➕ Add current animation to pack** for each one you like (tweaks are baked in).
5. **⬇ Download library pack** → `rig-anim-pack.json`.
6. In this folder run:
   ```
   node merge-into-stitcher.mjs rig-anim-pack.json
   ```
   That adds the skeletons + motions + clip shards + pose signatures into `../GLB Stitcher/library/`.
7. In GLB Stitcher, load a quadruped/bird character as the motion-library **rig** — the list now shows *its* animations, retargeted by bone name.

## Animations included
- **Quadruped:** Idle, Walk, Trot, Gallop/run, Jump, Sit, Graze, Look around, Tail wag.
- **Bird (flight):** Flap (cruise), Glide, Take off, Dive, Land (flare), Hover.
- **Bird (perched):** Idle, Peck, Hop, Look around, Preen, Ruffle, Take off.

Motions are procedural (sinusoidal bone rotations authored in world-space axes → each bone's local frame),
so a `move` clip animates in place; the Stitcher's travel/scenery-scroll carries it across the scene like the biped clips.

## Notes
- Rig templates are injected from the Character Rigger by `inject.mjs` (re-run it if those templates change).
- Bakes at 30 fps into standard `AnimationClip.toJSON` shards, matching the Stitcher library format.
- The merge is additive and idempotent (re-running skips motions already present).

## Authoring rules for biped motions (2026-09-03 physics pass)

These are the conventions a generated motion has to follow so it comes out physically right without hand-tuning.
The four audits in `tools/verify/` are the acceptance tests: `bodyclip.mjs` (limb through torso/head),
`flipscan.mjs` (single-frame hand flips vs a baseline library), `coherence.mjs` (chest coiled against the hands,
spine/neck limits) and `physics.mjs` (joint limits, feet through/above the floor).

- **Axes.** The character faces **+Z**; **+X is its LEFT**. A rotation about +Y by a positive angle turns it to its
  **left**. A right hand's own side is **−X**: a right hand "at the hip" is `V(-0.2, 1.0, 0.1)`, never `V(+0.2, …)`.
  `plantFeet(zLeft, zRight)`. `B_LARM.s = +1`, `B_RARM.s = -1`.
- **Stances.** `fightStance` / `boxStance` blade to the RIGHT (lead left shoulder forward, left foot forward);
  `fenceGuard` blades LEFT (right foot and right shoulder forward). Use them; do not re-derive the turn sign.
- **Coil with the hands.** A swing, throw or put turns the hips and (further) the chest TOWARD the loaded hands, then
  unwinds past them: `sw('Hips',AX.y, -a*load + b*strike)` and `twist(-c*load + d*strike)` for a right-hander loading
  to the right. After a release the body stays open — do not let a `bump()` tail re-coil it.
- **Hand paths, not shoulder angles.** Put hands on paths with `reachIK`. Two-point moves: `orbitLerp(from, to, k, {arms:[Ar]})`;
  multi-key: `orbitAt(keys, u, {arms})`; two-hand grips: `grip(orbitAt(keys, u, {arms:[B_LARM,B_RARM]}), pole)`.
  These keep the hand outside the torso/head, keep the shoulder→hand line clear of the chest (a crossing hand goes IN
  FRONT of the chest) and keep the transit ≥ 25 cm from the shoulder joint. `reachIK` and `grip` apply the first two
  by default, so even a plain target inherits them.
- **Frames.** A big hip yaw (spins) → author targets with `bodyV()`. A two-handed SWING (bat, club, sword) → author in
  the chest frame with `chestV()`: the chest coils away from the hips and the hands live in front of the chest.
- **Poles.** The pole must never be parallel to the reach: a hanging or low hand needs an out-and-back pole
  (`V(±0.8,-0.2,-0.5)`), an overhead push an out-back pole, and a big swing a pole that ROTATES with the arm.
  For a right arm, "out" is −X.
- **No if/else on the arms.** A hand that "joins" or "releases" blends: read the angle-posed hand
  (`boneByName[Ar.hand].getWorldPosition(hc)`) and `orbitLerp(hc, target, k)` with its own slow envelope
  (≥ 0.4 s for a 0.8 m move — a fast `present`/`cover` ramp joined in 3 frames = 35 cm/frame).
- **Height from contact.** Crouches: `settleKnee(kneeRad, () => plantFeet(...))`; gaits: `groundClamp(0)` after posing.
  Never `setRootY(-x)` with `kneeB` to fake a crouch — the feet end up under the floor.
- **Feet.** Ankle attitude through `footFlex(L, dorsi)` (relative to the MEASURED flat sole). Never a raw
  `sw(L.foot, AX.x, const)`.
- **No rolls to change facing.** A get-up ends facing the way it started: supine → sit up → tuck → stand.
- **Speed.** Hands ≤ ~10 cm/frame at 30 fps for gestures; a hand turning > 30° in one frame is a flip unless it is the
  strike of a chop.

Verify: `bake.mjs --ids …` → `bodyclip.mjs <lib> ids` → `flipscan.mjs <baseline> <lib> ids.txt` → `coherence.mjs <lib> ids`
→ `physics.mjs --ids …` → `shoot.mjs --montage --ids …` and look.
