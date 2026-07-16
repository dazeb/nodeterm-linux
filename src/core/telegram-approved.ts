// Pure Telegram user approval store — mirrors approved-devices-core.ts but pins Telegram
// chat_ids instead of NaCl box public keys. One entry per approved Telegram user.
// Kept pure (no I/O, no electron) for unit-testability; the disk wrapper lands in
// telegram-bot.ts (which can access app.getPath).

export interface TelegramApprovedUser {
  /** Telegram chat_id (stable numeric user/group identifier). */
  chatId: number
  /** Telegram display name (first_name or username) at pairing time. */
  name: string
  /** Epoch ms when this user was approved. */
  pairedAt: number
}

export interface TelegramApprovedStore {
  users: TelegramApprovedUser[]
}

export function emptyTelegramApproved(): TelegramApprovedStore {
  return { users: [] }
}

/** Coerce arbitrary parsed JSON into a well-formed TelegramApprovedStore. Drops invalid
 *  entries (missing chatId, non-numeric, empty name). Deduplicates by chatId (first wins). */
export function parseTelegramApproved(raw: unknown): TelegramApprovedStore {
  if (!raw || typeof raw !== 'object') return emptyTelegramApproved()
  const list = (raw as { users?: unknown }).users
  if (!Array.isArray(list)) return emptyTelegramApproved()
  const seen = new Set<number>()
  const users: TelegramApprovedUser[] = []
  for (const u of list) {
    if (u && typeof u === 'object') {
      const chatId = (u as { chatId?: unknown }).chatId
      const name = String((u as { name?: unknown }).name ?? '').trim()
      if (typeof chatId === 'number' && chatId > 0 && name.length > 0 && !seen.has(chatId)) {
        seen.add(chatId)
        users.push({
          chatId,
          name,
          pairedAt: typeof (u as { pairedAt?: unknown }).pairedAt === 'number'
            ? (u as { pairedAt: number }).pairedAt
            : Date.now()
        })
      }
    }
  }
  return { users }
}

/** True when this chat_id has been approved. */
export function isTelegramApproved(store: TelegramApprovedStore, chatId: number): boolean {
  return chatId > 0 && store.users.some((u) => u.chatId === chatId)
}

/** Pin a Telegram user. Idempotent — returns the same store when already present. */
export function pinTelegramUser(
  store: TelegramApprovedStore,
  chatId: number,
  name: string
): TelegramApprovedStore {
  if (chatId <= 0 || !name.trim()) return store
  if (store.users.some((u) => u.chatId === chatId)) return store
  return {
    users: [...store.users, { chatId, name: name.trim(), pairedAt: Date.now() }]
  }
}

/** Unpin a Telegram user (revoke). Idempotent. */
export function unpinTelegramUser(
  store: TelegramApprovedStore,
  chatId: number
): TelegramApprovedStore {
  if (chatId <= 0) return store
  if (!store.users.some((u) => u.chatId === chatId)) return store
  return { users: store.users.filter((u) => u.chatId !== chatId) }
}

/** Count approved users. */
export function approvedUserCount(store: TelegramApprovedStore): number {
  return store.users.length
}

/** List all approved users (sorted by pairedAt descending). */
export function listApprovedUsers(store: TelegramApprovedStore): TelegramApprovedUser[] {
  return [...store.users].sort((a, b) => b.pairedAt - a.pairedAt)
}
