import path from 'node:path'
import type { TelegramSessionInfo, TelegramProjectInfo } from './telegram-bot'

export type { TelegramSessionInfo, TelegramProjectInfo }

export interface ProjectGroup {
  projectId: string
  projectName: string
  sessions: TelegramSessionInfo[]
}

export function terminalLabel(s: TelegramSessionInfo): string {
  if (s.title) return s.title
  const shell = s.shell?.trim()
  const cwd = s.cwd?.trim()
  if (shell && cwd) return `${shell} · ${path.basename(cwd)}`
  if (shell) return shell
  if (cwd) return path.basename(cwd)
  return 'terminal'
}

export function projectLabel(project: { name: string }, count: number): string {
  return `${project.name} · ${count} terminal${count !== 1 ? 's' : ''}`
}

export function truncateTelegramLabel(label: string, maxLen: number): string {
  if (label.length <= maxLen) return label
  return `${label.slice(0, Math.max(0, maxLen - 1))}…`
}

export function groupSessionsByProject(sessions: TelegramSessionInfo[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const key = s.projectId || '__none__'
    if (!map.has(key)) {
      map.set(key, {
        projectId: key === '__none__' ? '' : s.projectId!,
        projectName: s.projectId ? (s.projectName || 'Project') : 'Other',
        sessions: []
      })
    }
    map.get(key)!.sessions.push(s)
  }
  return [...map.values()]
}

export function encodeProjectCallback(projectId: string): string {
  return `proj:${projectId}`
}

export function encodeTerminalCallback(terminalId: string): string {
  return `term:${terminalId}`
}

export function decodeCallback(
  data: string
): { type: 'project'; id: string } | { type: 'terminal'; id: string } | null {
  if (!data) return null
  const colon = data.indexOf(':')
  if (colon === -1) return null
  const prefix = data.slice(0, colon)
  const id = data.slice(colon + 1)
  if (!prefix || !id) return null
  if (prefix === 'proj') return { type: 'project', id }
  if (prefix === 'term') return { type: 'terminal', id }
  return null
}
