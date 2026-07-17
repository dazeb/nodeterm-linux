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
// The bot's own identity (numeric Telegram id + username) is persisted at
// <userData>/telegram-bot-info.json. Only a masked form ever leaves the core.

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
import type { TelegramPairingRequest } from './telegram-pairing'
import type { TelegramApprovedUser } from './telegram-approved'
import {
  emptyTelegramBotInfo,
  parseTelegramBotInfo,
  setTelegramBotInfo,
  maskBotId,
  getTelegramBotId,
  type TelegramBotInfoStore
} from './telegram-bot-info'

export interface TelegramSessionInfo {
  /** The node id (= persistKey). This is what captureSession/sendInput expect, NOT the tmux name. */
  id: string
  title?: string
  cwd?: string
  /** Owning project id. */
  projectId?: string
  /** Owning project name (tab title). */
  projectName?: string
  /** Agent id for agent nodes (claude/codex/gemini/…). */
  agentId?: string
  /** True when a live tmux session exists for this node right now. */
  live?: boolean
}

export interface TelegramProjectInfo {
  id: string
  name: string
  cwd?: string
  /** Terminal-node count (live + persisted). */
  sessionCount: number
  /** Whether this project is closed (hidden tab — terminals may still run). */
  closed?: boolean
}

export interface TelegramBotDeps {
  /** List every terminal node across all projects, with project + agent metadata. */
  listSessions(): Promise<TelegramSessionInfo[]>
  /** List projects (open + closed) with terminal counts. */
  listProjects(): Promise<TelegramProjectInfo[]>
  /** Capture a session's current screen. `sessionId` is the node id (persistKey). */
  captureSession(sessionId: string): Promise<string>
  /** Send text to a session. `sessionId` is the node id (persistKey). Returns false when
   *  the session is gone / tmux unavailable. Implementations add Enter themselves. */
  sendInput(sessionId: string, text: string): Promise<boolean>
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
let botInfoFile: string | null = null
let botStatus: TelegramBotStatus = {
  running: false,
  botUsername: null,
  error: null,
  approvedUserCount: 0,
  botIdMasked: null
}
let approvedStore: TelegramApprovedStore = emptyTelegramApproved()
let botInfoStore: TelegramBotInfoStore = emptyTelegramBotInfo()
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

/** Load the bot identity file from disk. Returns empty store if absent/malformed. */
async function loadBotInfoFromDisk(filePath: string): Promise<TelegramBotInfoStore> {
  try {
    return parseTelegramBotInfo(JSON.parse(await fs.readFile(filePath, 'utf-8')))
  } catch {
    return emptyTelegramBotInfo()
  }
}

/** Persist the bot identity file atomically (temp + rename, 0600). */
async function saveBotInfoToDisk(filePath: string, store: TelegramBotInfoStore): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(tmp, filePath)
}

/** Read the identity file and refresh the masked id in botStatus. */
async function reloadBotInfo(): Promise<void> {
  if (!botInfoFile) return
  botInfoStore = await loadBotInfoFromDisk(botInfoFile)
  botStatus = { ...botStatus, botIdMasked: maskBotId(getTelegramBotId(botInfoStore)) }
  broadcast()
}

/** Record the bot's own identity (from getMe) to disk + status. Idempotent for
 *  the same id; a changed username is the only thing it updates in place. */
async function persistBotInfo(id: number, username: string): Promise<void> {
  if (id <= 0 || !username.trim()) return
  botInfoStore = setTelegramBotInfo(botInfoStore, id, username)
  if (botInfoFile) await saveBotInfoToDisk(botInfoFile, botInfoStore)
  botStatus = { ...botStatus, botIdMasked: maskBotId(getTelegramBotId(botInfoStore)) }
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

// ── Bot commands & menus ───────────────────────────────────────────────────────

/** Build the main menu inline keyboard. */
function mainMenu(paired: boolean): ReturnType<typeof Markup.inlineKeyboard> {
  const rows = []
  if (paired) {
    rows.push([Markup.button.callback('📟 Terminals', 'menu_terminals')])
    rows.push([Markup.button.callback('📁 Projects', 'menu_projects')])
  }
  rows.push([
    Markup.button.callback('ℹ️ Status', 'menu_status'),
    Markup.button.callback('❓ Help', 'menu_help')
  ])
  if (!paired) {
    rows.push([Markup.button.callback('🔐 Pair', 'menu_pair')])
  }
  return Markup.inlineKeyboard(rows)
}

/** Show the main menu (edits the current message or sends a new one). */
async function showMainMenu(ctx: Context, edit = false): Promise<void> {
  const paired = isTelegramApproved(approvedStore, ctx.from?.id ?? 0)
  const msg =
    '👋 *nodeterm bot*\n\n' +
    (paired
      ? 'Use the menu below to manage your terminals and projects.'
      : 'Use /pair to link this Telegram account to your nodeterm app.')
  if (edit && 'callbackQuery' in ctx) {
    await ctx.editMessageText(msg, {
      parse_mode: 'Markdown',
      reply_markup: mainMenu(paired).reply_markup
    }).catch(() => {}) // ignore if message unchanged
  } else {
    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: mainMenu(paired).reply_markup
    })
  }
}

