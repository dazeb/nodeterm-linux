// Telegram bot service for remote terminal access.
// Provides a Bot API to list, read, and interact with nodeterm tmux sessions over Telegram.
// Commands are GATED on user approval (pairing flow): /pair, /start, /help, /status are public;
// /terminals, /attach, /send, /invite require the Telegram user to be paired first.
//
// Pairing flow:
//   1. User sends /pair → bot generates 6-digit code → broadcasts IPC to desktop
//   2. Desktop user sees notification → accepts or rejects
//   3. On accept → chat_id is pinned → user can use terminal commands
//
// The approved-user list is persisted at <userData>/telegram-approved.json.

import { Telegraf, Markup } from 'telegraf'
import type { Context } from 'telegraf'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import type {
  TelegramBotStatus,
  TelegramPairingCodeEvent,
  TelegramApprovedUser as TelegramApprovedUserType
} from '../shared/types'
import {
  emptyTelegramApproved,
  parseTelegramApproved,
  isTelegramApproved,
  pinTelegramUser,
  unpinTelegramUser,
  listApprovedUsers,
  approvedUserCount,
  type TelegramApprovedStore
} from './telegram-approved'
import {
  createPairingRequest,
  claimPairingCode,
  pruneExpiredPairings
} from './telegram-pairing'
import type { TelegramApprovedUser } from './telegram-approved'

export interface TelegramSessionInfo {
  id: string
  title?: string
  cwd?: string
}

export interface TelegramBotDeps {
  listSessions(): Promise<TelegramSessionInfo[]>
  captureSession(sessionId: string): Promise<string>
  sendInput(sessionId: string, text: string): Promise<void>
  /**
   * Generate a Team Access invite via the relay host. Returns a pairing offer
   * the bot can forward to the user. Undefined when Pro is not available.
   */
  inviteTeammate?(opts: { email?: string }): Promise<{ offer: string; id: string }>
}

// ── Module-level state ──────────────────────────────────────────────────────────

let bot: Telegraf | null = null
let deps: TelegramBotDeps | null = null
let approvedFile: string | null = null
let botStatus: TelegramBotStatus = {
  running: false,
  botUsername: null,
  error: null,
  approvedUserCount: 0
}
let approvedStore: TelegramApprovedStore = emptyTelegramApproved()
/** Pending pairing codes keyed by 6-digit code. */
const pendingPairings = new Map<string, TelegramPairingRequest>()

// ── Helpers ─────────────────────────────────────────────────────────────────────

function broadcast(): void {
  platform().broadcast(IPC.telegramBotStatus, botStatus)
}

/** Broadcast a pairing-code event to the renderer. */
function broadcastPairingCode(
  code: string,
  name: string,
  chatId: number,
  expiresAt: number
): void {
  const event: TelegramPairingCodeEvent = { code, name, chatId, expiresAt }
  platform().broadcast(IPC.telegramBotPairingCode, event)
}

function getDeps(): TelegramBotDeps {
  if (!deps) throw new Error('Telegram bot deps not initialized')
  return deps
}

/** Load the approved users file from disk. Returns empty store if absent/malformed. */
async function loadApprovedFromDisk(filePath: string): Promise<TelegramApprovedStore> {
  try {
    return parseTelegramApproved(JSON.parse(await fs.readFile(filePath, 'utf-8')))
  } catch {
    return emptyTelegramApproved()
  }
}

/** Persist the approved users file atomically (temp + rename, 0600). */
async function saveApprovedToDisk(filePath: string, store: TelegramApprovedStore): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(tmp, filePath)
}

/** Reload the store from disk and update the status counter. */
async function reloadApproved(): Promise<void> {
  if (!approvedFile) return
  approvedStore = await loadApprovedFromDisk(approvedFile)
  botStatus = { ...botStatus, approvedUserCount: approvedUserCount(approvedStore) }
  broadcast()
}

/** Persist the current store to disk and update the status counter. */
async function persistApproved(): Promise<void> {
  if (!approvedFile) return
  await saveApprovedToDisk(approvedFile, approvedStore)
  botStatus = { ...botStatus, approvedUserCount: approvedUserCount(approvedStore) }
  broadcast()
}

/** Require that the chat_id is approved. Returns a reply string to send if not, or null if OK. */
function requireApproved(chatId: number): string | null {
  if (isTelegramApproved(approvedStore, chatId)) return null
  return "🔒 You're not paired. Send /pair to get a pairing code, then approve it in the nodeterm app."
}

/** Only call if ctx.message exists and has text. */
function msgArgs(ctx: Context): string[] {
  if (ctx.message && 'text' in ctx.message) {
    return ctx.message.text.split(' ')
  }
  return []
}

/** Garbage-collect expired pairings every time we touch the map. */
function prune(): void {
  pruneExpiredPairings(pendingPairings)
}

// ── Bot commands ────────────────────────────────────────────────────────────────

