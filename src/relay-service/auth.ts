import type { HostSession } from './repository'

export class HostSessionError extends Error {
  readonly status = 401
  readonly code = 'E_HOST_SESSION'

  constructor() {
    super('E_HOST_SESSION')
  }
}

export interface HostSessionLookup {
  findSession(rawToken: string): Promise<HostSession | null>
}

export async function requireHostSession(
  headers: Record<string, string | undefined>,
  sessions: HostSessionLookup
): Promise<HostSession> {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(headers.authorization ?? '')
  if (!match) throw new HostSessionError()
  const session = await sessions.findSession(match[1])
  if (!session) throw new HostSessionError()
  return session
}