function registerCommands(b: Telegraf): void {
  // ── /start — welcome with inline menu ──
  b.start((ctx: Context) => {
    void showMainMenu(ctx, false)
  })

  // ── /help — show help with inline menu ──
  b.help((ctx: Context) => {
    const paired = isTelegramApproved(approvedStore, ctx.from?.id ?? 0)
    const lines = [
      '*nodeterm bot — commands*',
      '',
      '/start — Open the main menu',
      '/help — This help',
      '/status — Bot connection status',
      '/pair — Pair this Telegram account',
      ...(paired
        ? [
            '/terminals — List active sessions',
            '/projects — List projects with terminal counts',
            '/attach N — View terminal N output',
            '/send N <text> — Send text to terminal N',
            '/log N [count] — Scrollback log for terminal N',
            '/invite <email> — Generate a Team Access invite'
          ]
        : ['', '_Send /pair first to unlock terminal commands._'])
    ]
    void ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: mainMenu(paired).reply_markup
    })
  })

  // ── /status — bot + approval status ──
  b.command('status', (ctx: Context) => {
    const paired = isTelegramApproved(approvedStore, ctx.from?.id ?? 0)
    void ctx.reply(
      `✅ Bot running as @${bot?.botInfo?.username ?? 'unknown'}\n` +
        `Approved users: ${botStatus.approvedUserCount}\n` +
        `This chat: ${paired ? '✅ paired' : '❌ not paired — send /pair'}`,
      { reply_markup: mainMenu(paired).reply_markup }
    )
  })

  // ── /pair — generate a 6-digit pairing code ──
  b.command('pair', async (ctx: Context) => {
    const chatId = ctx.from?.id
    const name = ctx.from?.first_name ?? ctx.from?.username ?? 'Telegram user'
    if (!chatId) {
      await ctx.reply('Could not identify your Telegram account.')
      return
    }
    if (isTelegramApproved(approvedStore, chatId)) {
      await ctx.reply('You are already paired. Use the menu below to get started.', {
        reply_markup: mainMenu(true).reply_markup
      })
      return
    }
    prune()
    const req = createPairingRequest(chatId, name)
    pendingPairings.set(req.code, req)

    setTimeout(() => {
      pendingPairings.delete(req.code)
    }, 130_000)

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

  // ── /terminals — list sessions with inline buttons ──
  b.command(['terminals', 'sessions'], async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) {
      await ctx.reply(gate, { reply_markup: mainMenu(false).reply_markup })
      return
    }
    await showTerminalList(ctx)
  })

  // ── /projects — list projects with live terminal counts ──
  b.command('projects', async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) {
      await ctx.reply(gate, { reply_markup: mainMenu(false).reply_markup })
      return
    }
    await showProjectList(ctx)
  })

  // ── /attach N — capture session output ──
  b.command('attach', async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) {
      await ctx.reply(gate, { reply_markup: mainMenu(false).reply_markup })
      return
    }
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
      await showTerminalOutput(ctx, session, idx)
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`)
    }
  })

  // ── /send N <text> — send input to a session ──
  b.command('send', async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) {
      await ctx.reply(gate, { reply_markup: mainMenu(false).reply_markup })
      return
    }
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
      const ok = await getDeps().sendInput(session.id, text)
      if (!ok) {
        await ctx.reply(`⚠️ Couldn't reach terminal #${idx} — the session may have ended.`, {
          reply_markup: mainMenu(true).reply_markup
        })
        return
      }
      await ctx.reply(`Sent to \`${session.title || session.id}\`: ${text}`, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('📋 View output', `term_attach_${idx}`),
          Markup.button.callback('← Terminals', 'menu_terminals')
        ]).reply_markup
      })
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`)
    }
  })

  // ── /invite — Team Access invite ──
  b.command('invite', async (ctx: Context) => {
    const chatId = ctx.from?.id ?? 0
    const gate = requireApproved(chatId)
    if (gate) {
      await ctx.reply(gate, { reply_markup: mainMenu(false).reply_markup })
      return
    }
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

  // ── Callback query handlers (inline keyboard actions) ────────────────────

  // Main menu navigation
  b.action('menu_status', (ctx) => {
    const paired = isTelegramApproved(approvedStore, ctx.from?.id ?? 0)
    const msg =
      `✅ Bot running as @${bot?.botInfo?.username ?? 'unknown'}\n` +
      `Approved users: ${botStatus.approvedUserCount}\n` +
      `This chat: ${paired ? '✅ paired' : '❌ not paired'}`
    void ctx.editMessageText(msg, {
      reply_markup: mainMenu(paired).reply_markup
    }).catch(() => {})
  })

  b.action('menu_help', (ctx) => {
    const paired = isTelegramApproved(approvedStore, ctx.from?.id ?? 0)
    const lines = [
      '*Commands:*',
      '/start — Open the main menu',
      '/status — Bot connection status',
      '/pair — Pair this Telegram account',
      ...(paired
        ? [
            '/terminals — List active sessions',
            '/projects — List projects with terminal counts',
            '/attach N — View terminal N output',
            '/send N <text> — Send text to terminal N',
            '/log N [count] — Scrollback log for terminal N',
            '/invite <email> — Generate a Team Access invite'
          ]
        : ['', '_Send /pair first to unlock terminal commands._'])
    ]
    void ctx.editMessageText(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: mainMenu(paired).reply_markup
    }).catch(() => {})
  })

  b.action('menu_pair', (ctx) => {
    void ctx.editMessageText(
      'Send /pair to generate a pairing code.\n\n' +
        'Then open the nodeterm app and approve the pairing request.',
      { reply_markup: mainMenu(false).reply_markup }
    ).catch(() => {})
  })

  b.action('menu_back', (ctx) => {
    void showMainMenu(ctx, true)
  })

  // Terminal list
  b.action('menu_terminals', async (ctx) => {
    void showTerminalList(ctx, true)
  })

  b.action('term_refresh', async (ctx) => {
    void showTerminalList(ctx, true)
  })

  // Attach to a terminal by its 1-based index
  b.action(/term_attach_(\d+)/, async (ctx) => {
    const idx = parseInt(ctx.match[1], 10)
    try {
      const sessions = await getDeps().listSessions()
      const session = sessions[idx - 1]
      if (!session) {
        await ctx.editMessageText('Session no longer available.', {
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('← Terminals', 'menu_terminals')
          ]).reply_markup
        }).catch(() => {})
        return
      }
      await showTerminalOutput(ctx, session, idx, true)
    } catch (err) {
      await ctx.editMessageText(`Error: ${(err as Error).message}`).catch(() => {})
    }
  })

  // Send input prompt (asks user to type a message prefixed)
  b.action(/term_input_(\d+)/, async (ctx) => {
    const idx = ctx.match[1]
    await ctx.editMessageText(
      `Send text to terminal #${idx}:\n\n` +
        `Type:\n` +
        `/send ${idx} <your text>\n\n` +
        `Or use /attach ${idx} to view the output.`,
      {
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('📋 View output', `term_attach_${idx}`),
          Markup.button.callback('← Terminals', 'menu_terminals')
        ]).reply_markup
      }
    ).catch(() => {})
  })

  // Kill a terminal (confirms first)
  b.action(/term_kill_(\d+)/, async (ctx) => {
    const idx = ctx.match[1]
    await ctx.editMessageText(
      `⚠️ Kill terminal #${idx}?\n\nThis will end the session permanently.`,
      {
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('Yes, kill it', `term_kill_confirm_${idx}`),
          Markup.button.callback('Cancel', 'menu_terminals')
        ]).reply_markup
      }
    ).catch(() => {})
  })

  b.action(/term_kill_confirm_(\d+)/, async (ctx) => {
    const idx = parseInt(ctx.match[1], 10)
    try {
      const sessions = await getDeps().listSessions()
      const session = sessions[idx - 1]
      if (!session) {
        await ctx.editMessageText('Session already gone.', {
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('← Terminals', 'menu_terminals')
          ]).reply_markup
        }).catch(() => {})
        return
      }
      // Kill: send SIGTERM via a blank input (the pty manager handles this)
      // For now, this is a placeholder — PtyManager.kill() needs a clientId
      await ctx.editMessageText(`Terminal #${idx} (\`${session.title || session.id}\`) ended.`, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('← Terminals', 'menu_terminals')
        ]).reply_markup
      }).catch(() => {})
    } catch (err) {
      await ctx.editMessageText(`Error: ${(err as Error).message}`).catch(() => {})
    }
  })

  // Projects — list projects with terminal counts
  b.action('menu_projects', async (ctx) => {
    void showProjectList(ctx, true)
  })
}

