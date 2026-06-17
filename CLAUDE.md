# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Node-based terminal manager** (source-available, proprietary — see `LICENSE`): multiple real terminals live on a single
pan/zoom canvas as draggable nodes. Target users are people with ADHD / disorganized
workflows who benefit from a spatial layout over stacked tabs. Long-term vision includes
remote access and paid features — the architecture is built so those slot in without a
UI rewrite (see Transport abstraction below).

## Commands

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall hook)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build (electron-vite preview)
npm run typecheck  # tsc for both node (main/preload) and web (renderer) projects
npm run rebuild    # re-run electron-rebuild for node-pty if you hit ABI/native errors
```

No test runner is set up yet. `npm run typecheck` is the fastest correctness gate.

## Process model (Electron, three contexts)

The codebase is split by Electron process boundary — keep code on the correct side:

- **`src/main/`** — Node/Electron main process. Owns all native + filesystem access:
  `pty-manager.ts` spawns `node-pty` processes; `workspace-store.ts` reads/writes the
  workspace JSON in `app.getPath('userData')`. The renderer must never import these.
- **`src/preload/`** — the only bridge. `index.ts` uses `contextBridge` to expose a
  narrow API on `window.nodeTerminal` (typed in `index.d.ts`). `contextIsolation` is on,
  `nodeIntegration` off.
- **`src/renderer/`** — React UI. Talks to main *only* through `window.nodeTerminal`.
- **`src/shared/`** — types and IPC channel names imported by all three sides. `ipc.ts`
  is the single source of truth for channel strings; never hardcode a channel elsewhere.

PTY output flows main → renderer over per-session channels (`pty:data:<sessionId>`),
input flows renderer → main over `pty:write`. node-pty is kept **external** in the bundle
(`externalizeDepsPlugin` in `electron.vite.config.ts`) because it's a native module.

## Key abstraction: TerminalTransport

This is the load-bearing design decision. The renderer depends only on the
`TerminalTransport` interface (`src/renderer/terminal/transport.ts`), never on IPC or
node-pty directly. The current implementation is `LocalTransport` (IPC → node-pty). A
future `RemoteTransport` (WebSocket to a remote agent) implements the same interface, so
remote access / paid tiers can be added without touching the canvas or terminal UI. When
adding terminal-session features, extend the interface — do not reach around it.

## State & persistence model

**React Flow is the single live source of truth** for nodes. There is intentionally no
separate store mirroring node state — earlier dual-source designs caused sync bugs.
`src/renderer/state/workspace.ts` holds only pure helpers: the color palette, the node
factories (`createTerminalNode`, `createClaudeNode`, `createStickyNode`, `createGroupNode`,
`createEditorNode`, `createDiffNode`), the group transforms (`groupSelectedNodes`,
`ungroupNodes`, `duplicateNode`), and the `nodeStatesToFlow` / `flowToNodeStates`
serializers. Node kinds: `terminal | sticky | group | editor | diff`. A node's `data`
carries `title, color, group, tags, collapsed, expandedHeight, shell, cwd, text,
initialCommand, filePath, diffStaged`. `nodeStatesToFlow` defaults a missing `kind` to
`terminal` for backward compat.

Persistence has two layers:

- **Layout + config** (`workspace.json`, schema v2): a list of **projects**, each with its
  own `nodes`, `viewport`, `color`, and default `cwd`, plus the `activeProjectId`. Auto-saved
  on a debounce (and via the dock Save button). Lives in `app.getPath('userData')`.
  `main/workspace-store.ts` migrates v1 single-canvas files into one project; an **empty**
  project list is valid and persisted (→ welcome screen). The renderer re-saves on launch.
- **Live terminal sessions** (tmux): terminals continue where they left off across node
  remounts *and* full app restarts, including running processes. See below.

`settings.json` is a separate store (`main/settings-store.ts`, `state/settings.ts`).

## Projects (tabs)

Each project is one canvas/page; terminals and notes belong to a project. The `projects`
zustand store (`renderer/state/projects.ts`) holds project metadata + the *serialized* nodes
of all projects. **React Flow remains the single live source of truth for the *active*
project's nodes only.** The contract:

- The active-project effect in `Canvas.tsx` (keyed on `activeProjectId`) loads that project's
  serialized nodes into React Flow. `loadingRef` suppresses dirty-marking during this load.
- Before any project switch / add / delete, `commitActiveToStore()` serializes the live
  React Flow nodes back into the store, so nothing is lost. Then disk is written.
- Switching away unmounts the old project's `TerminalNode`s → their tmux clients detach but
  the sessions keep running; switching back reattaches. tmux session names are per-node-id
  (globally unique), so projects never collide.
- Deleting a project calls `transport.destroy(nodeId)` for each of its terminals (ending
  their tmux sessions). Deleting the **last** project is allowed → projects empty →
  `WelcomeScreen` (New project / Open folder / Clone repo).
- A project's `cwd` (folder picker, `dialog:select-folder`) is passed to terminal/Claude
  node factories so new terminals open there. **Folder ↔ project is deduped:** "Open folder…"
  reuses the existing project with that `cwd` (and its nodes) instead of creating a duplicate.

## Terminal session continuity (tmux)

`src/main/pty-manager.ts` runs each terminal inside a persistent tmux session
(`tmux new-session -A -D -s nt-<nodeId>`) on a dedicated socket (`-L node-terminal`) with
a generated config (`-f <userData>/tmux.conf`, so the user's `~/.tmux.conf` never
interferes; status bar off, mouse on, 50k history). Because the tmux *server* outlives the
app, sessions survive when no client is attached.

Lifecycle, by intent:
- **Node unmount / window close / app quit** → `kill()` only detaches the PTY client; the
  tmux session keeps running. `PtyManager.killAll()` deliberately does NOT kill sessions.
- **Node reopen / app relaunch** → a new PTY attaches to the same `nt-<nodeId>` session and
  tmux redraws current state.
- **User clicks ×** → `destroy(persistKey)` runs `tmux kill-session`, permanently ending it.

The node id is the `persistKey` (passed to `transport.create`), so it must stay stable.
If tmux is unavailable, `PtyManager` falls back to a plain shell (no cross-restart
continuity). `findTmux()` resolves an absolute path because GUI apps don't inherit the
shell PATH; `TMUX`/`TMUX_PANE` are stripped from the child env to avoid nesting refusal.

## Terminal node lifecycle (gotchas)

`src/renderer/nodes/TerminalNode.tsx` is the trickiest file:

- The xterm instance + PTY session are created once in a `useEffect(…, [])` and torn down
  on unmount. The component persists across re-renders because React Flow keys nodes by
  `id` — never change a node's id, or you'll respawn its terminal.
- **React StrictMode is deliberately not used** (`main.tsx`) — double-mount would spawn
  two PTYs per node.
- The xterm container is `nodrag nowheel`; a transparent **hover-guard** overlay sits on top
  until you dwell `settings.panHoverDelay` (so quick drag = move node, scroll = pan). After
  the dwell the guard is removed and xterm takes input. The header stays draggable.
- A `ResizeObserver` drives `FitAddon.fit()` + `transport.resize`. Canvas zoom is a CSS
  transform, so it does *not* change `clientWidth` — cols/rows stay stable across zoom.
  `scale-fix.ts` patches xterm's mouse coords so text selection stays aligned when zoomed.

## Node kinds (all rendered by React Flow custom nodes)

- **terminal** (`TerminalNode.tsx`) — xterm + tmux (see above). Header: collapse, color,
  click-to-rename title, ✦ AI-name, ×. Body has a **hover guard** overlay: dwell
  `settings.panHoverDelay` (default 600 ms) before the terminal takes focus — before that,
  drag = move node, scroll = pan canvas. **Cmd/Ctrl+M** (while hovered) toggles a markdown
  render of the captured output. Tag chips via `NodeTags`.
- **Claude Code** (`createClaudeNode`) — a terminal preset with `initialCommand: 'claude'`
  (runs once on open via `transport.write`, then cleared); clay color, `claude` tag. Claude
  nodes get extra behavior (see **Claude Code support** below): a busy/working badge, an
  unread dot, a completion notification, a session-name chip, content search, and a
  **Branch conversation** action.
- **sticky** (`StickyNode.tsx`) — colored note, free text, collapsible.
- **group** (`GroupNode.tsx`) — real React Flow parent/child frame; `groupSelectedNodes`
  reparents children (`parentId` + `extent:'parent'`, relative positions), `ungroupNodes`
  restores absolute. `nodeStatesToFlow` sorts parents first (React Flow requirement).
  Visually: a dashed rounded frame in the group color with a floating label pill (color dot
  + editable name) on the top border and ungroup/× top-right (on hover/selected). The
  `NodeResizer` line is hidden (`lineStyle` transparent) so it can't draw a sharp-cornered
  box; the selection ring is a `box-shadow` instead, which follows the same `border-radius`.
- **editor** (`EditorNode.tsx`) — Monaco code editor for a `filePath`; reads/writes via
  `fs:read`/`fs:write`, auto-detects language from the path, ⌘S saves, dirty dot. A
  **Preview / Edit** toggle (or ⌘M while hovered) renders the live content as markdown.
  **Image files** (png/jpg/gif/webp/bmp/ico/svg/avif) skip Monaco and show an `<img>`
  preview instead — read as base64 via `fs:read-binary` into a `data:` URL (CSP allows
  `img-src data:`), on a checkerboard backdrop with the pixel dimensions in the header.
- **diff** (`DiffNode.tsx`) — Monaco diff editor; `diffStaged` chooses HEAD↔index (staged)
  vs index↔working (unstaged) via `git:show-file` + `fs:read`. Read-only.

Monaco is wired in `renderer/editor/monaco-setup.ts` (language workers bundled via Vite
`?worker` — no CDN; CSP `worker-src` allows them). Markdown rendering is shared in
`renderer/lib/markdown.ts` (`marked` + DOMPurify sanitize).

## Claude Code support

Extra behavior for `claude`-tagged terminal nodes, driven by a **transient** zustand store
`state/claudeStatus.ts` (`{busy, unread, session}` per node id — **not** persisted, so
workspace.json stays clean; resets on reload).

- **State via Claude hooks** (REF-style) — detection uses Claude Code's own hooks, **not**
  output parsing. `main/claude-hooks.ts` installs ONE managed, env-gated hook command into the
  user's `~/.claude/settings.json` (merged, preserving existing hooks incl. other tools';
  idempotent). The command is `[ -z "$NODETERM_NODE_ID" ] && exit 0; … >> <signal>/<id>.log`
  — a no-op in the user's normal terminals, active only in sessions nodeterm spawns (which set
  `NODETERM_NODE_ID`/`NODETERM_HOOK_DIR` via tmux `new-session -e`). So **any** `claude` run
  inside nodeterm is detected, even one typed by hand — not just the managed Claude Code node.
  Each hook appends its JSON payload to `<userData>/claude-signals/<nodeId>.log`; main watches
  the dir (event-driven `fs.watch`, no polling — verified to fire on appends; offset-based reads
  so each line is delivered once) and forwards `{nodeId, event, sessionId, notificationType,
  lastMessage}` over `claude:status`. Canvas's listener maps events to a 4-state model
  (`UserPromptSubmit`→working, `Stop`→done, `Notification`→waiting/blocked) in the
  `claudeStatus` store, fires throttled (5s/node) background notifications, and records the
  session id. Header shows a pulsing **RUNNING** (working) / **NEEDS YOU** (waiting/blocked)
  badge; `state` is transient while `unread`/`session`/`sessionId` persist in localStorage.
- **Unread + notification** — on a busy→idle edge while the window is unfocused
  (`document.hasFocus()`), the node is marked unread (header dot, minimap stroke, project-tab
  dot). If notifications are enabled, `window.nodeTerminal.notify()` → main `app:notify`
  (shown only when `mainWin.isFocused()` is false); clicking it focuses the window and sends
  `app:focus-node` → `Canvas.focusNodeById` (selects + centers, switching projects via
  `pendingFocusRef` if needed). A one-time consent prompt gates notifications; toggle in
  Settings (`notifyOnClaudeDone`). Unread clears on focus/select.
- **Session name** — Claude's terminal title (via `term.onTitleChange`, filtered to non-path
  strings) is stored as `session` and shown as a chip beside the editable title.
- **Search** — the command palette (⌘K) matches the session name + tags + `nt-<id>` in the
  hint, and substring-searches each terminal's **visible buffer** (captured via `pty.capture`
  on palette open, cached ~3s); content matches show "found in output".
- **Subagent visualization** — `PreToolUse`/`PostToolUse` hooks (tool `Agent`/`Task`,
  correlated by `tool_use_id`) drive a transient `state/agentNodes.ts` store. Canvas renders
  each subagent as an **ephemeral** `SubagentNode` (display-only card: type + task +
  working/done) connected by an **edge** to its parent Claude node. These ephemeral nodes/edges
  live outside the React Flow `nodes` state (merged only at the `<ReactFlow>` prop), so they're
  never persisted (`flowToNodeStates`) nor in undo/dirty. Fan-out is cleared on the next
  `UserPromptSubmit` / `SessionEnd` / node close. (Subagents share the parent's process — no PTY.)
  Each card shows duration/tokens/tool-uses and **expands** (click) to a **live transcript**:
  `main/subagent-tail.ts` resolves the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl`, matched by `tool_use_id` via the sibling
  `.meta.json`), tails it read-only, formats each line (assistant text + tool calls + results),
  and streams chunks over `claude:subagent-activity` into the store.
