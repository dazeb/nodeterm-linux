import { describe, expect, it } from 'vitest'
import {
  createPairingRequest,
  isPairingExpired,
  claimPairingCode,
  pruneExpiredPairings,
  PAIRING_TTL_MS
} from './telegram-pairing'

describe('createPairingRequest', () => {
  it('generates a 6-digit code', () => {
    const req = createPairingRequest(42, 'Alice')
    expect(req.code).toMatch(/^\d{6}$/)
    expect(req.chatId).toBe(42)
    expect(req.name).toBe('Alice')
    expect(req.createdAt).toBeGreaterThan(0)
    expect(req.expiresAt - req.createdAt).toBe(PAIRING_TTL_MS)
  })

  it('generates different codes for successive calls', () => {
    const a = createPairingRequest(1, 'A')
    const b = createPairingRequest(2, 'B')
    expect(a.code).not.toBe(b.code)
  })
})

describe('isPairingExpired', () => {
  it('returns false for a fresh request', () => {
    const req = createPairingRequest(42, 'Alice')
    expect(isPairingExpired(req)).toBe(false)
  })

  it('returns true for an expired request', () => {
    const req = createPairingRequest(42, 'Alice')
    // Force expiry by setting expiresAt in the past
    const expired = { ...req, expiresAt: Date.now() - 1 }
    expect(isPairingExpired(expired)).toBe(true)
  })
})

describe('claimPairingCode', () => {
  it('returns the request and removes it from the map', () => {
    const pending = new Map<string, ReturnType<typeof createPairingRequest>>()
    const req = createPairingRequest(42, 'Alice')
    pending.set(req.code, req)

    const result = claimPairingCode(pending, req.code)
    expect(result).not.toBeNull()
    expect(result!.code).toBe(req.code)
    expect(pending.has(req.code)).toBe(false) // removed
  })

  it('returns null for an unknown code', () => {
    const pending = new Map()
    expect(claimPairingCode(pending, '000000')).toBeNull()
  })

  it('returns null for an expired code and removes it', () => {
    const pending = new Map()
    const req = createPairingRequest(42, 'Alice')
    const expired = { ...req, expiresAt: Date.now() - 1 }
    pending.set(expired.code, expired)

    const result = claimPairingCode(pending, expired.code)
    expect(result).toBeNull()
    expect(pending.has(expired.code)).toBe(false) // cleaned up
  })
})

describe('pruneExpiredPairings', () => {
  it('removes expired codes, keeps fresh ones', () => {
    const pending = new Map()
    const fresh = createPairingRequest(1, 'A')
    const stale = { ...createPairingRequest(2, 'B'), expiresAt: Date.now() - 1 }
    pending.set(fresh.code, fresh)
    pending.set(stale.code, stale)

    pruneExpiredPairings(pending)
    expect(pending.has(fresh.code)).toBe(true)
    expect(pending.has(stale.code)).toBe(false)
  })

  it('leaves an empty map alone', () => {
    const pending = new Map()
    pruneExpiredPairings(pending)
    expect(pending.size).toBe(0)
  })
})
