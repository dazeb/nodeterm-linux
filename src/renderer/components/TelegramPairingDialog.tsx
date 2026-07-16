// A compact approval dialog shown when a Telegram user requests to pair.
// Rendered as a portal to document.body, same pattern as RemoteAccessDialog.

import { createPortal } from 'react-dom'
import { Button } from '@renderer/ui/Button'
import { useTelegramBot } from '@renderer/state/telegramBot'

export function TelegramPairingDialog(): React.JSX.Element | null {
  const pendingPairing = useTelegramBot((s) => s.pendingPairing)
  const acceptPairing = useTelegramBot((s) => s.acceptPairing)
  const rejectPairing = useTelegramBot((s) => s.rejectPairing)

  if (!pendingPairing) return null

  return createPortal(
    <div className="confirm-overlay" onClick={() => rejectPairing(pendingPairing.code)}>
      <div className="remote-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="remote-dialog__head">
          <h3>Telegram pairing request</h3>
          <button
            className="remote-dialog__x"
            onClick={() => rejectPairing(pendingPairing.code)}
            title="Dismiss"
          >
            ×
          </button>
        </div>

        <p className="remote-dialog__desc">
          <strong>{pendingPairing.name}</strong> wants to pair with this bot and access this machine
          remotely.
        </p>

        <div className="remote-dialog__block">
          <p className="remote-dialog__hint">
            Pairing code: <code>{pendingPairing.code}</code>
          </p>
          <p className="remote-dialog__hint" style={{ marginTop: 8 }}>
            This grants remote terminal access — the same as SSH access. Only approve users you
            trust.
          </p>
        </div>

        <div className="remote-dialog__row" style={{ marginTop: 16 }}>
          <Button
            variant="primary"
            onClick={() => acceptPairing(pendingPairing.code)}
          >
            Approve
          </Button>
          <Button onClick={() => rejectPairing(pendingPairing.code)}>Reject</Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
