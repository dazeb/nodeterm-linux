import { describe, expect, it } from 'vitest'
import {
  emptyTelegramBotInfo,
  parseTelegramBotInfo,
  setTelegramBotInfo,
  clearTelegramBotInfo,
  getTelegramBotId,
  maskBotId
} from './telegram-bot-info'

describe('emptyTelegramBotInfo', () => {
  it('returns a store with null bot', () => {
    expect(emptyTelegramBotInfo().bot).toBeNull()
  })
})

describe('parseTelegramBotInfo', () => {
  it('parses a valid bot record', () => {
    const s = parseTelegramBotInfo({ bot: { id: 123456789, username: 'mybot', firstSeen: 100 } })
    expect(s.bot).toEqual({ id: 123456789, username: 'mybot', firstSeen: 100 })
  })

  it('defaults firstSeen to now when missing', () => {
    const before = Date.now()
    const s = parseTelegramBotInfo({ bot: { id: 5, username: 'b' } })
    const after = Date.now()
    expect(s.bot?.firstSeen).toBeGreaterThanOrEqual(before)
    expect(s.bot?.firstSeen).toBeLessThanOrEqual(after)
  })

  it('trims the username', () => {
    const s = parseTelegramBotInfo({ bot: { id: 5, username: '  spaced  ', firstSeen: 1 } })
    expect(s.bot?.username).toBe('spaced')
  })

  it('returns empty for non-object input', () => {
    expect(parseTelegramBotInfo(null).bot).toBeNull()
    expect(parseTelegramBotInfo('string').bot).toBeNull()
    expect(parseTelegramBotInfo(undefined).bot).toBeNull()
  })

  it('returns empty for missing bot field', () => {
    expect(parseTelegramBotInfo({}).bot).toBeNull()
    expect(parseTelegramBotInfo({ bot: 'nope' }).bot).toBeNull()
  })

  it('rejects invalid id (non-number, zero, negative)', () => {
    expect(parseTelegramBotInfo({ bot: { id: 0, username: 'x' } }).bot).toBeNull()
    expect(parseTelegramBotInfo({ bot: { id: -1, username: 'x' } }).bot).toBeNull()
    expect(parseTelegramBotInfo({ bot: { id: '5', username: 'x' } }).bot).toBeNull()
  })

  it('rejects empty username', () => {
    expect(parseTelegramBotInfo({ bot: { id: 5, username: '' } }).bot).toBeNull()
    expect(parseTelegramBotInfo({ bot: { id: 5, username: '   ' } }).bot).toBeNull()
  })

  it('accepts usernames with @ prefix? — no, stored without trimming the @', () => {
    // Telegram botInfo.username never comes with @, but we still accept it as-is after trim.
    const s = parseTelegramBotInfo({ bot: { id: 5, username: '@bot', firstSeen: 1 } })
    expect(s.bot?.username).toBe('@bot')
  })
})

describe('setTelegramBotInfo', () => {
  it('records a new bot, stamping firstSeen', () => {
    const before = Date.now()
    const s = setTelegramBotInfo(emptyTelegramBotInfo(), 42, 'thebot')
    const after = Date.now()
    expect(s.bot?.id).toBe(42)
    expect(s.bot?.username).toBe('thebot')
    expect(s.bot?.firstSeen).toBeGreaterThanOrEqual(before)
    expect(s.bot?.firstSeen).toBeLessThanOrEqual(after)
  })

  it('is idempotent for the same id + username (returns same ref)', () => {
    const s1 = setTelegramBotInfo(emptyTelegramBotInfo(), 42, 'thebot')
    const s2 = setTelegramBotInfo(s1, 42, 'thebot')
    expect(s2).toBe(s1)
  })

  it('updates the username for the same id but keeps firstSeen', () => {
    const s1 = setTelegramBotInfo(emptyTelegramBotInfo(), 42, 'old')
    const s2 = setTelegramBotInfo(s1, 42, 'new')
    expect(s2.bot?.username).toBe('new')
    expect(s2.bot?.firstSeen).toBe(s1.bot?.firstSeen)
  })

  it('replaces the bot (new firstSeen) when the id changes', () => {
    const s1 = setTelegramBotInfo(emptyTelegramBotInfo(), 42, 'old')
    const before = Date.now()
    const s2 = setTelegramBotInfo(s1, 99, 'brandnew')
    const after = Date.now()
    expect(s2.bot?.id).toBe(99)
    expect(s2.bot?.username).toBe('brandnew')
    expect(s2.bot?.firstSeen).toBeGreaterThanOrEqual(before)
    expect(s2.bot?.firstSeen).toBeLessThanOrEqual(after)
  })

  it('ignores invalid input (zero id, empty name)', () => {
    const s = setTelegramBotInfo(emptyTelegramBotInfo(), 1, 'first')
    expect(setTelegramBotInfo(s, 0, 'x')).toBe(s)
    expect(setTelegramBotInfo(s, -1, 'x')).toBe(s)
    expect(setTelegramBotInfo(s, 2, '')).toBe(s)
    expect(setTelegramBotInfo(s, 3, '   ')).toBe(s)
  })

  it('trims the username', () => {
    const s = setTelegramBotInfo(emptyTelegramBotInfo(), 1, '  spaced  ')
    expect(s.bot?.username).toBe('spaced')
  })
})

describe('clearTelegramBotInfo', () => {
  it('empties a populated store', () => {
    const s = setTelegramBotInfo(emptyTelegramBotInfo(), 1, 'b')
    expect(clearTelegramBotInfo(s).bot).toBeNull()
  })

  it('is a no-op on an empty store (same ref)', () => {
    const s = emptyTelegramBotInfo()
    expect(clearTelegramBotInfo(s)).toBe(s)
  })
})

describe('getTelegramBotId', () => {
  it('returns null for an empty store', () => {
    expect(getTelegramBotId(emptyTelegramBotInfo())).toBeNull()
  })

  it('returns the id for a populated store', () => {
    const s = setTelegramBotInfo(emptyTelegramBotInfo(), 7654321, 'b')
    expect(getTelegramBotId(s)).toBe(7654321)
  })
})

describe('maskBotId', () => {
  it('returns null for null / undefined / zero / negative', () => {
    expect(maskBotId(null)).toBeNull()
    expect(maskBotId(undefined)).toBeNull()
    expect(maskBotId(0)).toBeNull()
    expect(maskBotId(-1)).toBeNull()
  })

  it('masks the last 4 digits of a long id', () => {
    expect(maskBotId(123456789)).toBe('••••6789')
    expect(maskBotId(6123456789)).toBe('••••6789')
  })

  it('collapses ids of 4 or fewer digits to plain bullets so nothing real shows', () => {
    expect(maskBotId(1)).toBe('••••')
    expect(maskBotId(12)).toBe('••••')
    expect(maskBotId(123)).toBe('••••')
    expect(maskBotId(1234)).toBe('••••')
  })
})