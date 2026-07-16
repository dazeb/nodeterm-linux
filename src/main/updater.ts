// Auto-update client (electron-updater). Uses GitHub Releases to check for and download
// updates from the dazeb/nodeterm-linux repository. The GitHub provider auto-detects release
// artifacts by platform: AppImage + deb for Linux, dmg + zip for macOS.
//
// The feed URL is configured at runtime so the fork always checks the right repo regardless
// of the build-time electron-builder publish config. The package.json publish block is kept
// in sync as a fallback for electron-builder's own build metadata.
import { app, ipcMain, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../shared/ipc'
import { getMainWindow, sendToMain } from './main-window'
import { retainUntilDismissed } from './notifications'

/** GitHub owner/repo for this fork. */
const GH_OWNER = 'dazeb'
const GH_REPO = 'nodeterm-linux'

const SIX_HOURS = 6 * 60 * 60 * 1000

/**
 * The window is resolved AT EVENT TIME (getMainWindow/sendToMain) — never captured in a closure.
 * On macOS the window can be closed (the app lives on) and recreated from the dock, so a captured
 * reference is a DESTROYED window: touching it throws `TypeError: Object has been destroyed`. That
 * shipped — an update finishing downloading after a close→dock-reopen crashed the main process on
 * `win.isFocused()`.
 *
 * @param onBeforeRestart Run right before `quitAndInstall()`. Required so the caller can flip its
 *   "quitting" flag: `quitAndInstall()` closes all windows and only then calls `app.quit()`, but
 *   our `win.on('close')` hides the window (keeps the app alive) unless we're already quitting — so
 *   without this the window just hides, `app.quit()` never fires, and the update never installs.
 */
export function initUpdater(onBeforeRestart?: () => void): void {
  const send = (channel: string, payload?: unknown) => sendToMain(channel, payload)

  // Always available, even in dev: current version, manual check, restart.
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.on(IPC.appRestartToUpdate, () => {
    onBeforeRestart?.()
    autoUpdater.quitAndInstall()
  })

  if (!app.isPackaged) {
    // Dev: there is no update server. A manual check reports "up to date" so the Settings
    // button still gives feedback; automatic checks are skipped entirely.
    ipcMain.on(IPC.appCheckForUpdates, () => send(IPC.appUpdateNotAvailable))
    return
  }

  // Pin the feed URL to the GitHub Releases API for this fork. This means the updater
  // works even if the build-time electron-builder publish config was targeting a different
  // server (e.g. the upstream generic provider). The package.json publish block is kept in
  // sync as a convenience for electron-builder's own metadata embedding, but the runtime
  // config is authoritative.
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: GH_OWNER,
    repo: GH_REPO,
    private: false
  })

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    send(IPC.appUpdateAvailable, { version: info.version, notes: info.releaseNotes ?? '' })
  })

  autoUpdater.on('download-progress', (p) => {
    send(IPC.appUpdateProgress, {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send(IPC.appUpdateDownloaded, { version: info.version })
    // OS notification only when the window is in the background; the card covers the foreground.
    // Resolve the window HERE, not at init: a download can finish long after a close→dock-reopen.
    // No live window (closed on macOS) reads as "not focused", which is exactly when we notify.
    if (!getMainWindow()?.isFocused() && Notification.isSupported()) {
      const n = new Notification({
        title: 'Update ready',
        body: `nodeterm-linux ${info.version} is ready to install.`
      })
      n.on('click', () => {
        // Resolve again on click — the window may have been closed or recreated since.
        const w = getMainWindow()
        if (!w) return
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      })
      // Keep a reference or GC silently kills the click handler (electron/electron#16922).
      retainUntilDismissed(n)
      n.show()
    }
  })

  autoUpdater.on('update-not-available', () => send(IPC.appUpdateNotAvailable))

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err)
    console.error('[updater]', message)
    send(IPC.appUpdateError, message)
  })

  // Manual check from Settings; surfaces failures to the card.
  ipcMain.on(IPC.appCheckForUpdates, () => {
    autoUpdater.checkForUpdates().catch((err) => {
      const message = err?.message ?? String(err)
      console.error('[updater]', message)
      send(IPC.appUpdateError, message)
    })
  })

  // Automatic checks: on launch and every six hours.
  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }
  check()
  setInterval(check, SIX_HOURS)
}
