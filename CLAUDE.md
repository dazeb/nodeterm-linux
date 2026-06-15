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
`data` payload: title, color, group, shell, cwd). There is intentionally no separate
store mirroring node state — earlier dual-source designs caused sync bugs.
`src/renderer/state/workspace.ts` holds only pure helpers: the color palette,
`createTerminalNode`, and `nodesToWorkspace` / `workspaceToNodes` serializers.

Persistence is **layout + config only**, not session content. On load, nodes respawn
fresh PTYs (at their saved `cwd`); scrollback is not restored. Saving serializes current
React Flow nodes + viewport to one `workspace.json`.

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

## Conventions

- Code comments, UI strings, and identifiers are all in **English**. Match this when editing.
- Path aliases: `@shared/*`, `@renderer/*` (see the tsconfig files / vite config).