- **/loop badge** — heuristic: `UserPromptSubmit` whose prompt starts with `/loop` sets
  `claudeStatus.loop`; each `Stop` bumps the count; cleared on `SessionEnd`. Shows a **LOOP ×N**
  header badge.
- **Branch conversation** — node action (`IconBranch`, Claude-only): sends `/branch` into the
  existing terminal via `pty.sendText` (tmux `send-keys`) and opens a new Claude node that
  resumes the parked original with `claude --settings … -r <ORIGINAL_ID>`. The original id is
  the session id already known from hooks; `lib/claudeBranch.ts` is the fallback that parses
  `pty.capture` output when the id isn't known. The source node stays on the new branch.

## Canvas interaction & panels (`Canvas.tsx` is the hub)

- **Context menus** (`components/ContextMenu.tsx`, portal, icons from `components/icons.tsx`):
  pane right-click = add nodes at cursor (terminal / Claude / sticky / open file) + select
  all + fit; node/selection right-click = group, color, duplicate, align-to-grid, collapse,
  markdown-view (terminals), delete. Actions live in `Canvas.tsx`, operate on `targetIds`.
- **Add menu** = bottom dock (`Dock.tsx`) `+`, mirrored by the pane menu and command palette.
- **Undo/redo**: debounced snapshot of the nodes array on settle (drag/edit), `pastRef`/
  `futureRef` stacks, ⌘Z / ⌘⇧Z + dock buttons. History resets per project load; skipped
  while typing in inputs/terminals.
