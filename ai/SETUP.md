# Connect an AI assistant to GLB Studio

**This guide is written for the AI assistant.** The person you're helping uses GLB Studio, a free 3-D character and animation app that runs in their web browser. Please set yourself up so you can drive it for them. The setup takes about two minutes. It needs no API keys and no accounts, and nothing is sent anywhere except between you and their browser.

## What you'll get
A small helper called `bridge.mjs` runs on their computer. GLB Studio, open in their browser, connects to it when they press **🤖 AI → Connect**. Through the helper you get these tools:

| Tool | What it does |
|---|---|
| `studio_status` | Connected? Which tab and which rig? |
| `set_rig` | Choose the Animator rig (`bipedhand` = a person with fingers, the usual choice) |
| `make_motion` | **Make a new motion from a description.** You write a *motion recipe* (key poses in plain joint angles). The rules are in the tool's description. |
| `look` | Get a picture of the character (front, side, back or three-quarter, at up to 6 moments) so you can check your work |
| `get_recipe` + `make_motion replace_id` | Read a recipe back and adjust it |
| `motion_from_video` | Turn a video file on this computer into a motion. Tracking runs in the browser; nothing is uploaded. |
| `play_motion`, `list_motions`, `show_tab` | Get around the app |
| `add_to_library`, `list_library` | Put a finished motion in the Studio Library so the 🎬 Stitch tab can use it on any character |

## Step 1: get the helper
You need **Node.js 18 or newer** (`node --version`). If it's missing, ask the person to install the LTS version from https://nodejs.org, or install it for them if you can. Then save the helper to a folder of your choice:

```bash
mkdir -p ~/glb-studio-ai
curl -fsSL https://potassiumsolutions.github.io/glb-studio/ai/bridge.mjs -o ~/glb-studio-ai/bridge.mjs
```

On Windows PowerShell, use this instead:
`New-Item -ItemType Directory -Force "$HOME\glb-studio-ai"; Invoke-WebRequest https://potassiumsolutions.github.io/glb-studio/ai/bridge.mjs -OutFile "$HOME\glb-studio-ai\bridge.mjs"`

If they run GLB Studio from a folder on their computer, the same file is already there at `ai/bridge.mjs`, and you can use that one.

The helper is a single file with no dependencies. Read it first if you like: it listens on `127.0.0.1:8766` only.

## Step 2: add it as a tool server (MCP)
Use the **full path** to `bridge.mjs`, with the argument `mcp`. Pick the section for the tool you are:

- **Claude Code:** `claude mcp add --scope user glb-studio -- node /FULL/PATH/glb-studio-ai/bridge.mjs mcp`
- **Codex CLI:** add this to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.glb-studio]
  command = "node"
  args = ["/FULL/PATH/glb-studio-ai/bridge.mjs", "mcp"]
  ```
- **Gemini CLI:** in `~/.gemini/settings.json`, add `"mcpServers": { "glb-studio": { "command": "node", "args": ["/FULL/PATH/glb-studio-ai/bridge.mjs", "mcp"] } }`
- **Cursor / Windsurf / others:** add the same `command` and `args` as a stdio MCP server in that tool's MCP settings.

Many assistants only load new tool servers when a **new session** starts. In that case, tell the person that the tools will be there next time, and for now use Step 2b.

### Step 2b: no MCP, or not loaded yet? Use the terminal
Start the helper in the background, then call the tools from the command line. The answers print as JSON, and pictures are saved as PNG files you can open:

```bash
node ~/glb-studio-ai/bridge.mjs serve        # leave running (in the background)
node ~/glb-studio-ai/bridge.mjs tools        # list the tools
node ~/glb-studio-ai/bridge.mjs call studio_status
node ~/glb-studio-ai/bridge.mjs call make_motion '{"recipe":{"name":"Wave hello","duration":2,"loop":true,"keys":[{"t":0,"pose":{"rightArm":{"raise":150,"elbow":30},"rightHand":"open"}},{"t":1,"pose":{"rightArm":{"raise":130,"elbow":60},"rightHand":"open"}},{"t":2,"pose":{"rightArm":{"raise":150,"elbow":30},"rightHand":"open"}}]}}'
```

The full recipe rules are in the `make_motion` description (`node bridge.mjs tools` shows the first line; `http://127.0.0.1:8766/tools` has everything).

## Step 3: connect
Tell the person: **"In GLB Studio, press 🤖 AI (top right), then 🔌 Connect."**

The browser may ask to let the site reach "apps on this device" or the "local network". They should press **Allow**. Then call `studio_status`; it should say `"connected": true`.

## Working well
- **Make a motion:** call `set_rig` with `bipedhand`, then `make_motion`, then `look` from the **front and the side** at several moments. Fix anything that looks wrong with `make_motion replace_id=…`. When the person is happy, call `add_to_library`.
- Recipes use the **character's** own left and right, angles in degrees, and 3–8 key poses. Bent knees lower the body with the feet planted. `"body":{"jump":0.4}` lifts it off the floor.
- **Show the person** what you made. The motion plays in their 🐾 Animate tab, and pictures from `look` are worth sharing.
- **Videos:** the whole body must be in view and the camera still, and the clip can be up to 20 seconds. Use `mirror: true` for a selfie video.
- **Nothing is deleted or overwritten** except your own recipe motions, and only when you pass `replace_id`.

## If something goes wrong
- **"not connected"**: GLB Studio isn't open, or Connect wasn't pressed. It could also be on a different port: the 🤖 AI panel has a port box, and the helper uses `GLB_STUDIO_PORT`.
- **Port 8766 is busy**: another helper is already running. That's fine; a second copy forwards to it.
- **The browser blocked the connection**: in the site's settings, allow access to the local network or apps on this device, then press Connect again. Safari sometimes refuses; Chrome, Edge and Firefox work.
