import { describe, expect, it } from 'vitest'
import { requireHostSession } from './auth'

describe('requireHostSession', () => {
  it('rejects malformed bearer authorization', async () => {
    await expect(requireHostSession({}, { findSession: async () => null })).rejects.toMatchObject({ status: 401, code: 'E_HOST_SESSION' })
    await expect(requireHostSession({ authorization: 'Bearer' }, { findSession: async () => null })).rejects.toMatchObject({ status: 401, code: 'E_HOST_SESSION' })
  })

  it('returns the live session for exactly one bearer token', async () => {
    const session = { id: 'session', accountId: 'account', githubLogin: 'octocat', expiresAt: new Date() }

    await expect(requireHostSession({ authorization: 'Bearer session-token' }, { findSession: async (token: string) => token === 'session-token' ? session : null })).resolves.toBe(session)
  })
})
