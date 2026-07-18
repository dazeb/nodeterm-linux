import type { StoredHostSession } from './host-session-store'

export interface HostAuthStatus {
  signedIn: boolean
  githubLogin?: string
  expiresAt?: number
  activeSeats?: number
  maxActiveSeats?: number
  mintsRemaining?: number
  resetAt?: number
}

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export class HostedRelayClient {
  constructor(private readonly apiBase = process.env.NODETERM_RELAY_API_BASE ?? 'https://relay.nodeterm.dev') {}

  async beginDeviceFlow(): Promise<DeviceFlowStart> {
    return this.request('/v1/host/device-flow', { method: 'POST' })
  }

  async pollDeviceFlow(deviceCode: string): Promise<{ status: 'pending' } | StoredHostSession> {
    const result = await this.request<{ status?: string; token?: string; githubLogin?: string; expiresAt?: string }>('/v1/host/device-flow/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode })
    })
    if (result.status === 'pending') return { status: 'pending' }
    if (!result.token || !result.githubLogin || !result.expiresAt) throw new Error('Invalid host session response.')
    return { token: result.token, githubLogin: result.githubLogin, expiresAt: Date.parse(result.expiresAt) }
  }

  async status(session: StoredHostSession): Promise<HostAuthStatus> {
    const result = await this.request<Omit<HostAuthStatus, 'signedIn'>>('/v1/host/session', { headers: this.auth(session.token) })
    return { signedIn: true, ...result, expiresAt: result.expiresAt ? Date.parse(String(result.expiresAt)) : session.expiresAt, resetAt: result.resetAt ? Date.parse(String(result.resetAt)) : undefined }
  }

  async mintInvite(session: StoredHostSession): Promise<{ pairingId: string; pairingToken: string; exp: number }> {
    return this.request('/v1/pair/token', { method: 'POST', headers: this.auth(session.token) })
  }

  async signOut(session: StoredHostSession): Promise<void> {
    await this.request('/v1/host/sign-out', { method: 'POST', headers: this.auth(session.token) })
  }

  private auth(token: string): HeadersInit { return { authorization: `Bearer ${token}` } }
  private async request<T = void>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(`${this.apiBase}${path}`, { ...init, signal: controller.signal })
      if (response.status === 204) return undefined as T
      const body = await response.json().catch(() => ({})) as T & { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Hosted relay request failed.')
      return body
    } catch (error) {
      if (error instanceof Error && error.message === 'Hosted relay request failed.') throw error
      throw new Error('Cannot reach the hosted relay. The service is not deployed yet. Set NODETERM_RELAY_API_BASE to test locally.')
    } finally { clearTimeout(timer) }
  }
}
