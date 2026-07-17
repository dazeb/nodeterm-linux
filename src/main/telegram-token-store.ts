import { promises as fs } from 'node:fs'

/** The small Electron safeStorage surface this store needs. Kept injectable so
 *  the file format is testable without importing Electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

interface TokenFile {
  token?: string
  tokenEnc?: string
}

/** The encrypted token exists, but the OS keyring cannot read it right now. */
export class TelegramBotTokenLockedError extends Error {
  constructor() {
    super('Telegram bot credentials are encrypted, but the OS keyring is locked or unavailable.')
    this.name = 'TelegramBotTokenLockedError'
  }
}

/** Persist the Telegram bot token outside settings.json so it never reaches the
 *  renderer. Uses Electron safeStorage when possible and a 0600 fallback when
 *  no Linux keyring is available. */
export class TelegramBotTokenStore {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  async load(): Promise<string | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    let parsed: TokenFile
    try {
      parsed = JSON.parse(raw) as TokenFile
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    if (typeof parsed.tokenEnc === 'string' && parsed.tokenEnc.length > 0) {
      if (!this.safeStorage.isEncryptionAvailable()) throw new TelegramBotTokenLockedError()
      try {
        const token = this.safeStorage.decryptString(Buffer.from(parsed.tokenEnc, 'base64')).trim()
        return token || null
      } catch {
        return null
      }
    }

    if (typeof parsed.token === 'string' && parsed.token.trim()) {
      const token = parsed.token.trim()
      // Upgrade a 0600 plaintext fallback as soon as a keyring becomes available.
      if (this.safeStorage.isEncryptionAvailable()) await this.save(token).catch(() => {})
      return token
    }
    return null
  }

  async save(token: string): Promise<void> {
    const trimmed = token.trim()
    if (!trimmed) throw new Error('Telegram bot token is empty.')
    const body: TokenFile = this.safeStorage.isEncryptionAvailable()
      ? { tokenEnc: this.safeStorage.encryptString(trimmed).toString('base64') }
      : { token: trimmed }
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, this.filePath)
    await fs.chmod(this.filePath, 0o600)
  }
}
