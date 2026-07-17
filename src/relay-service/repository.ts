import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export class RelayRepositoryError extends Error {
  constructor(readonly code: 'E_SEATS_FULL' | 'E_INVITE_RATE_LIMITED' | 'E_INVITE_CLAIMED') {
    super(code)
  }
}

export interface RelayAccount {
  id: string
  githubUserId: string
  githubLogin: string
}

export interface HostSession {
  id: string
  accountId: string
  githubLogin: string
  expiresAt: Date
}

export interface PairingInvite {
  pairingId: string
  pairingToken: string
  exp: number
}

function token(): string {
  return randomBytes(32).toString('base64url')
}

export class RelayRepository {
  constructor(
    private readonly pool: Pool,
    private readonly pepper: string
  ) {}

  async upsertAccount(githubUserId: string, githubLogin: string): Promise<RelayAccount> {
    const result = await this.pool.query<RelayAccount>(
      `insert into relay_accounts(id, github_user_id, github_login)
       values($1, $2, $3)
       on conflict(github_user_id) do update set github_login = excluded.github_login
       returning id, github_user_id as "githubUserId", github_login as "githubLogin"`,
      [randomUUID(), githubUserId, githubLogin]
    )
    return result.rows[0]
  }

  async createSession(accountId: string, lifetimeMs: number): Promise<{ token: string; expiresAt: Date }> {
    const raw = token()
    const expiresAt = new Date(Date.now() + lifetimeMs)
    await this.pool.query(
      'insert into relay_sessions(id, account_id, token_hash, expires_at) values($1, $2, $3, $4)',
      [randomUUID(), accountId, this.hash(raw), expiresAt]
    )
    return { token: raw, expiresAt }
  }

  async findSession(rawToken: string): Promise<HostSession | null> {
    const result = await this.pool.query<HostSession>(
      `select sessions.id, sessions.account_id as "accountId", accounts.github_login as "githubLogin", sessions.expires_at as "expiresAt"
       from relay_sessions sessions join relay_accounts accounts on accounts.id = sessions.account_id
       where sessions.token_hash = $1 and sessions.revoked_at is null and sessions.expires_at > now()`,
      [this.hash(rawToken)]
    )
    return result.rows[0] ?? null
  }

  async revokeSession(rawToken: string): Promise<void> {
    await this.pool.query('update relay_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [this.hash(rawToken)])
  }

  async mintInvite(accountId: string, maxActiveSeats: number, maxMintsPerHour: number, ttlMs: number): Promise<PairingInvite> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select id from relay_accounts where id = $1 for update', [accountId])
      await this.enforceMintQuota(client, accountId, maxMintsPerHour)
      await client.query('update relay_invites set closed_at = now() where account_id = $1 and closed_at is null and expires_at <= now()', [accountId])
      const active = await client.query<{ count: string }>(
        'select count(*) from relay_invites where account_id = $1 and closed_at is null and expires_at > now()',
        [accountId]
      )
      if (Number(active.rows[0].count) >= maxActiveSeats) throw new RelayRepositoryError('E_SEATS_FULL')

      const raw = token()
      const expiresAt = new Date(Date.now() + ttlMs)
      const pairingId = randomUUID()
      await client.query(
        'insert into relay_invites(id, account_id, token_hash, expires_at) values($1, $2, $3, $4)',
        [pairingId, accountId, this.hash(raw), expiresAt]
      )
      await client.query('commit')
      return { pairingId, pairingToken: raw, exp: Math.floor(expiresAt.getTime() / 1000) }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async claimInvite(pairingToken: string, accountId: string): Promise<{ pairingId: string }> {
    const result = await this.pool.query<{ pairingId: string }>(
      `update relay_invites set claimed_at = now()
       where token_hash = $1 and account_id = $2 and claimed_at is null and closed_at is null and expires_at > now()
       returning id as "pairingId"`,
      [this.hash(pairingToken), accountId]
    )
    if (!result.rowCount) throw new RelayRepositoryError('E_INVITE_CLAIMED')
    return result.rows[0]
  }

  async closeInvite(pairingId: string): Promise<void> {
    await this.pool.query('update relay_invites set closed_at = now() where id = $1 and closed_at is null', [pairingId])
  }

  async accountStatus(accountId: string, maxMintsPerHour: number): Promise<{ activeSeats: number; mintsRemaining: number; resetAt: Date | null }> {
    const [seats, mints] = await Promise.all([
      this.pool.query<{ count: string }>('select count(*) from relay_invites where account_id = $1 and closed_at is null and expires_at > now()', [accountId]),
      this.pool.query<{ mintedAt: Date }>("select minted_at as \"mintedAt\" from relay_invite_mints where account_id = $1 and minted_at > now() - interval '1 hour' order by minted_at asc", [accountId])
    ])
    const oldest = mints.rows[0]?.mintedAt ?? null
    return { activeSeats: Number(seats.rows[0].count), mintsRemaining: Math.max(0, maxMintsPerHour - (mints.rowCount ?? 0)), resetAt: oldest ? new Date(oldest.getTime() + 3_600_000) : null }
  }

  async cleanupExpired(): Promise<void> {
    await this.pool.query('update relay_invites set closed_at = now() where closed_at is null and expires_at <= now()')
    await this.pool.query('delete from relay_sessions where expires_at <= now() or revoked_at is not null')
    await this.pool.query("delete from relay_invite_mints where minted_at <= now() - interval '1 hour'")
  }

  private async enforceMintQuota(client: PoolClient, accountId: string, maxMintsPerHour: number): Promise<void> {
    await client.query("delete from relay_invite_mints where account_id = $1 and minted_at <= now() - interval '1 hour'", [accountId])
    const result = await client.query<{ count: string }>('select count(*) from relay_invite_mints where account_id = $1', [accountId])
    if (Number(result.rows[0].count) >= maxMintsPerHour) throw new RelayRepositoryError('E_INVITE_RATE_LIMITED')
    await client.query('insert into relay_invite_mints(account_id) values($1)', [accountId])
  }

  private hash(raw: string): string {
    return createHash('sha256').update(this.pepper).update(raw).digest('hex')
  }
}
