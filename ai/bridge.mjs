#!/usr/bin/env node
// GLB Studio ↔ your AI — a tiny local bridge (no installs: Node 18+, no packages, no API keys, nothing leaves this computer).
//
//   node bridge.mjs mcp      → run as an MCP server over stdio (Claude Code, Codex, Gemini CLI, Cursor… add it as a tool server)
//   node bridge.mjs serve    → just the local link (for agents that use the terminal instead of MCP)
//   node bridge.mjs call <tool> '<json args>'   → call one tool through a running link and print the answer
//   node bridge.mjs tools    → list the tools
//
// How it works: GLB Studio (open in your browser) → 🤖 AI → Connect. The page then asks this bridge, on 127.0.0.1 only, for work
// ("long polling"), runs each request in the Studio and sends the answer back. Your AI talks to the bridge (MCP or `call`).
// Safety: listens on 127.0.0.1 only; tool calls are refused from web pages (only programs on this computer can make them); the
// page side only accepts GLB Studio's own pages (localhost or potassiumsolutions.github.io); files are only served when your AI
// passes their path in a tool call (motion_from_video), each under a one-time random address.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = '1.0.1';
const PORT = +(process.env.GLB_STUDIO_PORT || 8766);
const HOST = '127.0.0.1';
const PAGE_ORIGINS = [/^https:\/\/potassiumsolutions\.github\.io$/, /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/];
const log = (...a) => process.stderr.write('[glb-studio bridge] ' + a.join(' ') + '\n');

