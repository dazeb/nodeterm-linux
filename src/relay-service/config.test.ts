import { describe, expect, it } from 'vitest'
import { readRelayConfig } from './config'

const valid = {
  RELAY_DATABASE_URL: 'postgres://relay:secret@db/relay',
  RELAY_GITHUB_CLIENT_ID: 'client-id',
  RELAY_GITHUB_CLIENT_SECRET: 'client-secret',
  RELAY_SESSION_PEPPER: 'a'.repeat(64),
  RELAY_PUBLIC_ORIGIN: 'https://relay.nodeterm.dev'
}

describe('readRelayConfig', () => {
  it('rejects a missing required setting without exposing secrets', () => {
    expect(() => readRelayConfig({ ...valid, RELAY_DATABASE_URL: undefined })).toThrow(
      'RELAY_DATABASE_URL is required'
    )
  })

  it('uses the documented free limits when no overrides are supplied', () => {
    expect(readRelayConfig(valid)).toMatchObject({
      maxActiveSeats: 5,
      maxInviteMintsPerHour: 20,
      inviteTtlMs: 86_400_000,
      maxSessionMs: 28_800_000
    })
  })
})
