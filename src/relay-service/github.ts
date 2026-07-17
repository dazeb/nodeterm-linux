export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>

export class GitHubDeviceFlowError extends Error {
  constructor(readonly code: 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_request') {
    super(code)
  }
}

export type DeviceAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'authorized'; githubUserId: string; githubLogin: string }

type GitHubError = { error?: string }

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new GitHubDeviceFlowError('invalid_request')
  return value as Record<string, unknown>
}

export class GitHubDeviceFlow {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: GitHubFetch = fetch
  ) {}

  async begin(): Promise<DeviceAuthorization> {
    const body = new URLSearchParams({ client_id: this.clientId, scope: 'read:user' })
    const response = await this.fetcher('https://github.com/login/device/code', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body
    })
    const data = asRecord(await response.json())
    if (!response.ok) throw new GitHubDeviceFlowError('invalid_request')
    if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || typeof data.verification_uri !== 'string' || typeof data.expires_in !== 'number') {
      throw new GitHubDeviceFlowError('invalid_request')
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: Math.max(5, typeof data.interval === 'number' ? data.interval : 5)
    }
  }

  async poll(deviceCode: string): Promise<DevicePoll> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    const response = await this.fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body
    })
    const data = asRecord(await response.json()) as GitHubError & { access_token?: unknown }
    if (data.error === 'authorization_pending') return { status: 'pending' }
    if (data.error === 'slow_down' || data.error === 'access_denied' || data.error === 'expired_token') {
      throw new GitHubDeviceFlowError(data.error)
    }
    if (!response.ok || typeof data.access_token !== 'string') throw new GitHubDeviceFlowError('invalid_request')

    const userResponse = await this.fetcher('https://api.github.com/user', {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${data.access_token}` }
    })
    const user = asRecord(await userResponse.json())
    if (!userResponse.ok || (typeof user.id !== 'number' && typeof user.id !== 'string') || typeof user.login !== 'string') {
      throw new GitHubDeviceFlowError('invalid_request')
    }
    return { status: 'authorized', githubUserId: String(user.id), githubLogin: user.login }
  }
}
