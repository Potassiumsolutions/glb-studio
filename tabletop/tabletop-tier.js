/* ============================================================================
   Tabletop tier gating — free base build vs. expansion unlocks.

   FREE base (ships in GLB Studio on the web):
     · Square boards · Chess / Checkers / Chinese Checkers
     · Themes: Mixed, Forest, Grassland (+ their textures)
     · Build-a-Board, map generator, Extend (forest/plains), DRAW/SUBDIVIDE,
       procedural + built-in GLB props, 2D⇄3D, north-arrow
   EXPANSIONS (unlock keys):
     · terrain     → Terrain Pack: hex boards, desert/mountains/wetlands themes
                     & textures, extra Extend terrains, farmland
     · battlemaps  → Battle Maps Pack: Battle (D&D 5-ft) scale + real-world base maps
     · race        → Race games (Royal Game of Ur, …)
     · scifi       → Sci-Fi Pack: starship / space-station battle maps (needs Battle Maps for the 5-ft scale)
     · pharaohs    → Tomb of the Pharaohs: tomb + pyramid battle maps with traps (needs Battle Maps)
     · horror      → Gothic Horror: haunted manor, asylum, graveyard + catacombs (needs Battle Maps)
     · underdark   → Underdark: vast fungal caverns + a dark-elf city carved into them (needs Battle Maps)
     · pirates     → Pirates & Ports: sailing-ship decks, harbour docks, smugglers' cove (needs Battle Maps)
     · western / japan / ruins / wizard → Wild West town, Feudal Japan castle, Post-apocalypse ruins, Wizard's tower (need Battle Maps)
     · modern      → Modern Pack: City / Suburbs / Rural map themes, asphalt streets, railways,
                     modern buildings (towers, homes, schools, farms, wind farms …)

   Unlock path: a `.studiokey` (format "ksol-studio-expansion", target "tabletop")
   imported in GLB Studio → ✨ Upgrades writes the id into
   localStorage['studio.tabletop.exp']. Host and this iframe share an origin, so
   the flag is visible here. DEV: opening Tabletop on its own (outside the Studio
   host iframe) on a local host unlocks everything so development sees it all;
   add ?free to force the public tier, or ?exp=terrain,battlemaps to preview one.

   Markup hooks:
     data-exp="a|b"       element visible only if a OR b is unlocked (else hidden)
     data-exp-lock="a|b"  element visible only if a OR b is STILL locked (upsells)
   ============================================================================ */
(function (root) {
  'use strict';
  const ALL = ['terrain', 'battlemaps', 'race', 'modern', 'scifi', 'pharaohs', 'horror', 'underdark', 'pirates', 'western', 'japan', 'ruins', 'wizard'];
  const params = new URLSearchParams(location.search);
  let exp;

  if (params.has('exp')) {
    const v = params.get('exp');
    exp = new Set(v === 'all' ? ALL : v.split(',').map(s => s.trim()).filter(Boolean));
  } else {
    try { exp = new Set(JSON.parse(localStorage.getItem('studio.tabletop.exp') || '[]')); }
    catch (e) { exp = new Set(); }
    // DEV convenience: standalone (not embedded in the Studio host) on a local host → full features.
    const embedded = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
    const local = /^(localhost|127\.|192\.168\.|0\.0\.0\.0)/.test(location.hostname) || location.protocol === 'file:';
    if (!embedded && local && !params.has('free')) exp = new Set(ALL);
  }

  const has = id => exp.has(id);
  const setVis = (el, show) => {
    el.hidden = !show;
    if (el.tagName === 'OPTION') el.disabled = !show;
  };

  function apply() {
    document.querySelectorAll('[data-exp]').forEach(el =>
      setVis(el, el.getAttribute('data-exp').split('|').some(has)));
    document.querySelectorAll('[data-exp-lock]').forEach(el =>
      setVis(el, el.getAttribute('data-exp-lock').split('|').some(id => !has(id))));
  }

  root.TTier = {
    has, apply,
    list: () => [...exp],
    LABELS: { terrain: 'Terrain Pack', battlemaps: 'Battle Maps Pack', race: 'Race Games', modern: 'Modern Pack', scifi: 'Sci-Fi Pack', pharaohs: 'Tomb of the Pharaohs', horror: 'Gothic Horror Pack', underdark: 'Underdark Pack', pirates: 'Pirates & Ports', western: 'Wild West Pack', japan: 'Feudal Japan Pack', ruins: 'Post-Apocalypse Pack', wizard: "Wizard's Tower" }
  };

  if (document.readyState !== 'loading') apply();
  else document.addEventListener('DOMContentLoaded', apply);
})(window);