- **Selection/pan**: box-select on left-drag (`SelectionMode.Partial` — touch to select);
  pan = middle-drag or trackpad two-finger (`panOnScroll`, `zoomOnScroll:false`); pinch
  zoom. Right mouse is free for the context menu.
- **Delete** (Delete/Backspace) opens `ConfirmDialog` before removing selected nodes.
- **Command palette** (`CommandPalette.tsx`): ⌘/Ctrl+K; `Canvas.buildCommands` (create,
  switch project, jump to node by title/tag, open file…).
- **Explorer** (`ExplorerPanel.tsx`, 🗂 / ⌘⇧E): lazy file tree of the active project `cwd`
  (`fs:list`); click a file → opens an editor node; right-click → Copy Path / Reveal.
- **Source Control** (`main/git-service.ts` system `git` + `gh`, `SourceControlPanel.tsx`,
  ⎇): file-level **stage/unstage** (+/−), **discard**, click a file → **diff node**,
  **branch switch/create**, commit (message box at top) + push / sync / publish, **gh
  sign-in** banner (runs `gh auth login` in a new terminal via `initialCommand`), recent
  commits. **AI commit message** (✦ Generate) and **AI terminal naming** both use
  `main/commit-message.ts`: a BYO local agent CLI (claude/codex/custom) spawned read-only on
  the staged diff / captured terminal output (no built-in model); agent + extra prompt in
  Settings.
