import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { useProjects } from '../state/projects'
import { hostShareOptions } from '../lib/relayHostShare'
import { Button } from '@renderer/ui/Button'
import { CopyButton } from '@renderer/ui/CopyButton'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'

/**
 * Remote access dialog — a self-contained popup reachable from the project (tab) caret menu.
 * Hosting and connecting are both free.
 */
export function RemoteAccessDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const projects = useProjects((s) => s.projects)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const [hostOffer, setHostOffer] = useState('')
  const [hostBusy, setHostBusy] = useState(false)
  const [error, setError] = useState('')
  const [clientCode, setClientCode] = useState('')

  const shareOptions = hostShareOptions(projects, activeProjectId)
  const [shareId, setShareId] = useState('')
  const effectiveShareId = shareOptions.some((o) => o.id === shareId)
    ? shareId
    : (shareOptions[0]?.id ?? '')
  const sharedName = shareOptions.find((o) => o.id === effectiveShareId)?.name ?? ''

  const isTop = useDialogStack()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onClose])

  const startHosting = async () => {
    setError('')
    setHostBusy(true)
    try {
      const { offer } = await window.nodeTerminal.relayHost.start(effectiveShareId || undefined)
      setHostOffer(offer)
    } catch (err) {
      setError((err as Error).message)
      setHostBusy(false)
    }
  }
  const stopHosting = async () => {
    await window.nodeTerminal.relayHost.stop()
    setHostOffer('')
    setHostBusy(false)
  }
  const connect = () => {
    const code = clientCode.trim()
    if (!code) return
    setClientCode('')
    window.dispatchEvent(
      new CustomEvent('nodeterm:open-remote-terminal', { detail: { offer: code } })
    )
    onClose()
  }

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div className="remote-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="remote-dialog__head">
          <h3>Remote access</h3>
          <button className="remote-dialog__x" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <p className="remote-dialog__desc">
          Open terminals that run on another machine you own — end-to-end encrypted over the relay.
        </p>

        <h4 className="remote-dialog__head4">Allow remote access</h4>
        {hostOffer ? (
          <div className="remote-dialog__block">
            <p className="remote-dialog__hint">
              Sharing <strong>{sharedName || 'this project'}</strong> — the joiner will see this
               project and can run commands on this machine. Share this invite link (single use):
            </p>
            <Input
              className="w-full"
              readOnly
              value={hostOffer}
              onFocus={(e) => e.target.select()}
            />
            <div className="remote-dialog__row">
              <CopyButton text={hostOffer} label="Copy invite link" />
              <Button onClick={() => void stopHosting()}>Stop sharing</Button>
            </div>
          </div>
        ) : (
          <div className="remote-dialog__block">
            {shareOptions.length > 1 ? (
              <label className="remote-dialog__hint">
                Project to share
                <Select
                  className="w-full mt-1"
                  value={effectiveShareId}
                  onChange={(e) => setShareId(e.target.value)}
                >
                  {shareOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : (
              <p className="remote-dialog__hint">
                Sharing <strong>{sharedName || 'this project'}</strong> — the joiner sees this
                project and can run commands on this machine.
              </p>
            )}
            <Button disabled={hostBusy} onClick={() => void startHosting()}>
              {hostBusy ? 'Starting…' : 'Allow remote access'}
            </Button>
          </div>
        )}

        <h4 className="remote-dialog__head4">Connect to a host</h4>
        <div className="remote-dialog__block">
          <Input
            className="w-full"
            placeholder="paste the host's invite link"
            value={clientCode}
            onChange={(e) => setClientCode(e.target.value)}
          />
          <Button disabled={!clientCode.trim()} onClick={connect}>
            Connect
          </Button>
        </div>

        {error ? <p className="remote-dialog__err">{error}</p> : null}
      </div>
    </div>,
    document.body
  )
}
