import { describe, expect, it } from 'vitest'
import { GitHubDeviceFlow, GitHubDeviceFlowError } from './github'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

describe('GitHubDeviceFlow', () => {
  it('starts Device Flow with read:user scope', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      requests.push({ url, init })
      return json({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    }
    const flow = new GitHubDeviceFlow('client-id', 'client-secret', fetcher)

    await expect(flow.begin()).resolves.toEqual({ deviceCode: 'device', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 })
    expect(requests[0].url).toBe('https://github.com/login/device/code')
    expect(requests[0].init?.method).toBe('POST')
    expect(String(requests[0].init?.body)).toContain('scope=read%3Auser')
  })

  it('reports a pending authorization without fetching a user', async () => {
    let calls = 0
    const fetcher = async (): Promise<Response> => {
      calls++
      return json({ error: 'authorization_pending' })
    }
    const flow = new GitHubDeviceFlow('client-id', 'client-secret', fetcher)

    await expect(flow.poll('device')).resolves.toEqual({ status: 'pending' })
    expect(calls).toBe(1)
  })

  it.each(['slow_down', 'access_denied', 'expired_token'] as const)('maps GitHub %s to a typed error', async (error) => {
    const flow = new GitHubDeviceFlow('client-id', 'client-secret', async () => json({ error }))

    await expect(flow.poll('device')).rejects.toMatchObject(new GitHubDeviceFlowError(error))
  })

  it('returns the immutable GitHub user identity after authorization', async () => {
    const responses = [json({ access_token: 'never-return-this', token_type: 'bearer' }), json({ id: 42, login: 'octocat' })]
    const fetcher = async (): Promise<Response> => responses.shift()!
    const flow = new GitHubDeviceFlow('client-id', 'client-secret', fetcher)

    await expect(flow.poll('device')).resolves.toEqual({ status: 'authorized', githubUserId: '42', githubLogin: 'octocat' })
  })
})
