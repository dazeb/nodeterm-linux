import { createPortal } from 'react-dom'
import type { RemoteInvite } from '@shared/types'
import { useDialogStack } from './dialog-stack'
import { hostKeyLabel, type RemoteInviteState } from '@renderer/lib/remoteInvite'
import { Button } from '@renderer/ui/Button'

export function RemoteInviteDialog({
  state,
  onConnect,
  onCancel,
  onUseReplacement,
  onKeepCurrent
}: {
  state: RemoteInviteState
  onConnect(invite: RemoteInvite): void
  onCancel(): void
  onUseReplacement(): void
  onKeepCurrent(): void
}): React.JSX.Element | null {
  const isTop = useDialogStack()
  const invite = state.pending
  if (!invite) return null

  return createPortal(
    <div
      className="confirm-overlay"
      onClick={() => {
        if (isTop()) onCancel()
      }}
    >
      <div className="remote-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="remote-dialog__head">
          <h3>Join remote team?</h3>
          <button className="remote-dialog__x" onClick={onCancel} title="Cancel">
            ×
          </button>
        </div>

        <p className="remote-dialog__desc">
          This invite can grant this device shell-level access to the remote host. Only continue if
          you trust the sender.
        </p>

        <div className="remote-dialog__block">
          <p className="remote-dialog__hint">Relay: <code>{invite.relayEndpoint}</code></p>
          <p className="remote-dialog__hint" style={{ marginTop: 8 }}>
            Host key: <code>{hostKeyLabel(invite.hostPublicKeyB64)}</code>
          </p>
          <p className="remote-dialog__hint" style={{ marginTop: 8 }}>
            You will compare a security code with the host before access opens.
          </p>
        </div>

        {state.replacement ? (
          <div className="remote-dialog__block" style={{ marginTop: 12 }}>
            <p className="remote-dialog__hint">A different invite was opened while this one was pending.</p>
            <div className="remote-dialog__row" style={{ marginTop: 10 }}>
              <Button onClick={onKeepCurrent}>Keep current</Button>
              <Button onClick={onUseReplacement}>Use new invite</Button>
            </div>
          </div>
        ) : null}

        <div className="remote-dialog__row" style={{ marginTop: 16 }}>
          <Button variant="primary" onClick={() => onConnect(invite)}>Connect</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
