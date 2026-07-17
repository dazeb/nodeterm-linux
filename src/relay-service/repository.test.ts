import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool, migrate } from './db'
import { RelayRepository } from './repository'

const databaseUrl = process.env.RELAY_TEST_DATABASE_URL ?? 'postgres://nodeterm:nodeterm-test-password@127.0.0.1:55432/nodeterm_relay_test'
const pool = createPool(databaseUrl)
const repository = new RelayRepository(pool, 'test-pepper')

beforeEach(async () => {
  await pool.query('drop schema public cascade')
  await pool.query('create schema public')
  await migrate(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('RelayRepository', () => {
  it('rejects expired and revoked host sessions', async () => {
    const account = await repository.upsertAccount('123', 'octocat')
    const expired = await repository.createSession(account.id, -1)
    const active = await repository.createSession(account.id, 60_000)

    await repository.revokeSession(active.token)

    await expect(repository.findSession(expired.token)).resolves.toBeNull()
    await expect(repository.findSession(active.token)).resolves.toBeNull()
  })

  it('limits each account to five active invitations', async () => {
    const account = await repository.upsertAccount('123', 'octocat')

    for (let index = 0; index < 5; index++) {
      await expect(repository.mintInvite(account.id, 5, 20, 60_000)).resolves.toHaveProperty('pairingToken')
    }

    await expect(repository.mintInvite(account.id, 5, 20, 60_000)).rejects.toMatchObject({ code: 'E_SEATS_FULL' })
  })

  it('limits each account to twenty invitation mints per rolling hour', async () => {
    const account = await repository.upsertAccount('123', 'octocat')

    for (let index = 0; index < 20; index++) {
      const invite = await repository.mintInvite(account.id, 5, 20, 60_000)
      await repository.closeInvite(invite.pairingId)
    }

    await expect(repository.mintInvite(account.id, 5, 20, 60_000)).rejects.toMatchObject({ code: 'E_INVITE_RATE_LIMITED' })
  })

  it('allows exactly one concurrent claim for a pairing token', async () => {
    const account = await repository.upsertAccount('123', 'octocat')
    const invite = await repository.mintInvite(account.id, 5, 20, 60_000)

    const results = await Promise.allSettled([
      repository.claimInvite(invite.pairingToken, account.id),
      repository.claimInvite(invite.pairingToken, account.id)
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'E_INVITE_CLAIMED' }
    })
  })
})
