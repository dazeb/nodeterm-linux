// License/premium client — always-premium stub for the Linux port.
// The original file had real Ed25519 token verification, Stripe checkout,
// and API refresh calls. All subscription features are now free.
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'

const ALWAYS_PREMIUM: LicenseStatus = {
  tier: 'premium',
  active: true,
  expiresAt: Math.floor(Date.now() / 1000) + 365 * 86400 * 10, // 10 years out
  seats: 999,
  error: null
}

export function getStoredEntitlement(): string | null {
  return 'always-premium'
}

export function isPremium(): boolean {
  return true
}

export function licensedSeats(): number {
  return 999
}

export function initLicense(onChange?: () => void): void {
  const broadcast = (s: LicenseStatus) => {
    platform().broadcast(IPC.licenseChanged, s)
    onChange?.()
  }

  platform().handle(IPC.licenseStatus, () => ALWAYS_PREMIUM)
  platform().handle(IPC.licenseUpgrade, () => {
    void platform().openExternal('https://github.com/dazeb/nodeterm-linux')
    return ALWAYS_PREMIUM
  })
  platform().handle(IPC.licenseActivate, async () => ALWAYS_PREMIUM)
  platform().handle(IPC.licenseDeactivate, async () => ALWAYS_PREMIUM)

  broadcast(ALWAYS_PREMIUM)
}
