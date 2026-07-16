// Pure pairing-code generator for the Telegram auth flow.
// One-time 6-digit codes with bounded TTL. The live pending map is held in telegram-bot.ts;
// this module exports the pure helpers to generate, validate, and claim codes.

import { randomBytes } from 'node:crypto'

export interface TelegramPairingRequest {
  /** 6-digit numeric code (zero-padded string). */
  code: string
  /** Telegram chat_id that requested this code. */
  chatId: number
  /** Telegram display name at pairing time. */
  name: string
  /** Epoch ms when the code was generated. */
  createdAt: number
  /** Epoch ms when the code expires. */
  expiresAt: number
}

export const PAIRING_TTL_MS = 120_000 // 2 minutes, matches relay token TTL

/** Generate a cryptographically-hardened 6-digit pairing code. */
function generateSixDigitCode(): string {
  const buf = randomBytes(4)
  const num = (buf[0]! * 256 + buf[1]!) % 1_000_000
  return String(num).padStart(6, '0')
}

/** Create a fresh pairing request. `code` is guaranteed to be 6 digits, zero-padded. */
export function createPairingRequest(chatId: number, name: string): TelegramPairingRequest {
  const now = Date.now()
  return {
    code: generateSixDigitCode(),
    chatId,
    name,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS
  }
}

/** True if the request has expired (past its TTL). */
export function isPairingExpired(request: TelegramPairingRequest): boolean {
  return Date.now() > request.expiresAt
}

/** Try to claim a pairing code from the pending map. Returns the request and removes it
 *  from the map, or null if the code is unknown/expired. The caller should persist the
 *  approval (pinTelegramUser) before the next tick. */
export function claimPairingCode(
  pending: Map<string, TelegramPairingRequest>,
  code: string
): TelegramPairingRequest | null {
  const request = pending.get(code)
  if (!request) return null
  pending.delete(code)
  if (isPairingExpired(request)) return null
  return request
}

/** Garbage-collect expired codes from the pending map. Returns the cleaned map (mutates
 *  in place, returns the same reference for chaining convenience). */
export function pruneExpiredPairings(
  pending: Map<string, TelegramPairingRequest>
): Map<string, TelegramPairingRequest> {
  const now = Date.now()
  for (const [code, req] of pending) {
    if (now > req.expiresAt) pending.delete(code)
  }
  return pending
}
