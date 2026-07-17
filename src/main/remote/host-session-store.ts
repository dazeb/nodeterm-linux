import { promises as fs } from 'node:fs'
import type { SafeStorageLike } from '../telegram-token-store'

export interface StoredHostSession {
  token: string
  githubLogin: string
  expiresAt: number
}

type SessionFile = { session?: string; sessionEnc?: string }

export class HostSessionStore {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  async load(): Promise<StoredHostSession | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let file: SessionFile
    try {
      file = JSON.parse(raw) as SessionFile
    } catch {
      return null
    }
    const serialized = file.sessionEnc && this.safeStorage.isEncryptionAvailable()
      ? this.safeStorage.decryptString(Buffer.from(file.sessionEnc, 'base64'))
      : file.session
    if (!serialized) return null
    try {
      const session = JSON.parse(serialized) as StoredHostSession
      if (!session.token || !session.githubLogin || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null
      return session
    } catch {
      return null
    }
  }

  async save(session: StoredHostSession): Promise<void> {
    if (!session.token || !session.githubLogin || !Number.isFinite(session.expiresAt)) throw new Error('Invalid host session.')
    const serialized = JSON.stringify(session)
    const file: SessionFile = this.safeStorage.isEncryptionAvailable()
      ? { sessionEnc: this.safeStorage.encryptString(serialized).toString('base64') }
      : { session: serialized }
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, this.filePath)
    await fs.chmod(this.filePath, 0o600)
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true })
  }
}
