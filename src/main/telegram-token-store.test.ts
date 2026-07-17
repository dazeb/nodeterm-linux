import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TelegramBotTokenStore, type SafeStorageLike } from './telegram-token-store'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
  }
}

describe('TelegramBotTokenStore', () => {
  it('persists a manually-added token encrypted and reloads it after restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nodeterm-telegram-token-'))
    dirs.push(dir)
    const file = path.join(dir, 'telegram-bot-token.json')
    const token = '123456:bot-secret'

    await new TelegramBotTokenStore(file, fakeSafeStorage()).save(token)

    expect(await readFile(file, 'utf8')).not.toContain(token)
    await expect(new TelegramBotTokenStore(file, fakeSafeStorage()).load()).resolves.toBe(token)
  })
})
