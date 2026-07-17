// Generic LLM chat driver — replaces the Claude-only SDK with an OpenAI-compatible
// HTTP streaming implementation. Each chat node gets one long-lived session with
// conversation history kept in memory. The driver uses fetch() to POST to any
// OpenAI-compatible /v1/chat/completions endpoint.

import { IPC } from '../shared/ipc'
import type { ChatEvent, ChatImageAttachment, ChatModelConfig } from '../shared/types'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { ChatInputQueue } from './chat-queue'
import { recordAgentEvent } from './agent-status-mirror'

// Resolve an API key: $VAR_NAME reads from env, plaintext returns as-is.
function resolveApiKey(raw: string): string {
  if (raw.startsWith('$')) return process.env[raw.slice(1)] ?? raw
  return raw
}

interface PendingStream {
  abort: () => void
}

interface ChatSession {
  nodeId: string
  modelId?: string
  /** Conversation history (role + content). */
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  working: boolean
  queue: ChatInputQueue
  /** Active streaming request, if any. */
  stream: PendingStream | null
  /** Set by interrupt() before aborting so the turn-done is treated as user stop. */
  interruptedByUser: boolean
  disposed: boolean
  sessionId: string
}

type SendToMain = (channel: string, payload: unknown) => void

type WindowLike = { webContents: { send(channel: string, ...args: unknown[]): void } }

export class ChatDriver {
  private sessions = new Map<string, ChatSession>()
  private nextSessionId = 1

  constructor(
    private getWindow: () => WindowLike | null,
    private sendToMain: SendToMain,
    /** Resolved model configs (from settings) keyed by modelId. Updated on settings change. */
    private models: Map<string, ChatModelConfig> = new Map()
  ) {}

  updateModels(models: ChatModelConfig[]): void {
    this.models.clear()
    for (const m of models) this.models.set(m.id, m)
  }

  private emit(nodeId: string, event: ChatEvent): void {
    this.getWindow()?.webContents.send(IPC.chatEvent(nodeId), event)
  }

  private status(
    s: ChatSession,
    state: 'working' | 'blocked' | 'done',
    newTurn = false,
    interrupted = false
  ): void {
    const ev: NormalizedAgentEvent = {
      nodeId: s.nodeId, agentId: 'chat', kind: 'state', state, newTurn,
      sessionId: s.sessionId, ...(interrupted ? { interrupted: true } : {})
    }
    this.sendToMain(IPC.agentStatus, ev)
    recordAgentEvent(ev)
  }

  async ensure(
    nodeId: string,
    opts: { cwd?: string; sessionId?: string; fork?: boolean; accountId?: string; modelId?: string }
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.sessions.has(nodeId)) return { ok: true }
    const modelConfig = opts.modelId ? this.models.get(opts.modelId) : undefined
    if (opts.modelId && !modelConfig) {
      return { ok: false, error: `Chat model "${opts.modelId}" not configured. Add it in Settings.` }
    }
    const s: ChatSession = {
      nodeId,
      modelId: opts.modelId,
      messages: [],
      working: false,
      queue: new ChatInputQueue(),
      stream: null,
      interruptedByUser: false,
      disposed: false,
      sessionId: String(this.nextSessionId++)
    }
    this.sessions.set(nodeId, s)
    // Emit session event so the renderer persists the session id.
    this.emit(nodeId, { kind: 'session', sessionId: s.sessionId, slashCommands: [] })
    return { ok: true }
  }

  send(nodeId: string, text: string, images?: ChatImageAttachment[]): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    // Build content with images inline (text + base64 data URLs).
    let content = text
    if (images?.length) {
      const parts: string[] = []
      for (const img of images) {
        parts.push(`![image](data:${img.mediaType};base64,${img.data})`)
      }
      parts.push(text)
      content = parts.join('\n\n')
    }
    if (s.working) {
      s.queue.add(text)
      this.emit(nodeId, { kind: 'queue', items: s.queue.items() })
      return
    }
    // Append user message and start streaming.
    s.messages.push({ role: 'user', content })
    s.working = true
    this.status(s, 'working', true)
    void this.streamCompletion(s).catch((err) => {
      this.emit(nodeId, { kind: 'error', message: String(err?.message ?? err), fatal: true })
      this.teardown(s)
      this.sessions.delete(nodeId)
    })
  }

  private async streamCompletion(s: ChatSession): Promise<void> {
    const modelConfig = s.modelId ? this.models.get(s.modelId) : undefined
    if (!modelConfig) {
      this.emit(s.nodeId, { kind: 'error', message: 'No chat model configured. Add one in Settings.', fatal: true })
      return
    }
    const apiKey = resolveApiKey(modelConfig.apiKey)
    const baseUrl = modelConfig.baseUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/chat/completions`

    const abortController = new AbortController()
    s.stream = { abort: () => abortController.abort() }

    const body = {
      model: modelConfig.model,
      messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: abortController.signal
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown')
      throw new Error(`Chat API returned ${response.status}: ${errText.slice(0, 200)}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('Chat API response has no body')

    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const payload = trimmed.slice(6)
          if (payload === '[DONE]') break

          try {
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) {
              fullText += delta.content
              this.emit(s.nodeId, { kind: 'delta', block: 'text', text: delta.content })
            }
            // Check for finish reason.
            const finish = parsed.choices?.[0]?.finish_reason
            if (finish && finish !== 'null' && finish !== null) {
              // Stream complete.
            }
          } catch {
            // Skip malformed JSON lines.
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User interrupted — this is not an error.
        s.interruptedByUser = true
      } else {
        throw err
      }
    } finally {
      reader.releaseLock()
      s.stream = null
    }

    // Save the assistant response to history.
    if (fullText) {
      s.messages.push({ role: 'assistant', content: fullText })
    }

    s.working = false
    const interrupted = s.interruptedByUser
    s.interruptedByUser = false
    this.status(s, 'done', false, interrupted)
    if (!interrupted) this.flushQueue(s)
  }

  private flushQueue(s: ChatSession): void {
    const next = s.queue.takeNext()
    this.emit(s.nodeId, { kind: 'queue', items: s.queue.items() })
    if (next) {
      s.messages.push({ role: 'user', content: next.text })
      s.working = true
      this.status(s, 'working', true)
      void this.streamCompletion(s).catch((err) => {
        this.emit(s.nodeId, { kind: 'error', message: String(err?.message ?? err), fatal: true })
      })
    }
  }

  interrupt(nodeId: string): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    s.interruptedByUser = true
    s.stream?.abort()
  }

  removeQueued(nodeId: string, queueId: string): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    s.queue.remove(queueId)
    this.emit(nodeId, { kind: 'queue', items: s.queue.items() })
  }

  // No-op: the generic LLM driver doesn't use tool-use permissions (the interface
  // still declares it for Claude SDK compatibility in the renderer).
  permissionReply(_nodeId: string, _requestId: string, _decision: unknown): void {}

  private teardown(s: ChatSession): void {
    s.stream?.abort()
    s.stream = null
  }

  dispose(nodeId: string): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    s.disposed = true
    this.teardown(s)
    this.sessions.delete(nodeId)
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }
}
