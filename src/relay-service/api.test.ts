import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiHandler } from './api'

const sessions = new Map<string, { id: string; accountId: string; githubLogin: string; expiresAt: Date }>()
const handler = createApiHandler({
  config: { maxActiveSeats: 5, maxInviteMintsPerHour: 20, inviteTtlMs: 86_400_000, hostSessionTtlMs: 2_592_000_000 },
  flow: {
    begin: async () => ({ deviceCode: 'device', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized' as const, githubUserId: '42', githubLogin: 'octocat' })
  },
  repository: {
    upsertAccount: async () => ({ id: 'account', githubUserId: '42', githubLogin: 'octocat' }),
    createSession: async () => ({ token: 'session-token', expiresAt: new Date('2030-01-01T00:00:00Z') }),
    findSession: async (token: string) => sessions.get(token) ?? null,
    revokeSession: async () => {},
    mintInvite: async () => ({ pairingId: 'pairing', pairingToken: 'pairing-token', exp: 1_700_000_000 }),
    accountStatus: async () => ({ activeSeats: 1, mintsRemaining: 19, resetAt: new Date('2030-01-01T00:00:00Z') })
  },
  health: async () => {}
})
const server = createServer(handler)
let baseUrl = ''

beforeAll(async () => {
  sessions.set('session-token', { id: 'session', accountId: 'account', githubLogin: 'octocat', expiresAt: new Date('2030-01-01T00:00:00Z') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe('relay service API', () => {
  it('starts Device Flow', async () => {
    const response = await fetch(`${baseUrl}/v1/host/device-flow`, { method: 'POST' })
    await expect(response.json()).resolves.toMatchObject({ deviceCode: 'device', userCode: 'ABCD-EFGH' })
  })

  it('exchanges an authorized device code for an opaque host session', async () => {
    const response = await fetch(`${baseUrl}/v1/host/device-flow/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: 'device' }) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ token: 'session-token', githubLogin: 'octocat' })
  })

  it('rejects an invite mint without a host session', async () => {
    const response = await fetch(`${baseUrl}/v1/pair/token`, { method: 'POST' })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'E_HOST_SESSION' })
  })

  it('returns host quota status and a pairing token for an authenticated host', async () => {
    const headers = { authorization: 'Bearer session-token' }
    const status = await fetch(`${baseUrl}/v1/host/session`, { headers })
    await expect(status.json()).resolves.toMatchObject({ githubLogin: 'octocat', activeSeats: 1, maxActiveSeats: 5, mintsRemaining: 19 })

    const invite = await fetch(`${baseUrl}/v1/pair/token`, { method: 'POST', headers })
    expect(invite.status).toBe(201)
    await expect(invite.json()).resolves.toEqual({ pairingId: 'pairing', pairingToken: 'pairing-token', exp: 1_700_000_000 })
  })

  it('returns a bounded bad-request response for malformed JSON', async () => {
    const response = await fetch(`${baseUrl}/v1/host/device-flow/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'E_BAD_REQUEST' })
  })
})