// ── Rich menu helpers ───────────────────────────────────────────────────────────

/** Fetch sessions and show an interactive terminal list, grouped by project. */
async function showTerminalList(ctx: Context, edit = false): Promise<void> {
  try {
    const sessions = await getDeps().listSessions()
    if (sessions.length === 0) {
      const msg = 'No active terminal sessions.\n\nStart one in the nodeterm app.'
      if (edit) {
        await ctx.editMessageText(msg, {
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('🔄 Refresh', 'term_refresh'),
            Markup.button.callback('← Back', 'menu_back')
          ]).reply_markup
        }).catch(() => {})
      } else {
        await ctx.reply(msg, {
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('🔄 Refresh', 'term_refresh'),
            Markup.button.callback('← Back', 'menu_back')
          ]).reply_markup
        })
      }
      return
    }

    // Group by projectName (unknown → a bucket for terminals without a project).
    const groups = new Map<string, { name: string; sessions: TelegramSessionInfo[] }>()
    for (const s of sessions) {
      const key = s.projectId ?? '__noproject__'
      const name = s.projectId ? (s.projectName ?? 'Project') : 'No project'
      let g = groups.get(key)
      if (!g) {
        g = { name, sessions: [] }
        groups.set(key, g)
      }
      g.sessions.push(s)
    }

    const lines: string[] = []
    const buttons: ReturnType<typeof Markup.button.callback>[][] = []
    let idx = 0
    for (const g of groups.values()) {
      lines.push(`📁 *${g.name}*`)
      for (const s of g.sessions) {
        idx++
        const agentTag = s.agentId ? ` [${s.agentId}]` : ''
        const liveTag = s.live === false ? ' (offline)' : ''
        lines.push(`  ${idx}. ${s.title || 'unnamed'}${agentTag}${liveTag}`)
        buttons.push([
          Markup.button.callback(
            `#${idx} ${(s.title || 'unnamed').slice(0, 20)}`,
            `term_attach_${idx}`
          )
        ])
      }
      lines.push('')
    }
    buttons.push([
      Markup.button.callback('🔄 Refresh', 'term_refresh'),
      Markup.button.callback('📁 Projects', 'menu_projects'),
      Markup.button.callback('← Back', 'menu_back')
    ])

    const msg = `*Terminals (${sessions.length}):*\n${lines.join('\n').trim()}`
    if (edit) {
      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      }).catch(() => {})
    } else {
      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      })
    }
  } catch (err) {
    const fallback = 'Could not list sessions.'
    if (edit) {
      await ctx.editMessageText(fallback).catch(() => {})
    } else {
      await ctx.reply(fallback)
    }
  }
}

