# GLB Studio — Motion Authoring Rules

The hard-won rules for making motions in the Rig Animator and playing them through the Stitcher. Every rule here comes from a
real bug that reached Paul's review (dates in brackets). Read this before authoring or changing a motion; an in-app assistant
should treat it as its checklist.

## 1. Directions and sides
- **The character faces +Z. Its LEFT side is +X.** `B_LARM.s = +1`, `B_RARM.s = −1` (same for legs). Never hard-code a hand's X:
  write `Ar.s*0.16`, not `-0.16`. [2026-09-27: ~15 motions had the left hand aimed at −X — forearms crossed in front: Trophy
  Lift, Drumming, Play Piano, Vault, Recline, Lie Prone, Check Pockets, Violin, Air Guitar, Conduct, Kneel, Cat Leap, riding, Reload,
  Draw & Holster, Wall Run.]
- **Mirror the elbow pole too.** An elbow points OUT: pole `V(Ar.s*0.3,-1,…)`. A pole with the wrong sign rolls the forearm and
  "twists the hands outward" (Catch Breath).
- `sw('Hips',AX.y,+a)` turns the character to its LEFT. A thigh's local `AX.y` swing is NOT mirrored for you — the right side
  needs the opposite sign (Frog Swim: the right leg swung across the body).
- If a comment says "to the left", check the number actually is +X (Side Parry's comment and value disagreed).

## 2. Order of operations
- **Turn the body first, then place the arm.** `twist()` / `sw('Hips',AX.y,…)` applied AFTER an arm pose carries the hand with
  the torso (Power Cross: the fist ended 14 cm past the nose). World-space reaches (`reachIK`, `setArm`) go LAST.
- Hand orientation (`handFrame`, `twoHandGrip`, `flatHand`) goes after the reach that places the hand.
- ⚠ Never put a `//` comment in the MIDDLE of a line in a table/object literal — it comments out the rest of the line
  (it silently deleted two hand-layer entries once). Use `/* … */` mid-line.

## 3. Two hands, one object
- A handle is RIGID: use `shaft(top, bot, pole, {spacing})` — it keeps the hands a fixed distance apart, slides the handle to
  where both arms reach, and wraps both fists round it. Never send two hands to two independently-authored points.
  (Sweep 30 cm, shovel 40, rake/dig 36, staff 32, bat 9 stacked, sword hilt 10.)
- A bat / sword: fists STACKED along the handle (right hand toward the barrel/blade), thumbs toward the business end; the handle's
  direction follows the swing — author it as a path, don't derive it from "away from the chest".
- An object between the palms (ball, trophy, crate, a body): each hand at `centre ± Ar.s*halfWidth`, palms facing `V(-Ar.s,0,0)`.
  Never `grip()` both hands to ONE point unless they really touch (Throw-In, Giant Pound).
- Hand-over-hand (rope): each hand on its own side of the rope; the rising hand passes in FRONT of the pulling one.

## 4. Hands and fingers
- Nothing sets a hand's attitude unless you do: if a hand touches something, give it a `handFrame` (palm down on a floor/thigh,
  palms in on a crate, palm up under a ball, palm forward on a stiff-arm). Otherwise it arrives "twisted".
- Start a reach from where the hand REALLY hangs (`boneByName[Ar.hand].getWorldPosition()` after the body pose), never a guessed
  point — a guessed start pops at the loop (Resting Squat).
- Finger motion: the hand layer accepts keyed tracks `[[fraction, hp([...])], …]` (first used by Play Piano).

## 5. Body on the ground
- A person gets down IN STAGES: sit/kneel first, then lean back / lower onto the belly. Tipping the pelvis 60–90° with the legs
  attached makes a stiff board that hovers (Recline, Lie Prone).
