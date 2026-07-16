import { describe, expect, it } from 'vitest'
import {
  emptyTelegramApproved,
  parseTelegramApproved,
  isTelegramApproved,
  pinTelegramUser,
  unpinTelegramUser,
  approvedUserCount,
  listApprovedUsers
} from './telegram-approved'

describe('emptyTelegramApproved', () => {
  it('returns an empty store', () => {
    const s = emptyTelegramApproved()
    expect(s.users).toEqual([])
  })
})

describe('parseTelegramApproved', () => {
  it('parses a valid list and deduplicates by chatId', () => {
    const raw = {
      users: [
        { chatId: 1, name: 'Alice', pairedAt: 100 },
        { chatId: 2, name: 'Bob', pairedAt: 200 },
        { chatId: 1, name: 'Alice again', pairedAt: 300 } // duplicate
      ]
    }
    const s = parseTelegramApproved(raw)
    expect(s.users).toHaveLength(2)
    expect(s.users[0].name).toBe('Alice') // first wins
    expect(s.users[0].pairedAt).toBe(100)
    expect(s.users[1].name).toBe('Bob')
  })

  it('filters invalid entries', () => {
    const raw = {
      users: [
        { chatId: 0, name: 'Zero', pairedAt: 1 }, // invalid chatId
        { chatId: -1, name: 'Negative', pairedAt: 2 }, // invalid
        { chatId: 3, name: '', pairedAt: 3 }, // empty name
        { chatId: 4, name: 'Valid', pairedAt: 4 }, // valid
        { name: 'No id', pairedAt: 5 }, // missing chatId
        null,
        'string'
      ]
    }
    const s = parseTelegramApproved(raw)
    expect(s.users).toHaveLength(1)
    expect(s.users[0].name).toBe('Valid')
  })

  it('returns empty for non-object input', () => {
    expect(parseTelegramApproved(null).users).toEqual([])
    expect(parseTelegramApproved('string').users).toEqual([])
    expect(parseTelegramApproved(undefined).users).toEqual([])
  })

  it('returns empty for missing users array', () => {
    expect(parseTelegramApproved({}).users).toEqual([])
    expect(parseTelegramApproved({ users: 'not-array' }).users).toEqual([])
  })
})

describe('isTelegramApproved', () => {
  it('returns true for a pinned chat_id', () => {
    const s = pinTelegramUser(emptyTelegramApproved(), 42, 'Alice')
    expect(isTelegramApproved(s, 42)).toBe(true)
  })

  it('returns false for an unpinned chat_id', () => {
    const s = pinTelegramUser(emptyTelegramApproved(), 42, 'Alice')
    expect(isTelegramApproved(s, 99)).toBe(false)
  })

  it('returns false for chatId <= 0', () => {
    expect(isTelegramApproved(emptyTelegramApproved(), 0)).toBe(false)
    expect(isTelegramApproved(emptyTelegramApproved(), -1)).toBe(false)
  })
})

describe('pinTelegramUser', () => {
  it('adds a user to the store', () => {
    const s = pinTelegramUser(emptyTelegramApproved(), 42, 'Alice')
    expect(s.users).toHaveLength(1)
    expect(s.users[0].chatId).toBe(42)
    expect(s.users[0].name).toBe('Alice')
    expect(s.users[0].pairedAt).toBeGreaterThan(0)
  })

  it('is idempotent — returns same store for duplicate chatId', () => {
    const s1 = pinTelegramUser(emptyTelegramApproved(), 42, 'Alice')
    const s2 = pinTelegramUser(s1, 42, 'Alice again')
    expect(s2).toBe(s1) // same reference
    expect(s2.users).toHaveLength(1)
  })

  it('ignores invalid chatId', () => {
    const s = emptyTelegramApproved()
    expect(pinTelegramUser(s, 0, 'Zero')).toBe(s)
    expect(pinTelegramUser(s, -1, 'Neg')).toBe(s)
  })

  it('ignores empty name', () => {
    const s = emptyTelegramApproved()
    expect(pinTelegramUser(s, 1, '')).toBe(s)
    expect(pinTelegramUser(s, 2, '  ')).toBe(s)
  })
})

describe('unpinTelegramUser', () => {
  it('removes a user by chatId', () => {
    let s = emptyTelegramApproved()
    s = pinTelegramUser(s, 42, 'Alice')
    s = pinTelegramUser(s, 99, 'Bob')
    s = unpinTelegramUser(s, 42)
    expect(s.users).toHaveLength(1)
    expect(s.users[0].chatId).toBe(99)
  })

  it('is idempotent — returns same store for unknown chatId', () => {
    const s = pinTelegramUser(emptyTelegramApproved(), 42, 'Alice')
    expect(unpinTelegramUser(s, 99)).toBe(s)
  })

  it('ignores invalid chatId', () => {
    const s = pinTelegramUser(emptyTelegramApproved(), 42, 'Alice')
    expect(unpinTelegramUser(s, 0)).toBe(s)
    expect(unpinTelegramUser(s, -1)).toBe(s)
  })
})

describe('approvedUserCount', () => {
  it('returns the count of users', () => {
    let s = emptyTelegramApproved()
    expect(approvedUserCount(s)).toBe(0)
    s = pinTelegramUser(s, 1, 'A')
    s = pinTelegramUser(s, 2, 'B')
    expect(approvedUserCount(s)).toBe(2)
  })
})

describe('listApprovedUsers', () => {
  it('returns users sorted by pairedAt descending', () => {
    let s = emptyTelegramApproved()
    s = { users: [{ chatId: 1, name: 'Old', pairedAt: 100 }, { chatId: 2, name: 'New', pairedAt: 200 }] }
    const list = listApprovedUsers(s)
    expect(list[0].name).toBe('New')
    expect(list[1].name).toBe('Old')
  })
})