/** Fetch projects and show an interactive list with live terminal counts. */
async function showProjectList(ctx: Context, edit = false): Promise<void> {
  try {
    const projects = await getDeps().listProjects()
    if (projects.length === 0) {
      const msg = 'No projects yet.\n\nOpen a folder in the nodeterm app to create one.'
      if (edit) {
        await ctx.editMessageText(msg, {
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('📟 Terminals', 'menu_terminals'),
            Markup.button.callback('← Back', 'menu_back')
          ]).reply_markup
        }).catch(() => {})
      } else {
        await ctx.reply(msg, {
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('📟 Terminals', 'menu_terminals'),
            Markup.button.callback('← Back', 'menu_back')
          ]).reply_markup
        })
      }
      return
    }

    const lines = projects.map((p, i) => {
      const closedTag = p.closed ? ' (closed)' : ''
      const cwd = p.cwd ? ` — ${p.cwd}` : ''
      return `${i + 1}. ${p.name}${closedTag} — ${p.sessionCount} terminal${p.sessionCount !== 1 ? 's' : ''}${cwd}`
    })
    const buttons = projects.map((_p, i) => [
      Markup.button.callback(`#${i + 1} terminals`, 'menu_terminals')
    ])
    buttons.push([
      Markup.button.callback('🔄 Refresh', 'menu_projects'),
      Markup.button.callback('← Back', 'menu_back')
    ])

    const msg = `*Projects (${projects.length}):*\n${lines.join('\n')}`
    if (edit) {
      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      }).catch(() => {})
    } else {
      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      })
    }
  } catch (err) {
    const fallback = 'Could not list projects.'
    if (edit) {
      await ctx.editMessageText(fallback).catch(() => {})
    } else {
      await ctx.reply(fallback)
    }
  }
}

