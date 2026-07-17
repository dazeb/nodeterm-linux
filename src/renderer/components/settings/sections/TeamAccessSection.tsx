import { useEffect, useState } from 'react'
import { useEntitlement } from '../../../state/entitlement'
import { useTeamAccess } from '../../../state/teamAccess'
import { useTelegramBot } from '../../../state/telegramBot'
import { listSeats, usedCount, type SeatEntry } from '../../../state/teamAccessCore'
import { inviteShare, inviteShareTelegram, seatFullMessage, teamAccessView } from '../teamAccessView'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { CopyButton } from '@renderer/ui/CopyButton'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  team: {
    title: 'Team Access',
    keywords: ['team', 'seat', 'invite', 'share', 'collaborate', 'remote']
  }
}
const ENTRIES = Object.values(ROWS)

function SeatRow({ seat }: { seat: SeatEntry }): React.JSX.Element {
  const label = seat.email?.trim() || 'Teammate'
  const connected = seat.status === 'connected'
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm text-text">{label}</div>
        <div className="text-xs text-muted">
          {connected ? 'connected' : 'waiting to connect…'}
        </div>
      </div>
      <Button onClick={() => window.nodeTerminal.relayHost.revoke(seat.id)}>Remove</Button>
    </div>
  )
}

export function TeamAccessSection({
  isActive
}: {
  isActive: boolean
  onClose?: () => void
}): React.JSX.Element {
  const ent = useEntitlement()
  const seats = useEntitlement((s) => s.seats)
  const used = useTeamAccess((s) => usedCount(s.seats))
  const seatList = useTeamAccess((s) => listSeats(s.seats))
  const view = teamAccessView({ premium: ent.isPremium, seats, used })

  const [email, setEmail] = useState('')
  const [offer, setOffer] = useState('')
  const [offerEmail, setOfferEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [atCap, setAtCap] = useState(false)
  const [error, setError] = useState('')
  const [auth, setAuth] = useState<Awaited<ReturnType<typeof window.nodeTerminal.relayHost.auth.status>>>({ signedIn: false })
  const [deviceFlow, setDeviceFlow] = useState<Awaited<ReturnType<typeof window.nodeTerminal.relayHost.auth.begin>> | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  // Check if the Telegram bot is running (for the "Send via Telegram" button)
  const botUsername = useTelegramBot((s) => s.status.botUsername)

  useEffect(() => {
    if (!isActive) return
    void window.nodeTerminal.relayHost.auth.status().then(setAuth).catch(() => setAuth({ signedIn: false }))
  }, [isActive])

  const beginGitHubAuth = async () => {
    setAuthBusy(true)
    setError('')
    try {
      setDeviceFlow(await window.nodeTerminal.relayHost.auth.begin())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAuthBusy(false)
    }
  }

  const pollGitHubAuth = async () => {
    if (!deviceFlow) return
    setAuthBusy(true)
    setError('')
    try {
      const result = await window.nodeTerminal.relayHost.auth.poll(deviceFlow.deviceCode)
      if ('status' in result) {
        setError('Waiting for GitHub authorization. Complete the browser step, then try again.')
        return
      }
      setDeviceFlow(null)
      setAuth(await window.nodeTerminal.relayHost.auth.status())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAuthBusy(false)
    }
  }

  const signOutGitHub = async () => {
    setAuthBusy(true)
    try {
      await window.nodeTerminal.relayHost.auth.signOut()
      setAuth({ signedIn: false })
      setDeviceFlow(null)
    } finally {
      setAuthBusy(false)
    }
  }

  const generateInvite = async () => {
    setError('')
    setAtCap(false)
    setBusy(true)
    const invitedEmail = email.trim()
    try {
      const { offer: code, id } = await window.nodeTerminal.relayHost.invite({
        email: invitedEmail || undefined
      })
      // Show the pending row immediately — the store also flips it to connected on relay:host:open.
      useTeamAccess.getState().addPending(id, invitedEmail || undefined)
      setOffer(code)
      setOfferEmail(invitedEmail)
      setEmail('')
    } catch (err) {
      if (seatFullMessage(err)) setAtCap(true)
      else setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const share = offer ? inviteShare({ offer, email: offerEmail }) : null

  return (
    <SettingsSection
      id="team-access"
      title="Team Access"
      description="Share this machine with your team — one seat per teammate."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.team}>
        <div className="mb-5 space-y-3 rounded-lg border border-separator px-4 py-3">
          {auth.signedIn ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-[13px] font-medium text-text">GitHub host account</h4>
                <p className="text-sm text-muted">
                  Signed in as {auth.githubLogin}
                  {auth.activeSeats !== undefined && auth.maxActiveSeats !== undefined ? ` · ${auth.activeSeats} / ${auth.maxActiveSeats} seats` : ''}
                </p>
              </div>
              <Button disabled={authBusy} onClick={() => void signOutGitHub()}>Sign out</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <h4 className="text-[13px] font-medium text-text">GitHub host account</h4>
                <p className="text-sm text-muted">Sign in with GitHub to host Team Access invitations. Invitees do not need an account.</p>
              </div>
              {deviceFlow ? (
                <div className="flex items-center gap-3">
                  <code className="rounded bg-fill px-2 py-1 text-sm text-text">{deviceFlow.userCode}</code>
                  <Button variant="primary" disabled={authBusy} onClick={() => void pollGitHubAuth()}>{authBusy ? 'Checking…' : 'I authorized GitHub'}</Button>
                </div>
              ) : <Button variant="primary" disabled={authBusy} onClick={() => void beginGitHubAuth()}>{authBusy ? 'Opening GitHub…' : 'Sign in with GitHub'}</Button>}
            </div>
          )}
        </div>
        {!view.gated ? (
          <div className="space-y-5">
            {/* Seat counter */}
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-[13px] font-medium text-text">Seats</h4>
                <p className="text-sm text-muted">{view.counterText}</p>
              </div>
              <Button onClick={() => void ent.upgrade()}>Add seats</Button>
            </div>

            {/* Connected devices */}
            <div className="space-y-2">
              <h4 className="text-[13px] font-medium text-text">Connected devices</h4>
              {seatList.length === 0 ? (
                <p className="text-sm text-muted">No teammates connected yet.</p>
              ) : (
                <div className="space-y-2">
                  {seatList.map((seat) => (
                    <SeatRow key={seat.id} seat={seat} />
                  ))}
                </div>
              )}
            </div>

            {/* Invite */}
            <div className="space-y-3">
              <h4 className="text-[13px] font-medium text-text">Invite a teammate</h4>
              <p className="text-sm text-muted">
                A teammate on a seat can run commands on this Mac — the same as giving them SSH
                access. Only invite people you trust.
              </p>
              <FieldRow
                label="Teammate email"
                control={
                  <Input
                    className="w-72"
                    type="email"
                    placeholder="teammate@example.com (optional)"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                }
              />
              <Button
                variant="primary"
                disabled={busy || !view.canInvite}
                onClick={() => void generateInvite()}
              >
                {busy ? 'Generating…' : 'Generate invite'}
              </Button>
              {!view.canInvite ? (
                <p className="text-sm text-muted">All seats in use — add a seat.</p>
              ) : null}
              {atCap ? (
                <p className="text-sm" style={{ color: '#ff9f0a' }}>
                  All seats in use — add a seat.
                </p>
              ) : null}
              {error ? (
                <p className="text-sm" style={{ color: '#ff9f0a' }}>
                  {error}
                </p>
              ) : null}
              {offer && share ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted">
                    Share this single-use invite link with{' '}
                    <strong className="text-text">{offerEmail || 'your teammate'}</strong> — they
                    open it in nodeterm:
                  </p>
                  <FieldRow
                      label="Invite link"
                    control={
                      <Input
                        className="w-72"
                        readOnly
                        value={offer}
                        onFocus={(e) => e.target.select()}
                      />
                    }
                  />
                  <div className="flex gap-2 flex-wrap">
                    <CopyButton text={share.copyText} label="Copy invite link" />
                    <Button onClick={() => window.nodeTerminal.shell.openExternal(share.mailtoUrl)}>
                      Open in Mail
                    </Button>
                    {botUsername ? (
                      <Button
                        onClick={() => {
                          const tgLink = inviteShareTelegram(offer, botUsername, offerEmail)
                          if (tgLink) window.nodeTerminal.shell.openExternal(tgLink)
                        }}
                      >
                        Send via Telegram
                      </Button>
                    ) : null}
                  </div>
                  {botUsername ? (
                    <p className="text-xs text-muted">
                      Or share via Telegram — the bot @{botUsername} will deliver the invite code.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h4 className="text-[13px] font-medium text-text">
              Share this Mac with your team
            </h4>
            <p className="text-sm text-muted">
              One seat per teammate, $5/seat/month. Each teammate connects from their own device
              over the end-to-end encrypted relay.
            </p>
            <p className="text-sm text-muted">
              A seat grants shell access: a teammate on a seat can run commands on this Mac — the
              same as giving them SSH access. Every connection is still verified with a one-time
              pairing code you compare together.
            </p>
            <Button variant="primary" onClick={() => void ent.upgrade()}>
              Get Team Access
            </Button>
          </div>
        )}
      </SearchableRow>
    </SettingsSection>
  )
}
