// Telegram bot service for remote terminal access.
// Spawned by the Electron main process. Provides a Bot API interface to
// list, read, and interact with nodeterm tmux sessions over Telegram.
import { Telegraf } from 'telegraf'
import type { Context } from 'telegraf'
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import type { TelegramBotStatus } from '../shared/types'

export interface TelegramSessionInfo {
  id: string
  title?: string
  cwd?: string
}

export interface TelegramBotDeps {
  listSessions(): Promise<TelegramSessionInfo[]>
  captureSession(sessionId: string): Promise<string>
  sendInput(sessionId: string, text: string): Promise<void>
}

let bot: Telegraf | null = null
let deps: TelegramBotDeps | null = null
let botStatus: TelegramBotStatus = { running: false, botUsername: null, error: null }

function broadcast(): void {
  platform().broadcast(IPC.telegramBotStatus, botStatus)
}

function getDeps(): TelegramBotDeps {
  if (!deps) throw new Error('Telegram bot deps not initialized')
  return deps
}

async function startBot(token: string): Promise<void> {
  if (bot) await stopBot()

  bot = new Telegraf(token)
  bot.catch((err, ctx) => {
    console.warn('[telegram] bot error:', err)
  })

  // /start — welcome message
  bot.start((ctx: Context) => {
    const msg = [
      '👋 *nodeterm bot active*',
      '',
      'Type /terminals to see your active sessions.',
      'Type /attach N to view terminal output.',
      'Type /send N <text> to send input.',
      'Type /help for all commands.'
    ].join('\n')
    void ctx.reply(msg, { parse_mode: 'Markdown' })
  })

  // /help — command list
  bot.help((ctx: Context) => {
    const msg = [
      '*Commands:*',
      '/start — Welcome',
      '/help — This help',
      '/status — Bot connection status',
      '/terminals — List active sessions',
      '/attach N — View terminal N output',
      '/send N <text> — Send text to terminal N'
    ].join('\n')
    void ctx.reply(msg, { parse_mode: 'Markdown' })
  })

  bot.command('status', (ctx: Context) => {
    void ctx.reply(`✅ Bot running as @${bot?.botInfo?.username ?? 'unknown'}`)
  })

  // /terminals — list active tmux sessions
  bot.command(['terminals', 'sessions'], async (ctx: Context) => {
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

  // /attach N — capture session output
  bot.command('attach', async (ctx: Context) => {
    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : []
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

  // /send N <text> — send input to a session
  bot.command('send', async (ctx: Context) => {
    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : []
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

  try {
    await bot.launch()
    // Wait briefly for bot info to populate
    await new Promise((r) => setTimeout(r, 500))
    botStatus = { running: true, botUsername: bot?.botInfo?.username ?? null, error: null }
    broadcast()
  } catch (err) {
    botStatus = { running: false, botUsername: null, error: (err as Error).message }
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
  botStatus = { running: false, botUsername: null, error: null }
  broadcast()
}

export function initTelegramBot(
  tdeps: TelegramBotDeps,
  token?: string
): void {
  deps = tdeps
  const botToken = token || process.env.NODETERM_TELEGRAM_BOT_TOKEN || ''

  platform().handle(IPC.telegramBotStart, async (tkn?: string) => {
    await startBot(tkn || botToken)
    return botStatus
  })

  platform().handle(IPC.telegramBotStop, async () => {
    await stopBot()
    return botStatus
  })

  platform().handle(IPC.telegramBotStatus, () => {
    // Re-resolve the username on status check (may not be available at launch time)
    if (bot && bot.botInfo?.username && !botStatus.botUsername) {
      botStatus = { ...botStatus, botUsername: bot.botInfo.username }
    }
    return botStatus
  })

  if (botToken) void startBot(botToken)
}