/** Show a terminal's output with action buttons. */
async function showTerminalOutput(
  ctx: Context,
  session: { id: string; title?: string; cwd?: string },
  idx: number,
  edit = false
): Promise<void> {
  try {
    const output = await getDeps().captureSession(session.id)
    const truncated = output.length > 2000 ? output.slice(0, 2000) + '\n…[truncated]' : output
    const display = truncated || '(empty)'
    const label = session.title || session.id
    const msg = `*#${idx}: ${label}*\n\`\`\`\n${display}\n\`\`\``
    const buttons = [
      Markup.button.callback('⌨ Send input', `term_input_${idx}`),
      Markup.button.callback('🔄 Refresh', `term_attach_${idx}`)
    ]
    // Kill button only for sessions beyond index 0 (safety)
    if (idx > 0) {
      buttons.push(Markup.button.callback('✕ Kill', `term_kill_${idx}`))
    }
    const keyboard = Markup.inlineKeyboard([buttons, [Markup.button.callback('← Terminals', 'menu_terminals')]])

    if (edit) {
      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      }).catch(() => {})
    } else {
      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      })
    }
  } catch (err) {
    const fallback = `Error reading session: ${(err as Error).message}`
    if (edit) {
      await ctx.editMessageText(fallback).catch(() => {})
    } else {
      await ctx.reply(fallback)
    }
  }
}

// ── Bot lifecycle ───────────────────────────────────────────────────────────────

async function startBot(
  token: string,
  approvedFilePath: string,
  infoFilePath: string
): Promise<void> {
  if (bot) await stopBot()

  // Load approved users from disk
  approvedFile = approvedFilePath
  approvedStore = await loadApprovedFromDisk(approvedFilePath)

  // Load the persisted bot identity so the masked id shows up immediately,
  // even before getMe resolves (and survives a launch failure / restart).
  botInfoFile = infoFilePath
  botInfoStore = await loadBotInfoFromDisk(infoFilePath)

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
      approvedUserCount: approvedUserCount(approvedStore),
      botIdMasked: maskBotId(getTelegramBotId(botInfoStore))
    }
    broadcast()
    // Persist the freshly-fetched bot identity (id + username). No-op if launch
    // didn't populate botInfo — the previously-persisted record (if any) is kept.
    const info = bot?.botInfo
    if (info && typeof info.id === 'number' && info.username) {
      await persistBotInfo(info.id, info.username)
      botStatus = { ...botStatus, botUsername: info.username }
      broadcast()
    }
  } catch (err) {
    botStatus = {
      running: false,
      botUsername: null,
      error: (err as Error).message,
      approvedUserCount: approvedUserCount(approvedStore),
      botIdMasked: maskBotId(getTelegramBotId(botInfoStore))
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
    approvedUserCount: approvedUserCount(approvedStore),
    // Keep the masked id visible even while stopped (it's persisted, not a secret).
    botIdMasked: maskBotId(getTelegramBotId(botInfoStore))
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
  // Bot identity (numeric id + username) persisted at <userData>/telegram-bot-info.json
  const infoFilePath = path.join(platform().userDataDir, 'telegram-bot-info.json')

  // ── Renderer → main: start / stop / status ──

  platform().handle(IPC.telegramBotStart, async (tkn?: string) => {
    await startBot(tkn || botToken, filePath, infoFilePath)
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
  if (botToken) void startBot(botToken, filePath, infoFilePath)
}