- When the pelvis pitches, re-aim the legs RELATIVE to it (`legF`), or they swing up with it.
- Feet that aren't carrying weight (prone, kneeling) must not decide the body height: the Stitcher's `{rest:1}` floor mode rests
  the body on its lowest part (knees, pelvis, chest, elbows, hands, toes) — add new lying/kneeling motions to FLOOR_CONTACT.
- A hip hinge raises the hip joints: after bending, lower the body until the ankles are back on the floor (Toe-Touch rose 3 m
  because the hanging feet looked like a jump to the bake's gravity detector). Mark non-jumps `noBallistic:true` if in doubt.

## 6. Loops and timing
- Every hand/foot path must END where it STARTS, and the way back needs time: a return squeezed into the last 0.1–0.15 s snaps
  the elbow (Spinning Slash, Discus, Reload). Give returns ≥ 0.25 of the loop, and route them around the body, not through it.
- A target fixed in space while the body travels bends the arm through the loop (Wall Run) — move targets WITH the body.
- A follow-through that holds until the loop ends drops at the restart (Punt) — bring it back to the start pose.

## 7. Big rotations and other rigs
- Joint angles copy well only when the character's rest pose resembles the template. For large limb motions on animals whose
  rest pose differs (a frog's folded legs), use the Stitcher's `WA_AIM` direction transfer for those bones.
- Prefer rotations about the WORLD vertical for big swings; local-axis twists of 100°+ go somewhere different on another rig.
- A physically extreme joint angle can be correct: a pitcher's / server's shoulder at layback really is ~170–180° external
  rotation. Keep it, but know the audit will flag it.

## 8. Stitcher floor contact (for reference)
- FLOOR_CONTACT is keyed by the short motion id — short ids REPEAT across families (quad `drink` vs biped `drink`). Always go
  through `floorSpecFor(id, shortId)`.
- The floor fix fades in with how level the torso is (smoothstep 0.25→0.75) and is smoothed ±3 frames where it switches on/off,
  then a lift pass keeps toes/knees above the floor. Planted hands lie flat (`_flatHandOnFloor`), fingertips never under the floor.
- Check a change on BOTH reference characters (Man with fingers + plain Human) — they differ in proportion and hand rig.

## 9. The automatic check (built 2026-09-27)
Every bake runs `lintMotion` on each motion (the Animator's ➕ Add shows its warnings in the status line; `bakeRig` returns them as
`lint`; `tools/pick-pack.mjs` prints them for every motion about to be merged; `tools/lint-rig.mjs <rig> [ids]` lists a whole rig).
It poses the motion every frame and warns on: **cross** (hands on the wrong sides — a mirrored target), **elbowIn** (an elbow pointing
into the body), **twist** (an arm bone rolled past what a body can do — a mirrored elbow pole or a hand frame fighting the arm),
**seam** (the loop's end doesn't lead back to its start; one-way moves that settle and hold are skipped), **snap** (a joint turning
>60° in one frame). A motion that MEANS it (arms folded, a pitcher's layback) says so with `lintOK:['cross'|'elbowIn'|'twist'|'seam'|'snap']`.
It is proven on the real mistakes: with Trophy Lift's mirrored hands or Catch Breath's mirrored poles put back, it flags them; on
the fixed versions it is silent. It never changes a baked motion (a bake with it = byte-identical library).

## 10. Proving a change
1. Back up the file. Edit the dev copy and the repo copy identically.
2. Bake the rig, then `tools/pick-pack.mjs` — it keeps ONLY the motions you meant to change and proves every other motion is
   byte-identical to the library. "N DIFFER" means you broke something else — stop and find it.
3. Measure (`tools/probe.mjs`, `_lineup/tools/stitchbones.mjs`, `handgap.mjs`), then LOOK (`sideview.mjs` side/front/top,
   `FOCUS=` close-ups). A number that looks right can still look wrong.
4. Re-render the review clip, mark it in `fixes.json`, re-run the audit, and compare flags before/after (`flagdiff.cjs`).
   New flags on a motion you touched are yours to fix.
