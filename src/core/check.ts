// Polls a backend /v1/check feed from the main process (so the renderer CSP stays 'self').
// For this fork, the default returns empty since there is no fork-specific announcement/update-policy
// server. Set NODETERM_API_BASE to a custom endpoint to host your own announcements feed.
import { platform } from './platform'
import type { Announcement, UpdatePolicy } from '../shared/types'

const API_BASE = process.env.NODETERM_API_BASE || ''
const CACHE_MS = 5 * 60 * 1000

export interface CheckResult {
  messages: Announcement[]
  update: UpdatePolicy
}

const EMPTY: CheckResult = { messages: [], update: { minSupported: null, mandatory: false } }

function allowed(): boolean {
  // Only check when an explicit API base is configured. Without one, the fork has no
  // announcement/update-policy server — the upstream's api.nodeterm.dev is specific to
  // the nodeterm project and does not apply to this fork.
  if (!API_BASE) return false
  if (process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED) return false
  if (!platform().isPackaged && !process.env.NODETERM_API_BASE) return false
  return true
}

function sanitize(data: unknown): CheckResult {
  if (!data || typeof data !== 'object') return EMPTY
  const d = data as Record<string, unknown>
  const rawMessages = Array.isArray(d.messages) ? d.messages : []
  const messages: Announcement[] = rawMessages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => typeof m.id === 'string' && typeof m.title === 'string')
    .map((m) => ({
      id: m.id as string,
      title: m.title as string,
      body: typeof m.body === 'string' ? m.body : undefined,
      url: typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url : undefined,
      level: m.level === 'success' || m.level === 'warning' ? m.level : 'info'
    }))
  const u = (d.update ?? {}) as Record<string, unknown>
  const update: UpdatePolicy = {
    minSupported: typeof u.minSupported === 'string' ? u.minSupported : null,
    mandatory: u.mandatory === true
  }
  return { messages, update }
}

let cache: { at: number; data: CheckResult } | null = null

export async function fetchCheck(): Promise<CheckResult> {
  if (!allowed()) return EMPTY
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.data
  try {
    const q = new URLSearchParams({
      version: platform().appVersion,
      os: process.platform,
      channel: 'stable'
    })
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}/v1/check?${q.toString()}`, {
      signal: ctrl.signal,
      cache: 'no-cache'
    }).finally(() => clearTimeout(t))
    if (!res.ok) return cache?.data ?? EMPTY
    const data = sanitize(await res.json())
    cache = { at: now, data }
    return data
  } catch {
    return cache?.data ?? EMPTY
  }
}
