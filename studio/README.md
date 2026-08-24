# KSOL Designs GLB Studio

One app that ties the three GLB tools into a single pipeline with a shared library:

**🧍 Rig → 🐾 Animate → 🎬 Stitch**

- **🧍 Rig** — [Character Rigger](../Character%20Rigger): rig your own textured `.glb` onto the standard, retargetable skeleton (biped / quadruped / bird).
- **🐾 Animate** — [Rig Animator](../Rig%20Animator): procedurally build quadruped & bird motions.
- **🎬 Stitch** — [GLB Stitcher](../GLB%20Stitcher): stitch clips into one MP4 with scenes, camera, audio, ensemble; retarget a 579-motion library onto any rigged character.

## How to run

**Double-click `Start GLB Studio.bat`.** It serves the whole `D:\Claude` folder on one local port (8770) and opens the Studio. Serving everything from **one origin** is the trick that lets the three tools share a browser-side library.

Use the top menu (**Rig · Animate · Stitch**) to move between tools. Only one tool is live at a time; the menu never reloads. Click **❔ About** (top-right) for a built-in illustrated walkthrough of the whole pipeline.

## The shared Studio Library (automatic hand-off)

A small IndexedDB store (`studio-lib.js`) shared by all three tools. Whatever one tool produces, the others see instantly — no downloads, no merge scripts:

- **Rig a character** (🧍 Rig → *Export rigged GLB*) → it's saved to the library **and** appears in 🎬 Stitch's **◆ Studio Library** card. Click **Load** to drop it in as a base character; the 579-motion library (and any matching Animate motions) retarget straight onto it.
- **Bake a motion** (🐾 Animate → *➕ Add current animation → Studio Library*) → it joins 🎬 Stitch's **retarget list**, filtered to its skeleton (so quadruped motions show once you load a quadruped rig). Used exactly like the built-in biped motions.

The **◆ Library** pill in the top-right shows the counts and opens a drawer to review or delete items.

Each tool still works **standalone** from its own `Start …bat` (on its own port) — it just won't share the library there, because the library is per-origin. Run everything through GLB Studio to get the automatic flow.

## Files
- `index.html` — the shell (menu + iframe + library drawer + ❔ About walkthrough).
- `studio-lib.js` — the shared IndexedDB library (loaded by all three tools).
- `Start GLB Studio.bat` — serves the `D:\Claude` parent on port 8770 and opens the Studio.
- `help/` — screenshots used by the About walkthrough.
