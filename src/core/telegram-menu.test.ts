import { describe, expect, it } from 'vitest'
import {
  terminalLabel,
  projectLabel,
  truncateTelegramLabel,
  groupSessionsByProject,
  encodeProjectCallback,
  encodeTerminalCallback,
  decodeCallback,
  type TelegramSessionInfo
} from './telegram-menu'

const testSession = (overrides: Partial<TelegramSessionInfo> & { id: string }): TelegramSessionInfo => ({
  title: '',
  shell: '',
  cwd: '',
  projectId: '',
  projectName: '',
  live: false,
  ...overrides
})

describe('terminalLabel', () => {
  it('uses the terminal title when non-empty', () => {
    const s = testSession({ id: 'n1', title: 'API server', shell: 'bash', cwd: '/work/api' })
    expect(terminalLabel(s)).toBe('API server')
  })

  it('falls back to shell + cwd basename when title is empty', () => {
    const s = testSession({ id: 'n2', title: '', shell: 'zsh', cwd: '/work/web' })
    expect(terminalLabel(s)).toBe('zsh · web')
  })

  it('uses only shell when cwd is empty', () => {
    const s = testSession({ id: 'n3', title: '', shell: 'bash', cwd: '' })
    expect(terminalLabel(s)).toBe('bash')
  })

  it('uses only cwd basename when shell is empty', () => {
    const s = testSession({ id: 'n4', title: '', shell: '', cwd: '/home/project/src' })
    expect(terminalLabel(s)).toBe('src')
  })

  it('uses "terminal" when both title, shell, and cwd are empty', () => {
    const s = testSession({ id: 'n5', title: '', shell: '', cwd: '' })
    expect(terminalLabel(s)).toBe('terminal')
  })
})

describe('projectLabel', () => {
  it('formats singular count', () => {
    expect(projectLabel({ name: 'API' }, 1)).toBe('API · 1 terminal')
  })

  it('formats plural count', () => {
    expect(projectLabel({ name: 'Web' }, 3)).toBe('Web · 3 terminals')
  })
})

describe('truncateTelegramLabel', () => {
  it('keeps short strings unchanged', () => {
    expect(truncateTelegramLabel('hello', 10)).toBe('hello')
  })

  it('truncates long strings with ellipsis', () => {
    expect(truncateTelegramLabel('hello world this is long', 12)).toBe('hello world…')
  })

  it('does not include trailing whitespace', () => {
    expect(truncateTelegramLabel('abc', 3)).toBe('abc')
  })
})

describe('groupSessionsByProject', () => {
  it('groups sessions by project id with correct project names', () => {
    const sessions = [
      testSession({ id: 't1', title: 'build', projectId: 'p1', projectName: 'CI' }),
      testSession({ id: 't2', title: 'dev', projectId: 'p2', projectName: 'Web' }),
      testSession({ id: 't3', title: 'test', projectId: 'p1', projectName: 'CI' })
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups).toHaveLength(2)
    expect(groups[0].projectName).toBe('CI')
    expect(groups[0].sessions).toHaveLength(2)
    expect(groups[1].projectName).toBe('Web')
    expect(groups[1].sessions).toHaveLength(1)
  })

  it('groups sessions without a project into a bucket', () => {
    const sessions = [
      testSession({ id: 't1', title: 'standalone', projectId: '', projectName: '' })
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].projectName).toBe('Other')
    expect(groups[0].sessions[0].id).toBe('t1')
  })
})

describe('callback codecs', () => {
  it('encodes and decodes project callbacks', () => {
    const cb = encodeProjectCallback('p1')
    expect(cb).toBe('proj:p1')
    expect(decodeCallback(cb)).toEqual({ type: 'project', id: 'p1' })
  })

  it('encodes and decodes terminal callbacks', () => {
    const cb = encodeTerminalCallback('t1')
    expect(cb).toBe('term:t1')
    expect(decodeCallback(cb)).toEqual({ type: 'terminal', id: 't1' })
  })

  it('returns null for unknown callbacks', () => {
    expect(decodeCallback('garbage')).toBeNull()
    expect(decodeCallback('')).toBeNull()
  })
})
