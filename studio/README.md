# KSOL Designs GLB Studio

One app that ties the GLB tools into a single pipeline with a shared library:

**🪄 Generate → 🧍 Rig → 🐾 Animate → 🎬 Stitch → 🎲 Tabletop**

- **🪄 Generate** *(add-on)* — [ai-generate](../ai-generate): picture → textured 3D model via TRELLIS on the user's own fal.ai key (pay per model, no subscription; ~$0.02 Draft / $0.25–0.35 Hero). Saves to the library as `prop` or `unrigged`; hands off to Rig and Tabletop via `localStorage["studio.handoff"]`.
- **🧍 Rig** — [Character Rigger](../character-rigger): rig your own textured `.glb` / `.fbx` onto one of 19 standard, retargetable skeletons.
- **🐾 Animate** — [Rig Animator](../rig-animator): procedurally build motions for bipeds and animals.
- **🎬 Stitch** — [GLB Stitcher](../glb-stitcher): stitch clips into one MP4 with scenes, camera, audio, ensemble; retarget the built-in motion library onto any rigged character.
- **🎲 Tabletop** — [Tabletop](../tabletop): board games with your characters as pieces, map builder, card and box designers.

## How to run

**Double-click `Start GLB Studio.bat`.** It serves the whole `D:\Claude` folder on one local port (8770) and opens the Studio. Serving everything from **one origin** is the trick that lets the three tools share a browser-side library.

Use the top menu (**Generate · Rig · Animate · Stitch · Tabletop**) to move between tools. Only one tool is live at a time; the menu never reloads. Click **❔ About** (top-right) for a built-in illustrated walkthrough of the whole pipeline.

## The shared Studio Library (automatic hand-off)

A small IndexedDB store (`studio-lib.js`) shared by all three tools. Whatever one tool produces, the others see instantly — no downloads, no merge scripts:

- **Rig a character** (🧍 Rig → *Export rigged GLB*) → it's saved to the library **and** appears in 🎬 Stitch's **◆ Studio Library** card. Click **Load** to drop it in as a base character; the motion library (and any matching Animate motions) retargets straight onto it.
- **Bake a motion** (🐾 Animate → *➕ Add current animation → Studio Library*) → it joins 🎬 Stitch's **retarget list**, filtered to its skeleton (so quadruped motions show once you load a quadruped rig). Used exactly like the built-in biped motions.

The **◆ Library** pill in the top-right shows the counts and opens a drawer to review or delete items.

Each tool still works **standalone** from its own `Start …bat` (on its own port) — it just won't share the library there, because the library is per-origin. Run everything through GLB Studio to get the automatic flow.

## Files
- `index.html` — the shell (menu + iframe + library drawer + ❔ About walkthrough).
- `studio-lib.js` — the shared IndexedDB library (loaded by every tool). `addModel` takes an optional small `meta` object (the Generate tab stores cost/quality there).
- `Start GLB Studio.bat` — serves the `D:\Claude` parent on port 8770 and opens the Studio.
- `help/` — screenshots used by the About walkthrough.
