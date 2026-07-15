import { create } from 'zustand'
import type { TelegramBotStatus } from '@shared/types'

interface TelegramBotState {
  status: TelegramBotStatus
  hydrate(): Promise<void>
  start(token?: string): Promise<void>
  stop(): Promise<void>
}

const EMPTY: TelegramBotStatus = { running: false, botUsername: null, error: null }

export const useTelegramBot = create<TelegramBotState>((set) => {
  const apply = (status: TelegramBotStatus) => set({ status })

  // Listen for live status updates from main
  window.nodeTerminal.telegram.onStatusChange(apply)

  return {
    status: EMPTY,
    async hydrate() {
      apply(await window.nodeTerminal.telegram.getStatus())
    },
    async start(token) {
      apply(await window.nodeTerminal.telegram.start(token))
    },
    async stop() {
      apply(await window.nodeTerminal.telegram.stop())
    }
  }
})
