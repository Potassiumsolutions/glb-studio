// ===== 🤖 AI LINK (2026-09-30) — let the user's OWN AI assistant drive GLB Studio =====
// The user's AI (Claude Code, Codex, Gemini CLI, Cursor… anything that can run a program on their computer) starts the small
// bridge in ../ai/bridge.mjs following ../ai/SETUP.md. Here, 🤖 AI → Connect asks that bridge (127.0.0.1 only) for work, runs
// each tool in the right tab and sends the answer back. No API keys and no servers of ours: it runs on their computer and on their
// AI subscription. Loaded by the Studio shell after its own script (uses show(), frames, curTool, TOOLS from there).
(function () {
  const PORT_KEY = 'glbStudio.ai.port', ON_KEY = 'glbStudio.ai.on';
  const $ = id => document.getElementById(id);
  const port = () => +(localStorage.getItem(PORT_KEY) || 8766);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let on = false, loopId = 0, calls = 0;
  const SETUP = () => `Please connect yourself to GLB Studio — the 3-D character and animation app I use in my web browser — so you can drive it for me (make motions from my descriptions, turn videos into motions, and so on).
Follow the setup guide at https://potassiumsolutions.github.io/glb-studio/ai/SETUP.md
(If I run GLB Studio from a folder on this computer, the same guide is in that folder at ai/SETUP.md, next to ai/bridge.mjs.)
When you are set up, tell me to press 🤖 AI → Connect in GLB Studio.`;

  // ---- UI state ----
  function setStat(kind, text) {
    const dot = $('aiDot'), st = $('aiState'), btn = $('aiConnect');
    const col = { off: '#6b7688', wait: '#f0c448', ok: '#37d0a0', busy: '#5b8cff' }[kind] || '#6b7688';
    if (dot) dot.style.color = col;
    if (st) st.innerHTML = text;
    if (btn) { btn.textContent = on ? '⏹ Disconnect' : '🔌 Connect'; btn.classList.toggle('on', on); }
  }

  // ---- tools: each runs in the tab it belongs to ----
  async function toolWin(tool, hook, ms) {
    if (typeof show === 'function' && curTool !== tool) show(tool);
    const t0 = Date.now();
    for (;;) { const f = frames[tool]; try { if (f && f.contentWindow && f.contentWindow[hook]) return f.contentWindow[hook]; } catch (e) {}
      if (Date.now() - t0 > (ms || 30000)) throw new Error('The ' + tool + ' tab did not open in time.'); await sleep(200); }
  }
  const A = () => toolWin('animate', '__ai');
  const HANDLERS = {
    studio_status: async () => { let anim = null; try { if (frames.animate) anim = (await toolWin('animate', '__ai', 3000)).status(); } catch (e) {}
      return { connected: true, tab: curTool, tabs: Object.keys(TOOLS), animator: anim, page: location.href.split('?')[0] }; },
    show_tab: async ({ tab }) => { if (!TOOLS[tab]) throw new Error('No tab “' + tab + '”. Tabs: ' + Object.keys(TOOLS).join(', ')); show(tab); return { tab }; },
    set_rig: async ({ rig }) => (await A()).setRig(rig),
    list_motions: async ({ filter }) => ({ rig: (await A()).status().rig, motions: (await A()).list(filter) }),
    make_motion: async ({ recipe, replace_id }) => (await A()).make(recipe, replace_id),
    get_recipe: async ({ id }) => ({ id, recipe: (await A()).getRecipe(id) }),
    play_motion: async ({ id, name }) => (await A()).play(id || name),
    look: async ({ view, time, times }) => (await A()).look(view, times && times.length ? times : (time != null ? [time] : null)),
    motion_from_video: async ({ url, name, mirror, fileName }) => (await A()).video(url, name, mirror, fileName),
    add_to_library: async ({ id }) => (await A()).add(id),
    list_library: async () => ({ models: (await StudioLib.listModels()).map(m => ({ id: m.id, name: m.name, skeleton: m.skeleton })),
      motions: (await StudioLib.listMotions()).map(m => ({ id: m.id, name: m.name })) }),
  };

  // ---- the link: long-poll the bridge for work ----
  async function loop(my) {
    let fails = 0;
    while (on && my === loopId) {
      const base = `http://127.0.0.1:${port()}`;
      try {
        const r = await fetch(base + '/poll', { cache: 'no-store' });
        if (my !== loopId) return;
        fails = 0; setStat('ok', `Connected — your AI can drive GLB Studio now${calls ? ` (${calls} request${calls === 1 ? '' : 's'} so far)` : ''}.`);
        if (r.status === 204) continue;
        if (!r.ok) throw new Error('bridge answered ' + r.status);
        const job = await r.json(); calls++;
        setStat('busy', `Working: <b>${job.tool.replace(/_/g, ' ')}</b>…`);
        let out;
        try { const h = HANDLERS[job.tool]; if (!h) throw new Error('This GLB Studio does not know the tool “' + job.tool + '” — reload it for the newest version.');
          out = { id: job.id, ok: true, result: await h(job.args || {}) }; }
        catch (e) { out = { id: job.id, ok: false, error: String(e && e.message || e) }; }
        await fetch(base + '/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
      } catch (e) {
        if (my !== loopId) return; fails++;
        setStat('wait', `Waiting for your AI… (it starts the helper on this computer, port ${port()} — see step 1)${fails > 3 ? '<br>Still waiting? If you pressed <b>Block</b> when the browser asked, click the 🔒 / settings icon left of the address, allow <b>apps on this device</b> (local network), and reload.' : ''}`);
        await sleep(Math.min(5000, 1000 + fails * 500));
      }
    }
  }
  function connect(v) { on = v; loopId++; try { localStorage.setItem(ON_KEY, v ? '1' : '0'); } catch (e) {}
    if (v) { setStat('wait', 'Connecting…'); loop(loopId); } else setStat('off', 'Not connected.'); }

  // ---- wire the panel ----
  function wire() {
    const sheet = $('aiSheet'); if (!sheet) return;
    $('aiBtn').addEventListener('click', () => sheet.classList.add('open'));
    $('aiX').addEventListener('click', () => sheet.classList.remove('open'));
    sheet.addEventListener('click', e => { if (e.target === sheet) sheet.classList.remove('open'); });
    $('aiSetupText').textContent = SETUP();
    $('aiCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(SETUP()); $('aiCopyNote').textContent = 'Copied! Paste it into a new session of your AI.'; }
      catch (e) { $('aiCopyNote').textContent = 'Select the message above and copy it.'; } });
    $('aiConnect').addEventListener('click', () => connect(!on));
    const pi = $('aiPort'); pi.value = port(); pi.addEventListener('change', () => { const v = Math.max(1024, Math.min(65535, +pi.value || 8766)); pi.value = v; try { localStorage.setItem(PORT_KEY, v); } catch (e) {} if (on) connect(true); });
    let was = false; try { was = localStorage.getItem(ON_KEY) === '1'; } catch (e) {}
    if (was) connect(true); else setStat('off', 'Not connected.');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.__aiLink = { handlers: HANDLERS, connect, get on() { return on; } };
})();
