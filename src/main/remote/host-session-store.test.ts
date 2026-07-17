import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostSessionStore } from './host-session-store'
import type { SafeStorageLike } from '../telegram-token-store'

const dirs: string[] = []
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, '')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('HostSessionStore', () => {
  it('encrypts and reloads a live host session without exposing its token', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nodeterm-host-session-'))
    dirs.push(dir)
    const file = path.join(dir, 'host-session.json')
    const session = { token: 'host-session-secret', githubLogin: 'octocat', expiresAt: Date.now() + 60_000 }

    await new HostSessionStore(file, safeStorage).save(session)

    await expect(readFile(file, 'utf8')).resolves.not.toContain(session.token)
    await expect(new HostSessionStore(file, safeStorage).load()).resolves.toEqual(session)
  })

  it('treats expired sessions as absent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nodeterm-host-session-'))
    dirs.push(dir)
    const store = new HostSessionStore(path.join(dir, 'host-session.json'), safeStorage)
    await store.save({ token: 'expired', githubLogin: 'octocat', expiresAt: Date.now() - 1 })

    await expect(store.load()).resolves.toBeNull()
  })
})