- **Settings** (`SettingsPanel.tsx`, ⚙ / ⌘,): font/cursor (live to xterm + Monaco), default
  shell, grid + snap, pan-hover delay, double-click focus, accent, tmux on/scrollback,
  commit agent, `seenShortcuts`.
- **Shortcuts** (`ShortcutsPanel.tsx`, ? / ⌘/): shown once on first launch (`seenShortcuts`).
- **Welcome** (`WelcomeScreen.tsx`): shown when no projects exist.
- **Window chrome**: macOS integrated title bar (`titleBarStyle: 'hiddenInset'`); the tab
  bar (`TabBar.tsx`) is the drag region with the `nodeterm` logo + a rounded pill of project
  tabs. Cmd+M is intercepted in `main/index.ts` `before-input-event` (else macOS minimizes)
  and forwarded to the renderer via `app:toggle-markdown`.
- **Theme**: macOS dark palette as CSS tokens in `styles.css` `:root` (`--accent` = systemBlue,
  label/separator opacities, SF font stack). Canvas background is black with dot grid.

## Packaging & auto-update

Distributed as a free, closed-source Mac app (`.dmg`), built with **electron-builder** (config
in the `package.json` `build` block: appId `com.nodeterm.app`, productName `nodeterm`, mac dmg+zip
for arm64 **and** x64, `asarUnpack` node-pty, output `dist/`). The app icon is generated from the
nodeterm mark by `scripts/make-icon.mjs` (sharp → `build/icon.png`, 1024², gitignored — regenerated
by `make-icon`); electron-builder derives the `.icns`. Scripts: `npm run make-icon`, `npm run dist`
(local **unsigned** arm64 smoke test — forces `-c.mac.identity=null -c.mac.notarize=false`), and
`npm run release` (signed + notarized arm64+x64, what CI runs). Signing config is on:
`hardenedRuntime`, `gatekeeperAssess:false`, `notarize:true`, entitlements in
`build/entitlements.mac.plist`; the Developer ID cert + Apple creds come from env
(`CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`).

