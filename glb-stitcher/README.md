# GLB Stitcher

Stitch multiple animated GLB files (e.g. from **AI 3D generators**) into one longer video,
composited over a background image. Runs entirely in your browser — nothing is uploaded.

## How to use

1. **Double-click `Start GLB Stitcher.bat`** (opens the tool in your browser).
   - Or just double-click `index.html`.
2. **Drop your GLB clips** into box 1. Name them with numbers so they order correctly:
   `clip_01.glb`, `clip_02.glb`, `clip_03.glb` … (use the ▲▼ arrows to reorder by hand).
   - Click a clip's **name** to preview just that clip.
   - Click **🎥** on a clip to give it its **own camera** (yaw / height / padding) that
     overrides the global camera for that clip only.
3. **Background** (box 2): choose a **Rolling scenery** — Castle wall (with windows),
   Mountains, Grass field, Rocky cliff, Ground/floor (top-down), or Vertical wall (climb).
   Scenery loops seamlessly and scrolls with the character's travel (when Camera-follow is
   on) plus a **Scenery scroll speed** slider — set a speed to make a "run in place" move
   through the world. Or drop your own **background image** (jpg/png) and choose how it fits.
   - Duplicate a segment with the **⧉** button to build long loops (e.g. 20× a run cycle).
   - **Surface relief (3D bumps)**: adds lit relief to the scenery — the castle/rocks/climb
     become real 3D walls and the ground gets bumpy texture (normal-mapped from the pattern).

### Scene sets (photo-real, colour-matched)
Under **Scene** (box 2b), pick **🧱 3D Room** or **🏔 Open expanse**, then click
**✨ Scene sets** / **✨ Room sets** for a one-click library of matched, photo-realistic
environments (images live in `./sets/`):
- **Open expanse** — 8 sets: Desert dunes, Green meadow, Snowfield, Autumn forest,
  Volcanic wasteland, Tropical coast, City skyline, Night city. Each lays down a tiled
  ground texture whose colour **matches the distant horizon panorama** and sky above it,
  so the ground reads continuously into the backdrop (e.g. sand ground → sand dunes → sky).
- **3D Room** — 6 sets: Wood cabin, Marble hall, Stone dungeon, Sandstone temple, Modern
  loft, Throne room. Each drops a matching floor onto the floor and a matching wall onto all
  four walls at once.
Applying a set is just a shortcut — you can still fine-tune tiling, drop your own image on any
surface, or toggle Bump/Shine afterward. A local server is required to load the set images
(use `Start GLB Stitcher.bat`).

### Characters
- GLBs are **auto-grouped by skeleton** — all the animation clips of one character
  share a color (dots in the clip list, timeline, and nodes).
- The **Characters** panel lets you rename each character and set its **relative size**, so a
  big character isn't shrunk to match a small one (they keep their relative scale in the video).
- To move a clip to a different character (or a new one), open its **🎥** panel and use the
  **Character** dropdown.
- **Ensemble mode** (Scene panel: "Ensemble — all characters on stage at once"): shows
  **every character together, side by side**, each looping its own moves. Drag a character
  in the preview to move it; set each one's size in the Characters panel. Scene length is
  the longest character by default, or pick a fixed length. Off = the normal one-at-a-time flow.

### Motion library (retarget) — add motions without downloading GLBs
The **Motion library (retarget)** panel lets you apply any of **579 pre-captured motions**
onto your character without exporting each one as its own GLB:
1. **Load one rigged character** — drop a rigged character `.glb` on the panel's drop zone, or
   click **Use loaded character as rig** to reuse a character you already dropped in box 1.
2. **Search / filter** the 579 motions (all / moves / in place) and **click one** — it's
   retargeted onto your character (bone-match + height scaling + rest-pose fix) and added as a
   normal clip. Everything else — timeline, travel, ensemble, camera, render — works on it exactly
   like a dropped GLB.
