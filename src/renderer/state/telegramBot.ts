import { create } from 'zustand'
import type { TelegramBotStatus, TelegramPairingCodeEvent, TelegramApprovedUser } from '@shared/types'

interface TelegramBotState {
  status: TelegramBotStatus
  /** A pending pairing code waiting for desktop approval. Null when none is pending. */
  pendingPairing: TelegramPairingCodeEvent | null
  /** Cached list of approved Telegram users (null = not loaded yet). */
  approvedUsers: TelegramApprovedUser[] | null
  hydrate(): Promise<void>
  start(token?: string): Promise<void>
  stop(): Promise<void>
  /** Accept a pending pairing code → pins the Telegram user. */
  acceptPairing(code: string): void
  /** Reject a pending pairing code. */
  rejectPairing(code: string): void
  /** Load the approved users list from main. */
  loadApprovedUsers(): Promise<void>
  /** Revoke an approved Telegram user. */
  revokeUser(chatId: number): Promise<void>
  /** Clear the pending pairing (e.g. after timeout or rejection in the store). */
  clearPendingPairing(): void
}

const EMPTY_STATUS: TelegramBotStatus = {
  running: false,
  botUsername: null,
  error: null,
  approvedUserCount: 0
}

export const useTelegramBot = create<TelegramBotState>((set) => {
  const apply = (status: TelegramBotStatus) => {
    set((s) => ({ status, approvedUsers: s.approvedUsers }))
  }

  // Listen for live status updates from main
  const unsubStatus = window.nodeTerminal.telegram.onStatusChange(apply)

  // Listen for pairing code events
  const unsubPairing = window.nodeTerminal.telegram.onPairingCode((event) => {
    set({ pendingPairing: event })
  })

  return {
    status: EMPTY_STATUS,
    pendingPairing: null,
    approvedUsers: null,

    async hydrate() {
      apply(await window.nodeTerminal.telegram.getStatus())
    },

    async start(token) {
      apply(await window.nodeTerminal.telegram.start(token))
    },

    async stop() {
      apply(await window.nodeTerminal.telegram.stop())
    },

    acceptPairing(code: string) {
      window.nodeTerminal.telegram.acceptPairing(code)
      set({ pendingPairing: null })
      // Reload the approved user list after accepting
      void loadApprovedUsersInternal()
    },

    rejectPairing(code: string) {
      window.nodeTerminal.telegram.rejectPairing(code)
      set({ pendingPairing: null })
    },

    async loadApprovedUsers() {
      const users = await window.nodeTerminal.telegram.getApprovedUsers()
      set({ approvedUsers: users })
    },

    async revokeUser(chatId: number) {
      await window.nodeTerminal.telegram.revokeUser(chatId)
      // Reload the list after revoking
      const users = await window.nodeTerminal.telegram.getApprovedUsers()
      set({ approvedUsers: users })
    },

    clearPendingPairing() {
      set({ pendingPairing: null })
    }
  }

  function loadApprovedUsersInternal(): void {
    window.nodeTerminal.telegram.getApprovedUsers().then((users) => {
      set({ approvedUsers: users })
    }).catch(() => { /* fail open */ })
  }
})
