# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Open-source **node-based terminal manager**: multiple real terminals live on a single
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

**React Flow is the single live source of truth** for nodes (position, size, and the
`data` payload: title, color, group, shell, cwd, text). There is intentionally no separate
store mirroring node state — earlier dual-source designs caused sync bugs.
`src/renderer/state/workspace.ts` holds only pure helpers: the color palette,
`createTerminalNode` / `createStickyNode`, and `nodesToWorkspace` / `workspaceToNodes`
serializers. Node types are `'terminal'` and `'sticky'`; `workspaceToNodes` defaults a
missing `kind` to `'terminal'` for backward compat with older `workspace.json` files.

Persistence has two layers:

- **Layout + config** (`workspace.json`, schema v2): a list of **projects**, each with its
  own `nodes`, `viewport`, `color`, and default `cwd`, plus the `activeProjectId`. Auto-saved
  on a debounce (and via the dock Save button). Lives in `app.getPath('userData')`.
  `main/workspace-store.ts` migrates older v1 single-canvas files into one default project
  on load; the renderer re-saves the migrated form on launch.
- **Live terminal sessions** (tmux): terminals continue where they left off across node
  remounts *and* full app restarts, including running processes. See below.

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
  their tmux sessions); the last project can't be deleted.
- A project's `cwd` (set via the native folder picker, `dialog:select-folder` IPC) is passed
  to `createTerminalNode` so new terminals open there.

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
- The terminal body div carries `nodrag nowheel` so clicks/scroll go to xterm instead of
  dragging the node or zooming the canvas. The header stays draggable.
- A `ResizeObserver` drives `FitAddon.fit()` + `transport.resize`. Canvas zoom is a CSS
  transform, so it does *not* change `clientWidth` — cols/rows stay stable across zoom by
  design.

## Canvas features & where they live

- **Node model** (`shared/types.ts` `CanvasNodeState`, `renderer/state/workspace.ts` `NodeData`):
  kinds are `terminal | sticky | group`; nodes carry `tags`, `collapsed`, `parentId`.
  `nodeStatesToFlow` sorts groups (parents) before children and maps `collapsed` to a
  shrunk `style.height` (keeping the expanded height in `data.expandedHeight`);
  `flowToNodeStates` persists the expanded height while collapsed.
- **Context menus** (`components/ContextMenu.tsx`, portal): `onPaneContextMenu` (new node
  at cursor, select all, fit), `onNodeContextMenu`/`onSelectionContextMenu` (group, color,
  align-to-grid, collapse, delete). All actions live in `Canvas.tsx` and operate on the
  selection (`targetIds`).
- **Grouping** (`nodes/GroupNode.tsx`, `groupSelectedNodes`/`ungroupNodes` in workspace.ts):
  real React Flow parent/child; children get `parentId` + `extent:'parent'` and
  parent-relative positions. Deleting/removing a group reparents children to absolute.
- **Command palette** (`components/CommandPalette.tsx`): Cmd/Ctrl+K; commands built in
  `Canvas.buildCommands` (create actions, switch project, jump to node by title/tag).
- **Settings** (`main/settings-store.ts` + `settings.json`, `state/settings.ts` zustand,
  `components/SettingsPanel.tsx`): font/cursor (applied live to xterm), default shell, grid
  size + snap, pan-hover delay, double-click focus, accent (`--accent` CSS var), tmux
  enabled + scrollback. `PtyManager` reads settings via the getter passed to `init()`.
- **Source Control** (`main/git-service.ts` using system `git` + `gh`,
  `components/SourceControlPanel.tsx`): per active-project `cwd` — status/init/commit/
  push/pull/publish. No file-level diff.
- **Top-right cluster** in `Canvas.tsx`: palette (⌕), source control (⎇), settings (⚙).

## Conventions

- Code comments, UI strings, and identifiers are all in **English**. Match this when editing.
- Path aliases: `@shared/*`, `@renderer/*` (see the tsconfig files / vite config).
