// Pure Telegram bot identity store. The bot's own numeric Telegram id (from
// `bot.botInfo.id` / getMe) is persisted to disk so it survives app restarts.
// Kept pure (no I/O, no electron) for unit-testability; the disk wrapper lives
// in telegram-bot.ts. Raw id stays on disk / core side only — only a masked
// form is surfaced to the renderer, so a screenshot / clipboard / log never
// leaks the full bot id.

export interface TelegramBotInfo {
  /** The bot's own numeric Telegram user id (from getMe). */
  id: number
  /** The bot's @username (without the @). */
  username: string
  /** Epoch ms when this bot was first seen by the app. */
  firstSeen: number
}

export interface TelegramBotInfoStore {
  /** Single record — there is only ever one bot per app install. */
  bot: TelegramBotInfo | null
}

export function emptyTelegramBotInfo(): TelegramBotInfoStore {
  return { bot: null }
}

/** Coerce arbitrary parsed JSON into a well-formed store. Returns empty for
 *  invalid input (missing/non-numeric id, empty username). */
export function parseTelegramBotInfo(raw: unknown): TelegramBotInfoStore {
  if (!raw || typeof raw !== 'object') return emptyTelegramBotInfo()
  const bot = (raw as { bot?: unknown }).bot
  if (!bot || typeof bot !== 'object') return emptyTelegramBotInfo()
  const id = (bot as { id?: unknown }).id
  const username = String((bot as { username?: unknown }).username ?? '').trim()
  const firstSeen = (bot as { firstSeen?: unknown }).firstSeen
  if (typeof id !== 'number' || id <= 0 || username.length === 0) {
    return emptyTelegramBotInfo()
  }
  return {
    bot: {
      id,
      username,
      firstSeen: typeof firstSeen === 'number' ? firstSeen : Date.now()
    }
  }
}

/** Record a bot identity. Updated username wins; an unchanged id keeps firstSeen. */
export function setTelegramBotInfo(
  store: TelegramBotInfoStore,
  id: number,
  username: string
): TelegramBotInfoStore {
  if (id <= 0 || !username.trim()) return store
  const trimmed = username.trim()
  if (store.bot && store.bot.id === id) {
    if (store.bot.username === trimmed) return store
    return { bot: { ...store.bot, username: trimmed } }
  }
  return { bot: { id, username: trimmed, firstSeen: Date.now() } }
}

/** Clear the recorded bot identity (e.g. when the token is removed). */
export function clearTelegramBotInfo(store: TelegramBotInfoStore): TelegramBotInfoStore {
  if (!store.bot) return store
  return emptyTelegramBotInfo()
}

/** The current bot id, or null if none recorded. */
export function getTelegramBotId(store: TelegramBotInfoStore): number | null {
  return store.bot?.id ?? null
}

/** Mask a Telegram bot id for display: shows only the last 4 digits. Short ids
 *  ( <=4 digits) collapse to plain bullets so nothing real is revealed. */
export function maskBotId(id: number | null | undefined): string | null {
  if (id === null || id === undefined || (typeof id === 'number' && id <= 0)) return null
  const s = String(id)
  if (s.length <= 4) return '••••'
  return `••••${s.slice(-4)}`
}