function registerCommands(b: Telegraf): void {
  // /start — welcome message with menu
  b.start((ctx: Context) => {
    const msg = [
      '👋 *nodeterm bot active*',
      '',
      '📋 *Commands:*',
      '/pair — Pair this Telegram account with nodeterm',
      '/status — Bot connection status',
      '/help — Full command list',
      '',
      'After pairing:',
      '/terminals — List active terminal sessions',
      '/attach N — View terminal N output',
      '/send N <text> — Send text to terminal N'
    ].join('\n')
    void ctx.reply(msg, { parse_mode: 'Markdown' })
  })

  // /help — command list
  b.help((ctx: Context) => {
    const paired = isTelegramApproved(approvedStore, ctx.from?.id ?? 0)
    const lines = [
      '*Commands:*',
      '/start — Welcome',
      '/help — This help',
      '/status — Bot connection status',
      '/pair — Pair this Telegram account with nodeterm',
      ...(paired ? [
        '/terminals — List active sessions',
        '/attach N — View terminal N output',
        '/send N <text> — Send text to terminal N'
      ] : [
        '',
        '_Send /pair first to unlock terminal commands._'
      ])
    ]
    void ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
  })

  // /status — bot + approval status
  b.command('status', (ctx: Context) => {
    const paired = isTelegramApproved(approvedStore, ctx.from?.id ?? 0)
    void ctx.reply(
      `✅ Bot running as @${bot?.botInfo?.username ?? 'unknown'}\n` +
      `Approved users: ${botStatus.approvedUserCount}\n` +
      `This chat: ${paired ? '✅ paired' : '❌ not paired — send /pair'}`
    )
  })

  // /pair — generate a 6-digit pairing code
  b.command('pair', async (ctx: Context) => {
    const chatId = ctx.from?.id
    const name = ctx.from?.first_name ?? ctx.from?.username ?? 'Telegram user'
    if (!chatId) {
      await ctx.reply('Could not identify your Telegram account.')
      return
    }
    // If already paired, let them know
    if (isTelegramApproved(approvedStore, chatId)) {
      await ctx.reply('You are already paired. Try /terminals.')
      return
    }
    prune()
    const req = createPairingRequest(chatId, name)
    pendingPairings.set(req.code, req)

    // Auto-expire after TTL
    setTimeout(() => {
      pendingPairings.delete(req.code)
    }, 130_000) // TTL + 10s buffer

    // Notify the desktop app
    broadcastPairingCode(req.code, req.name, req.chatId, req.expiresAt)

    await ctx.reply(
      `🔐 *Pairing code generated*\n\n` +
      `Code: \`${req.code}\`\n\n` +
      `This code expires in 2 minutes.\n` +
      `Open the nodeterm app to approve it, or enter the code there.\n\n` +
      `_The app must be running to complete pairing._`,
      { parse_mode: 'Markdown' }
    )
  })

  // /terminals — list active tmux sessions (gated)
  b.command(['terminals', 'sessions'], async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) { await ctx.reply(gate); return }
    try {
      const sessions = await getDeps().listSessions()
      if (sessions.length === 0) {
        await ctx.reply('No active terminal sessions.')
        return
      }
      const lines = sessions.map(
        (s, i) => `${i + 1}. \`${s.id}\` — ${s.title || 'unnamed'}${s.cwd ? ` (${s.cwd})` : ''}`
      )
      await ctx.reply(`*Terminals:*\n${lines.join('\n')}`, { parse_mode: 'Markdown' })
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`)
    }
  })

  // /attach N — capture session output (gated)
  b.command('attach', async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) { await ctx.reply(gate); return }
    const args = msgArgs(ctx)
    const idx = parseInt(args[1], 10)
    if (isNaN(idx)) {
      await ctx.reply('Usage: /attach N (use the number from /terminals)')
      return
    }
    try {
      const sessions = await getDeps().listSessions()
      const session = sessions[idx - 1]
      if (!session) {
        await ctx.reply(`No terminal at index ${idx}.`)
        return
      }
      const output = await getDeps().captureSession(session.id)
      const truncated = output.length > 3000 ? output.slice(0, 3000) + '\n…[truncated]' : output
      await ctx.reply(
        `*Session: ${session.title || session.id}*\n\`\`\`\n${truncated || '(empty)'}\n\`\`\``,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`)
    }
  })

  // /send N <text> — send input to a session (gated)
  b.command('send', async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) { await ctx.reply(gate); return }
    const args = msgArgs(ctx)
    if (args.length < 3) {
      await ctx.reply('Usage: /send N <text>')
      return
    }
    const idx = parseInt(args[1], 10)
    const text = args.slice(2).join(' ')
    if (isNaN(idx)) {
      await ctx.reply('Usage: /send N <text>')
      return
    }
    try {
      const sessions = await getDeps().listSessions()
      const session = sessions[idx - 1]
      if (!session) {
        await ctx.reply(`No terminal at index ${idx}.`)
        return
      }
      await getDeps().sendInput(session.id, text + '\n')
      await ctx.reply(`Sent to \`${session.title || session.id}\`: ${text}`, { parse_mode: 'Markdown' })
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`)
    }
  })

  // /invite — Team Access invite (gated + requires Pro via deps)
  b.command('invite', async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) { await ctx.reply(gate); return }
    const deps_ = getDeps()
    if (!deps_.inviteTeammate) {
      await ctx.reply('Team Access is not available on this device.')
      return
    }
    const args = msgArgs(ctx)
    const invitedEmail = args.length > 1 ? args.slice(1).join(' ').trim() : ''
    try {
      const { offer } = await deps_.inviteTeammate({ email: invitedEmail || undefined })
      const msg = [
        '✅ *Team Access invite generated*',
        '',
        `Share this single-use pairing code with ${invitedEmail || 'your teammate'}:`,
        `\`${offer}\``,
        '',
        'They paste it in nodeterm → New Remote Connection.',
        'This code expires after use.'
      ].join('\n')
      await ctx.reply(msg, { parse_mode: 'Markdown' })
    } catch (err) {
      const m = (err as Error).message
      if (m.includes('E_SEATS_FULL')) {
        await ctx.reply('All seats are in use. Add a seat in Settings → Team Access first.')
      } else {
        await ctx.reply(`Error generating invite: ${m}`)
      }
    }
  })
}

