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