// ---- the tools (the page implements them; descriptions are what your AI reads) ----
const RECIPE_HELP = `A motion recipe: {"name", "duration" (s, 0.2-30), "loop" (bool), "keys":[{"t": s, "pose": {…}}]}. Pose parts (degrees; all optional; missing = relaxed standing; values ease between keys):
leftArm/rightArm {raise: out to the side 0=down 90=horizontal 170=up, forward: swing forward (neg = back), elbow: 0-150}
leftLeg/rightLeg {forward: thigh forward (neg = back), out: to the side, knee: 0-150}
spine {bend: forward(+)/back(-), side: lean to its own left(+), twist: chest to its left(+)}
head {nod: down(+)/up(-), turn: to its left(+), tilt: ear to its left shoulder(+)}
body {turn: whole body to its left(+), jump: metres off the floor}
leftHand/rightHand: relax|open|fist|point|thumbsup|wave|flat|spread|loose (fingered rigs).
Left/right = the character's own. On a RAISED arm (raise 110-170) "forward" works the other way round: negative pushes the hand out in front of the face, +15..25 keeps it beside the head (a wave: raise 120-155, forward 20, elbow 25-40, two keys swinging). Always check with look from the FRONT and the SIDE. Bent knees lower the body with the feet planted (squats, crouches, landings). 3-8 keys is plenty.`;
const TOOLS = [
  { name: 'studio_status', description: 'Is GLB Studio connected? Which version, which tabs, which rig is on the Animator.', inputSchema: { type: 'object', properties: {} } },
  { name: 'show_tab', description: 'Switch GLB Studio to a tab: generate, rig, animate, stitch, tabletop, mapview.', inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['generate', 'rig', 'animate', 'stitch', 'tabletop', 'mapview'] } }, required: ['tab'] } },
  { name: 'set_rig', description: 'Choose the Animator rig. Use "bipedhand" (person with fingers) for people unless told otherwise; "biped" = person without fingers.', inputSchema: { type: 'object', properties: { rig: { type: 'string' } }, required: ['rig'] } },
  { name: 'list_motions', description: 'List the Animator motions for the current rig (built-in ones, and the user\'s own: ✏ edited, 🎥 from video, 🤖 from a recipe). Optional filter text.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'make_motion', description: 'Create a NEW motion on the Animator from a motion recipe (describe-a-motion). Returns its id. To change it later, call again with replace_id. ' + RECIPE_HELP, inputSchema: { type: 'object', properties: { recipe: { type: 'object' }, replace_id: { type: 'string', description: 'id of one of YOUR recipe motions to overwrite (optional)' } }, required: ['recipe'] } },
  { name: 'get_recipe', description: 'Read back the recipe of a motion made from a recipe (to adjust it).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'play_motion', description: 'Select and play a motion on the Animator (by id or exact name).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
  { name: 'look', description: 'Take a picture of the Animator character so you can check a motion: view front|side|back|three-quarter, at a time in seconds (or "times": up to 6 moments in one strip — use 1-3 for a closer look). Returns an image; it is also saved as a PNG (in save_to, a folder, if given — otherwise the system temp folder) and the path is in "saved".', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['front', 'side', 'back', 'three-quarter'] }, time: { type: 'number' }, times: { type: 'array', items: { type: 'number' } }, save_to: { type: 'string' } } } },
  { name: 'motion_from_video', description: 'Turn a video file ON THIS COMPUTER (a person moving, whole body in view, camera still, up to 20 s) into a new Animator motion. Tracking runs in the browser; nothing is uploaded. Give the full file path.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, mirror: { type: 'boolean', description: 'true for a mirrored selfie video' } }, required: ['path'] } },
  { name: 'add_to_library', description: 'Send the current Animator motion (or the one with this id) to the Studio Library, so the 🎬 Stitch tab can use it on any character.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'list_library', description: 'List what is in the shared Studio Library (characters/models and motions).', inputSchema: { type: 'object', properties: {} } },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

// ---- the link to the page ----
let waiting = null;            // the page's pending /poll response
const queue = [];              // jobs not yet picked up
const pending = new Map();     // id → {resolve, timer}
let lastSeen = 0;              // last time the page polled or answered
const live = () => Date.now() - lastSeen < 40000 || pending.size > 0;   // a page busy with a long job (a video) is still connected
const files = new Map();       // token → absolute path (one-time)
const pageOk = origin => !!origin && PAGE_ORIGINS.some(r => r.test(origin));
function cors(req, res) {
  const o = req.headers.origin; if (o && pageOk(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); }
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, bad) => { let s = ''; req.on('data', d => { s += d; if (s.length > 50e6) req.destroy(); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });
function dispatch() { if (waiting && queue.length) { const job = queue.shift(); const w = waiting; waiting = null; clearTimeout(w.timer); send(w.res, 200, job); } }
function runTool(tool, args, timeoutMs) {
  return new Promise(resolve => {
    if (!TOOL_NAMES.has(tool)) return resolve({ ok: false, error: 'Unknown tool "' + tool + '". Tools: ' + [...TOOL_NAMES].join(', ') });
    args = Object.assign({}, args);
    if (tool === 'motion_from_video') { const p = path.resolve(String(args.path || '')); if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return resolve({ ok: false, error: 'No such video file: ' + p }); }
    if (!live() && tool !== 'studio_status') return resolve({ ok: false, error: 'GLB Studio is not connected. Ask the user to open GLB Studio (https://potassiumsolutions.github.io/glb-studio/ or their local copy) and press 🤖 AI → Connect, then try again.' });
    if (tool === 'studio_status' && !live()) return resolve({ ok: true, result: { connected: false, bridge: VERSION, help: 'Open GLB Studio and press 🤖 AI → Connect.' } });
    if (tool === 'motion_from_video') { const p = path.resolve(String(args.path || ''));
      const tok = crypto.randomBytes(16).toString('hex'); files.set(tok, p); args.url = `http://${HOST}:${PORT}/file/${tok}`; args.fileName = path.basename(p); delete args.path; }
    const id = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'GLB Studio did not answer in time (' + Math.round(timeoutMs / 1000) + ' s). Is the tab still open?' }); }, timeoutMs);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
    queue.push({ id, tool, args }); dispatch(); });
}
function startServer() {
  return new Promise((ok, bad) => {
    const srv = http.createServer(async (req, res) => {
      cors(req, res); const url = new URL(req.url, `http://${HOST}`); const origin = req.headers.origin;
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      try {
        // --- the page side (a GLB Studio page only) ---
        if (url.pathname === '/poll' || url.pathname === '/result' || url.pathname.startsWith('/file/')) {
          if (!pageOk(origin)) return send(res, 403, { error: 'only GLB Studio pages may use this' });
          if (url.pathname === '/poll') { lastSeen = Date.now(); if (waiting) { clearTimeout(waiting.timer); send(waiting.res, 204, {}); }
            waiting = { res, timer: setTimeout(() => { if (waiting && waiting.res === res) { waiting = null; res.writeHead(204); res.end(); } }, 25000) }; dispatch(); return; }
          if (url.pathname === '/result') { lastSeen = Date.now(); const r = await body(req); const p = pending.get(r.id); if (p) { pending.delete(r.id); p.resolve(r); } return send(res, 200, { ok: true }); }
          const tok = url.pathname.slice(6), f = files.get(tok); if (!f) return send(res, 404, { error: 'unknown file' }); files.delete(tok);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f).size }); return fs.createReadStream(f).pipe(res); }
        // --- the AI side (programs on this computer only — browsers always send an Origin) ---
        if (origin) return send(res, 403, { error: 'tool calls are not accepted from web pages' });
        if (url.pathname === '/status') return send(res, 200, { bridge: VERSION, connected: live() });
        if (url.pathname === '/tools') return send(res, 200, TOOLS);
        if (url.pathname === '/call' && req.method === 'POST') { const r = await body(req); return send(res, 200, await runTool(r.tool, r.args || {}, +(r.timeout || 240000))); }
        send(res, 404, { error: 'not found' });
      } catch (e) { send(res, 500, { error: String(e.message || e) }); } });
    srv.on('error', bad); srv.listen(PORT, HOST, () => ok(srv)); });
}
// a second copy (another AI session) forwards to the one already running
async function callVia(tool, args) {
  const r = await fetch(`http://${HOST}:${PORT}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args }) });
  return r.json(); }
let owner = false;
async function ensureLink() { if (owner) return true; try { await startServer(); owner = true; log(`listening on http://${HOST}:${PORT} — in GLB Studio press 🤖 AI → Connect`); return true; }
  catch (e) { if (e.code === 'EADDRINUSE') { log(`a bridge is already running on port ${PORT}; forwarding to it`); return false; } throw e; } }
const call = (tool, args) => owner ? runTool(tool, args, 240000) : callVia(tool, args);

// pictures: MCP returns them as images; they are also saved to a file (for agents that read files instead)
let shot = 0;
function toContent(r, saveTo) {
  if (!r.ok) return { content: [{ type: 'text', text: '⚠ ' + (r.error || 'failed') }], isError: true };
  const res = r.result, content = []; const imgs = (res && res.images) || [];
  const rest = Object.assign({}, res); delete rest.images;
  for (const im of imgs) { const b64 = String(im).replace(/^data:image\/\w+;base64,/, ''); let dir = os.tmpdir(); if (saveTo) { try { fs.mkdirSync(saveTo, { recursive: true }); dir = saveTo; } catch (e) {} } const f = path.join(dir, `glb-studio-look-${Date.now().toString(36)}-${++shot}.png`);
    try { fs.writeFileSync(f, Buffer.from(b64, 'base64')); (rest.saved = rest.saved || []).push(f); } catch (e) {}
    content.push({ type: 'image', data: b64, mimeType: 'image/png' }); }
  content.unshift({ type: 'text', text: JSON.stringify(rest, null, 1) }); return { content }; }

// ---- MCP over stdio (newline-delimited JSON-RPC 2.0) ----
async function mcp() {
  await ensureLink(); let buf = '';
  const out = m => process.stdout.write(JSON.stringify(m) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async chunk => { buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.id === undefined) continue;   // notifications
      try {
        if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'glb-studio', version: VERSION },
          instructions: 'Drive GLB Studio (a browser 3-D character / animation studio) for the user. Start with studio_status; if it is not connected, ask the user to press 🤖 AI → Connect in GLB Studio. To make a motion from a description: set_rig bipedhand → make_motion with a recipe → look (front and side, several times) → adjust with make_motion replace_id → add_to_library when the user is happy.' } });
        else if (m.method === 'ping') out({ jsonrpc: '2.0', id: m.id, result: {} });
        else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
        else if (m.method === 'tools/call') { const a = m.params.arguments || {}; const r = await call(m.params.name, a); out({ jsonrpc: '2.0', id: m.id, result: toContent(r, a.save_to) }); }
        else out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } });
      } catch (e) { out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: String(e.message || e) } }); } } });
  process.stdin.on('end', () => process.exit(0));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'mcp') mcp();
else if (cmd === 'serve') { if (!(await ensureLink())) { log('nothing to start — use: node bridge.mjs call <tool> …'); process.exit(0); } }
else if (cmd === 'tools') { for (const t of TOOLS) console.log(t.name + ' — ' + t.description.split('. ')[0]); }
else if (cmd === 'call') { const [tool, json] = rest; let args = {}; try { args = json ? JSON.parse(json) : {}; } catch (e) { console.error('args must be JSON'); process.exit(2); }
  try { const r = await callVia(tool, args); const c = toContent(r, args.save_to); for (const x of c.content) if (x.type === 'text') console.log(x.text);
    process.exit(!r.ok ? 1 : (r.result && r.result.connected === false) ? 3 : 0); }   // 3 = the helper runs but GLB Studio has not connected (yet)
  catch (e) { console.error('No bridge is running. Start one with: node bridge.mjs serve   (then press 🤖 AI → Connect in GLB Studio)'); process.exit(1); } }
else { console.log('GLB Studio bridge ' + VERSION + '\n  node bridge.mjs mcp | serve | tools | call <tool> \'<json>\''); }
