import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { useTelegramBot } from '@renderer/state/telegramBot'

const ROWS = {
  setup: {
    title: 'Telegram bot setup',
    keywords: ['telegram', 'bot', 'token', 'qr', 'connect', 'remote', 'phone', 'mobile']
  },
  status: {
    title: 'Bot status',
    keywords: ['telegram', 'bot', 'status', 'running', 'active']
  }
}
const ENTRIES = Object.values(ROWS)

export function TelegramSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const status = useTelegramBot((s) => s.status)
  const start = useTelegramBot((s) => s.start)
  const stop = useTelegramBot((s) => s.stop)
  const hydrate = useTelegramBot((s) => s.hydrate)
  const [tokenInput, setTokenInput] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

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
              <p className="text-sm" style={{ color: '#30d158' }}>
                ✓ Running {status.botUsername ? `as @${status.botUsername}` : ''}
              </p>
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
              <Button onClick={() => void handleStop()} disabled={busy}>
                {busy ? 'Stopping…' : 'Stop bot'}
              </Button>
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
            <Button variant="primary" disabled={busy || !tokenInput.trim()} onClick={() => void handleStart()}>
              {busy ? 'Starting…' : 'Start bot'}
            </Button>
          </div>
        </SearchableRow>
      )}
    </SettingsSection>
  )
}