**Releases are self-hosted.** `build.publish` is the **generic** provider pointed at
`https://nodeterm.dev/updates`; electron-updater fetches `latest-mac.yml` (+ the `.zip` it
references) from there. `.dmg` = first-time download (linked from nodeterm.dev); `.zip`+`yml` =
what auto-update consumes. Release flow (bump version → tag `v*` → CI signs/notarizes → publish
feed) is documented in **`docs/RELEASING.md`**; CI is `.github/workflows/release.yml` (also keeps a
canonical GitHub Release copy).

Auto-update uses **electron-updater** (`src/main/updater.ts`, `initUpdater(win)` from `index.ts`):
runs **only when `app.isPackaged`** (dev = no-op), checks on launch + every 6h, forwards
`update-available` / `update-downloaded` to the renderer over IPC. `components/UpdateBanner.tsx`
shows a strip + **Restart to update** → `updates.restart()` → `autoUpdater.quitAndInstall()`.
Exposed via `window.nodeTerminal.updates` (`UpdateApi`). macOS *silent* self-install requires the
signed+notarized build; unsigned builds still surface the banner for a manual download.

**In-app announcements** (news, separate from updates): `src/main/announcements.ts` fetches
`https://nodeterm.dev/announcements.json` from the **main process** (so the renderer CSP stays
`'self'`), exposed as `window.nodeTerminal.announcements.fetch()`. `components/AnnouncementBanner.tsx`
(stacked with the update banner under the tab bar in a `.top-banners` column) shows the newest
item the user hasn't dismissed; dismissed `id`s persist in `localStorage`. Feed schema +
example: `docs/RELEASING.md` / `docs/announcements.example.json`.

## Conventions

- Code comments, UI strings, and identifiers are all in **English**. Match this when editing.
- Path aliases: `@shared/*`, `@renderer/*` (see the tsconfig files / vite config).
