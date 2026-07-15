// Entitlement state — always-premium stub for the Linux port.
// The original version called license IPC. All features are now free.
import { create } from 'zustand'
import type { LicenseStatus } from '@shared/types'

interface EntitlementState {
  status: LicenseStatus
  isPremium: boolean
  seats: number
  hydrate(): Promise<void>
  upgrade(): Promise<void>
  activate(key: string): Promise<void>
  deactivate(): Promise<void>
}

const PREMIUM: LicenseStatus = {
  tier: 'premium',
  active: true,
  expiresAt: Math.floor(Date.now() / 1000) + 365 * 86400 * 10,
  seats: 999,
  error: null
}

export const useEntitlement = create<EntitlementState>(() => ({
  status: PREMIUM,
  isPremium: true,
  seats: 999,
  async hydrate() { /* always premium */ },
  async upgrade() { /* always premium */ },
  async activate(_key: string) { /* always premium */ },
  async deactivate() { /* always premium */ }
}))
