import type { IncomingMessage, ServerResponse } from 'node:http'
import { HostSessionError, requireHostSession } from './auth'
import type { GitHubDeviceFlow } from './github'
import type { HostSession, PairingInvite, RelayAccount } from './repository'

type Status = { activeSeats: number; mintsRemaining: number; resetAt: Date | null }

export interface RelayApiDependencies {
  config: { maxActiveSeats: number; maxInviteMintsPerHour: number; inviteTtlMs: number; hostSessionTtlMs: number }
  flow: Pick<GitHubDeviceFlow, 'begin' | 'poll'>
  repository: {
    upsertAccount(githubUserId: string, githubLogin: string): Promise<RelayAccount>
    createSession(accountId: string, lifetimeMs: number): Promise<{ token: string; expiresAt: Date }>
    findSession(rawToken: string): Promise<HostSession | null>
    revokeSession(rawToken: string): Promise<void>
    mintInvite(accountId: string, maxActiveSeats: number, maxMintsPerHour: number, ttlMs: number): Promise<PairingInvite>
    accountStatus(accountId: string, maxMintsPerHour: number): Promise<Status>
  }
  health(): Promise<void>
}

function json(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status
  if (body === undefined) {
    res.end()
    return
  }
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const value = Buffer.from(chunk)
    bytes += value.length
    if (bytes > 16 * 1024) throw new Error('E_BAD_REQUEST')
    chunks.push(value)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('E_BAD_REQUEST')
    return body as Record<string, unknown>
  } catch {
    throw new Error('E_BAD_REQUEST')
  }
}

function requestHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const authorization = req.headers.authorization
  return { authorization: Array.isArray(authorization) ? undefined : authorization }
}

function errorCode(error: unknown): string {
  if (error instanceof HostSessionError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'E_BAD_REQUEST'
}

export function createApiHandler(deps: RelayApiDependencies): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      const code = errorCode(error)
      const status = error instanceof HostSessionError ? 401 : code === 'E_SEATS_FULL' || code === 'E_INVITE_RATE_LIMITED' ? 429 : 400
      json(res, status, { error: code })
    })
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: RelayApiDependencies): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://relay.local').pathname
  if (req.method === 'GET' && pathname === '/healthz') {
    await deps.health()
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && pathname === '/v1/host/device-flow') return json(res, 200, await deps.flow.begin())
  if (req.method === 'POST' && pathname === '/v1/host/device-flow/poll') {
    const body = await readJson(req)
    if (typeof body.deviceCode !== 'string' || !body.deviceCode) throw new Error('E_BAD_REQUEST')
    const result = await deps.flow.poll(body.deviceCode)
    if (result.status === 'pending') return json(res, 202, result)
    const account = await deps.repository.upsertAccount(result.githubUserId, result.githubLogin)
    const session = await deps.repository.createSession(account.id, deps.config.hostSessionTtlMs)
    return json(res, 200, { token: session.token, expiresAt: session.expiresAt.toISOString(), githubLogin: account.githubLogin })
  }

  const session = await requireHostSession(requestHeaders(req), deps.repository)
  if (req.method === 'GET' && pathname === '/v1/host/session') {
    const status = await deps.repository.accountStatus(session.accountId, deps.config.maxInviteMintsPerHour)
    return json(res, 200, { signedIn: true, githubLogin: session.githubLogin, expiresAt: session.expiresAt.toISOString(), activeSeats: status.activeSeats, maxActiveSeats: deps.config.maxActiveSeats, mintsRemaining: status.mintsRemaining, resetAt: status.resetAt?.toISOString() ?? null })
  }
  if (req.method === 'POST' && pathname === '/v1/pair/token') {
    return json(res, 201, await deps.repository.mintInvite(session.accountId, deps.config.maxActiveSeats, deps.config.maxInviteMintsPerHour, deps.config.inviteTtlMs))
  }
  if (req.method === 'POST' && pathname === '/v1/host/sign-out') {
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(requestHeaders(req).authorization ?? '')?.[1]
    if (!token) throw new HostSessionError()
    await deps.repository.revokeSession(token)
    return json(res, 204)
  }
  json(res, 404, { error: 'E_NOT_FOUND' })
}