// ── Bot lifecycle ───────────────────────────────────────────────────────────────

async function startBot(token: string, filePath: string): Promise<void> {
  if (bot) await stopBot()

  // Load approved users from disk
  approvedFile = filePath
  approvedStore = await loadApprovedFromDisk(filePath)
  prune()

  bot = new Telegraf(token)
  bot.catch((err, ctx) => {
    console.warn('[telegram] bot error:', err)
  })

  registerCommands(bot)

  try {
    await bot.launch()
    // Wait briefly for bot info to populate
    await new Promise((r) => setTimeout(r, 500))
    botStatus = {
      running: true,
      botUsername: bot?.botInfo?.username ?? null,
      error: null,
      approvedUserCount: approvedUserCount(approvedStore)
    }
    broadcast()
  } catch (err) {
    botStatus = {
      running: false,
      botUsername: null,
      error: (err as Error).message,
      approvedUserCount: approvedUserCount(approvedStore)
    }
    broadcast()
    bot = null
  }
}

async function stopBot(): Promise<void> {
  if (!bot) return
  try {
    bot.stop()
  } catch { /* ignore */ }
  bot = null
  botStatus = {
    running: false,
    botUsername: null,
    error: null,
    approvedUserCount: approvedUserCount(approvedStore)
  }
  broadcast()
}

// ── Public API ──────────────────────────────────────────────────────────────────

export function initTelegramBot(
  tdeps: TelegramBotDeps,
  token?: string
): void {
  deps = tdeps
  const botToken = token || process.env.NODETERM_TELEGRAM_BOT_TOKEN || ''
  // Persisted at <userData>/telegram-approved.json
  const filePath = path.join(platform().userDataDir, 'telegram-approved.json')

  // ── Renderer → main: start / stop / status ──

  platform().handle(IPC.telegramBotStart, async (tkn?: string) => {
    await startBot(tkn || botToken, filePath)
    return botStatus
  })

  platform().handle(IPC.telegramBotStop, async () => {
    await stopBot()
    return botStatus
  })

  platform().handle(IPC.telegramBotStatus, () => {
    if (bot && bot.botInfo?.username && !botStatus.botUsername) {
      botStatus = { ...botStatus, botUsername: bot.botInfo.username }
    }
    return botStatus
  })

  // ── Renderer → main: pairing approval ──

  // Accept a pending pairing code
  platform().on(IPC.telegramBotPairingAccept, (code: string) => {
    prune()
    const req = claimPairingCode(pendingPairings, code)
    if (!req) return
    approvedStore = pinTelegramUser(approvedStore, req.chatId, req.name)
    void persistApproved()
    // Notify the Telegram user they're approved
    // (We can't send a proactive message without storing the bot instance — it's fine,
    //  the user can /status to check, or the desktop can relay through the bot later.)
  })

  // Reject a pending pairing code
  platform().on(IPC.telegramBotPairingReject, (code: string) => {
    pendingPairings.delete(code)
  })

  // ── Renderer → main: approved user management ──

  platform().handle(IPC.telegramBotGetApproved, async () => {
    // Reload from disk in case another process/bot instance modified the file
    await reloadApproved()
    return listApprovedUsers(approvedStore) as TelegramApprovedUserType[]
  })

  platform().handle(IPC.telegramBotRevokeUser, async (_chatId: number) => {
    const chatId = Number(_chatId)
    if (isNaN(chatId) || chatId <= 0) return
    approvedStore = unpinTelegramUser(approvedStore, chatId)
    await persistApproved()
  })

  // Auto-start if token is available from env
  if (botToken) void startBot(botToken, filePath)
}