3. **Build a sequence** (checkbox): queue several motions and add them all at once. As you queue,
   the list re-sorts by how well each motion's **start pose** matches the last queued motion's
   **end pose** — a green **flows** tag means little to no pop between them. **✨ Suggest 4 that
   flow** auto-extends the queue with well-matching motions; **Add sequence → timeline** drops them
   all in, in order.

### Export the whole thing as a GLB (for Blender / Unity / other tools)
The **⬇ Export sequence as GLB** button (Output box) bakes the current timeline into a single
`.glb`: the character mesh + skeleton, one merged **"Sequence"** animation that plays every clip
back-to-back (honoring Loops / Hold), **plus each clip as its own named animation**
(`01_Walking`, `02_…`). Drop it into any tool that reads glTF.

The library lives in `./library/` (a small `index.json` + one small file per motion, loaded on
demand), so the tool never has to load the full 180 MB library up front. A local server is required
for this (use `Start GLB Stitcher.bat`). To regenerate the library from the master
`library.json`, run `node split-for-stitcher.mjs` in the **GLB Motion Library** project.

### The flow (timeline & nodes)
- A **timeline strip** under the preview shows your segments in order. Click a block to view
  it, use **⧉/✕** to duplicate/delete, and **drag blocks** to reorder. It shows the output length.
- Click **⧉ Nodes** (top-right of the preview) for a **node editor**: drag nodes to arrange
  them, and drag from a node's **▸ out** to another node's **in ◂** to set the play order
  (wire Start → a node to make it play first). Click a wire to send that clip to the end.
4. Adjust **camera / lighting** in box 3:
   - **Match size &amp; camera across clips** (on by default) scales every clip to the same
     size and frames them identically, so the subject doesn't jump in size/position between
     clips. Turn it off to auto-fit each clip on its own.
   - **Character position** — how the character moves from one segment to the next:
     - **Travel & continue** (default): the character keeps the ground it covers, and
       each new segment starts where the last one left off (e.g. a jump-left ends to the
       left and stays). The snap-back some clips add on their final frame is removed.
       (If you chain many travelling clips the character can walk toward the edge of frame —
       widen *Framing padding* or use *Stay in place* if you don't want it to drift.)
     - **Stay in place**: the character is pinned to one spot. Loop a walk/run cycle
       (Loops per clip, or many copies) to make someone run/walk **in place**.
   - **Camera follows the character** (on by default): keeps a travelling character
     centered while the scenery scrolls past. Turn off to let it move across a fixed frame.
   - **Show skeleton wireframe**: overlays the animation bones — handy for lining up motion.
   - **Drag the character in the preview** to set its start spot on the ground.
   - Each model **stands on the ground** (feet at floor level) with an optional
     **ground contact shadow** at its feet.
   - **Vertical position** slides the subject up/down in the frame — drag it so the
     model's feet line up with the ground in your background image.
   - Plus framing padding, camera height, orbit angle, optional slow spin, and lighting.
5. **Drop an audio file** (mp3/wav/m4a) in box 4 to lay music under the whole video —
   volume control, and loop-or-play-once if it's shorter than the video.
6. In box 5 set **resolution, FPS, loops per clip, hold time**, and a **cross-fade**
   duration to dissolve between clips (or "Off" for hard cuts).
7. Click **Preview playback** to check it, then **Render video** to save an `.mp4`.

The clips play back-to-back in order; each one is auto-framed and centered, drawn on top
of your background, with optional cross-fades between them. The output length is exact
(deterministic frame timing) and the audio is trimmed to match.

## Notes

- **Output format:** MP4 (H.264 video + AAC audio) via WebCodecs in Chrome/Edge. On
  browsers without WebCodecs it falls back to WebM. Chrome is recommended.
- **Internet:** needed the first time to load the 3D engine (Three.js) and MP4 muxer from a CDN.
- **Background** is a flat image behind the animation (fills the frame). It does not move.
- Each GLB's **first animation clip** is used. `Loops per clip` repeats it; `Hold` freezes the
  last frame for a moment before the next clip.
- Everything is local — your files never leave your computer.

## Files

- `index.html` — the whole tool (single file).
- `Start GLB Stitcher.bat` — convenience launcher (local server + opens browser).
