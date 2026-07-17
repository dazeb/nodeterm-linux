import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { useTelegramBot } from '@renderer/state/telegramBot'
import type { TelegramApprovedUser } from '@shared/types'

const ROWS = {
  setup: {
    title: 'Telegram bot setup',
    keywords: ['telegram', 'bot', 'token', 'qr', 'connect', 'remote', 'phone', 'mobile']
  },
  status: {
    title: 'Bot status',
    keywords: ['telegram', 'bot', 'status', 'running', 'active']
  },
  pairings: {
    title: 'Pending pairings',
    keywords: ['telegram', 'pairing', 'code', 'approve', 'pending']
  },
  approved: {
    title: 'Approved users',
    keywords: ['telegram', 'approved', 'users', 'paired', 'revoke']
  }
}
const ENTRIES = Object.values(ROWS)

function ApprovedUserRow({
  user,
  onRevoke
}: {
  user: TelegramApprovedUser
  onRevoke: (chatId: number) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm text-text">{user.name}</div>
        <div className="text-xs text-muted">
          Paired {new Date(user.pairedAt).toLocaleDateString()}
        </div>
      </div>
      <Button onClick={() => onRevoke(user.chatId)}>Revoke</Button>
    </div>
  )
}

export function TelegramSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const status = useTelegramBot((s) => s.status)
  const pendingPairing = useTelegramBot((s) => s.pendingPairing)
  const approvedUsers = useTelegramBot((s) => s.approvedUsers)
  const start = useTelegramBot((s) => s.start)
  const stop = useTelegramBot((s) => s.stop)
  const hydrate = useTelegramBot((s) => s.hydrate)
  const acceptPairing = useTelegramBot((s) => s.acceptPairing)
  const rejectPairing = useTelegramBot((s) => s.rejectPairing)
  const loadApprovedUsers = useTelegramBot((s) => s.loadApprovedUsers)
  const revokeUser = useTelegramBot((s) => s.revokeUser)
  const [tokenInput, setTokenInput] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void hydrate()
    void loadApprovedUsers()
  }, [hydrate, loadApprovedUsers])

  const handleStart = async () => {
    setBusy(true)
    await start(tokenInput.trim() || undefined)
    setBusy(false)
  }

  const handleStop = async () => {
    setBusy(true)
    await stop()
    setBusy(false)
  }

  const handleAccept = () => {
    if (pendingPairing) acceptPairing(pendingPairing.code)
  }

  const handleReject = () => {
    if (pendingPairing) rejectPairing(pendingPairing.code)
  }

  const handleRevoke = async (chatId: number) => {
    await revokeUser(chatId)
  }

  const botLink = status.botUsername ? `https://t.me/${status.botUsername}` : null
  const qrData = botLink
    ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(botLink)}`
    : null

  return (
    <SettingsSection
      id="telegram"
      title="Telegram bot"
      description="Control your terminals remotely through a Telegram bot."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.status}>
        <div className="space-y-3">
          <h4 className="text-[13px] font-medium text-text">Bot status</h4>
          {status.running ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm" style={{ color: '#30d158' }}>
                  ✓ Running {status.botUsername ? `as @${status.botUsername}` : ''}
                </span>
                {status.approvedUserCount > 0 ? (
                  <span className="text-xs text-muted">
                    — {status.approvedUserCount} paired user{status.approvedUserCount !== 1 ? 's' : ''}
                  </span>
                ) : null}
              </div>
              {status.botIdMasked ? (
                <p className="text-xs text-muted">
                  Bot id (masked for privacy):{' '}
                  <code className="bg-bg-tertiary px-1 rounded">{status.botIdMasked}</code>
                </p>
              ) : null}
              {qrData && (
                <div className="space-y-1">
                  <img
                    src={qrData}
                    width={200}
                    height={200}
                    alt="Telegram bot QR code"
                    className="rounded-lg bg-white p-2"
                  />
                  <p className="text-xs text-muted">
                    Scan with your phone to open the bot, or visit{' '}
                    <a
                      href={botLink!}
                      onClick={(e) => {
                        e.preventDefault()
                        window.nodeTerminal.shell.openExternal(botLink!)
                      }}
                      className="underline"
                    >
                      {botLink}
                    </a>
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={() => void handleStop()} disabled={busy}>
                  {busy ? 'Stopping…' : 'Stop bot'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted">
                {status.error
                  ? `Error: ${status.error}`
                  : 'Bot is not running. Enter your bot token to start.'}
              </p>
              {status.error && (
                <p className="text-xs text-muted">
                  Create a bot via{' '}
                  <a
                    href="https://t.me/botfather"
                    onClick={(e) => {
                      e.preventDefault()
                      window.nodeTerminal.shell.openExternal('https://t.me/botfather')
                    }}
                    className="underline"
                  >
                    @BotFather
                  </a>{' '}
                  and paste the token below.
                </p>
              )}
            </div>
          )}
        </div>
      </SearchableRow>

      {!status.running && (
        <SearchableRow {...ROWS.setup}>
          <div className="mt-4 space-y-3">
            <h4 className="text-[13px] font-medium text-text">Start the bot</h4>
            <FieldRow
              label="Bot token"
              control={
                <Input
                  className="w-80"
                  type="password"
                  placeholder="123456:ABCdef..."
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
              }
            />
            <p className="text-xs text-muted">
              Get a token from{' '}
              <a
                href="https://t.me/botfather"
                onClick={(e) => {
                  e.preventDefault()
                  window.nodeTerminal.shell.openExternal('https://t.me/botfather')
                }}
                className="underline"
              >
                @BotFather
              </a>{' '}
              on Telegram. The bot needs to be able to send messages — no special permissions required.
            </p>
            <Button
              variant="primary"
              disabled={busy || !tokenInput.trim()}
              onClick={() => void handleStart()}
            >
              {busy ? 'Starting…' : 'Start bot'}
            </Button>
          </div>
        </SearchableRow>
      )}

      {/* Pending pairing — shown regardless of running state if there's an active code */}
      {pendingPairing ? (
        <SearchableRow {...ROWS.pairings}>
          <div className="mt-4 space-y-3">
            <h4 className="text-[13px] font-medium text-text">Pairing request</h4>
            <p className="text-sm text-muted">
              <strong className="text-text">{pendingPairing.name}</strong> wants to pair with
              this bot. Their pairing code is{' '}
              <code className="bg-bg-tertiary px-1 rounded">{pendingPairing.code}</code>.
            </p>
            <p className="text-xs text-muted">
              This will grant them remote terminal access to this machine — the same as SSH access.
              Only approve users you trust.
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={handleAccept}>
                Approve
              </Button>
              <Button onClick={handleReject}>Reject</Button>
            </div>
          </div>
        </SearchableRow>
      ) : null}

      {/* Approved users list */}
      {status.running ? (
        <SearchableRow {...ROWS.approved}>
          <div className="mt-4 space-y-3">
            <h4 className="text-[13px] font-medium text-text">Approved users</h4>
            {approvedUsers === null ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : approvedUsers.length === 0 ? (
              <p className="text-sm text-muted">
                No approved users yet. Users send /pair in Telegram to request access.
              </p>
            ) : (
              <div className="space-y-2">
                {approvedUsers.map((user) => (
                  <ApprovedUserRow
                    key={user.chatId}
                    user={user}
                    onRevoke={handleRevoke}
                  />
                ))}
              </div>
            )}
          </div>
        </SearchableRow>
      ) : null}
    </SettingsSection>
  )
}
