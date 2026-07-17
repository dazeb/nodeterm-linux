export interface RelayConfig {
  databaseUrl: string
  githubClientId: string
  githubClientSecret: string
  sessionPepper: string
  publicOrigin: string
  apiOrigin: string
  relayPath: string
  maxActiveSeats: number
  maxInviteMintsPerHour: number
  inviteTtlMs: number
  maxSessionMs: number
  hostSessionTtlMs: number
}

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

export function readRelayConfig(env: Env = process.env): RelayConfig {
  const publicOrigin = required(env, 'RELAY_PUBLIC_ORIGIN')
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('RELAY_PUBLIC_ORIGIN must be an absolute HTTPS origin')
  }

  return {
    databaseUrl: required(env, 'RELAY_DATABASE_URL'),
    githubClientId: required(env, 'RELAY_GITHUB_CLIENT_ID'),
    githubClientSecret: required(env, 'RELAY_GITHUB_CLIENT_SECRET'),
    sessionPepper: required(env, 'RELAY_SESSION_PEPPER'),
    publicOrigin: origin.origin,
    apiOrigin: origin.origin,
    relayPath: '/v1/relay',
    maxActiveSeats: positiveInt(env, 'RELAY_MAX_ACTIVE_SEATS', 5),
    maxInviteMintsPerHour: positiveInt(env, 'RELAY_MAX_INVITE_MINTS_PER_HOUR', 20),
    inviteTtlMs: positiveInt(env, 'RELAY_INVITE_TTL_MS', 86_400_000),
    maxSessionMs: positiveInt(env, 'RELAY_MAX_SESSION_MS', 28_800_000),
    hostSessionTtlMs: positiveInt(env, 'RELAY_HOST_SESSION_TTL_MS', 2_592_000_000)
  }
}
