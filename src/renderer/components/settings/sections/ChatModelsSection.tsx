import { useSettings } from '../../../state/settings'
import type { ChatModelConfig } from '@shared/types'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  models: { title: 'Chat models', keywords: ['chat', 'model', 'llm', 'openai', 'provider', 'api', 'key'] }
}
const ENTRIES = Object.values(ROWS)

export function ChatModelsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const chatModels = useSettings((s) => s.settings.chatModels)
  const update = useSettings((s) => s.update)
  const patchModel = (id: string, patch: Partial<ChatModelConfig>) =>
    update({ chatModels: chatModels.map((m) => (m.id === id ? { ...m, ...patch } : m)) })
  const removeModel = (id: string) =>
    update({ chatModels: chatModels.filter((m) => m.id !== id) })
  const addModel = () =>
    update({
      chatModels: [
        ...chatModels,
        {
          id: 'model:' + crypto.randomUUID(),
          label: 'New model',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          apiKey: ''
        }
      ]
    })
  return (
    <SettingsSection
      id="chat-models"
      title="Chat models"
      description="Configure LLM providers for chat nodes. Make sure to add the provider API URL, model name, and API key."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.models}>
        <div className="space-y-4">
          {chatModels.length === 0 && (
            <p className="text-text-secondary text-sm">No models configured. Add one to start chatting.</p>
          )}
          {chatModels.map((m) => (
            <div key={m.id} className="space-y-2 rounded-md border border-border p-3">
              <FieldRow
                label="Label"
                control={
                  <Input
                    className="w-56"
                    placeholder="e.g. GPT-4o"
                    value={m.label}
                    onChange={(e) => patchModel(m.id, { label: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="Provider URL"
                control={
                  <Input
                    className="w-full"
                    placeholder="https://api.openai.com/v1"
                    value={m.baseUrl}
                    onChange={(e) => patchModel(m.id, { baseUrl: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="Model"
                control={
                  <Input
                    className="w-56"
                    placeholder="gpt-4o"
                    value={m.model}
                    onChange={(e) => patchModel(m.id, { model: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="API key"
                control={
                  <Input
                    className="w-full"
                    type="password"
                    placeholder="$MY_API_KEY or paste the key"
                    value={m.apiKey}
                    onChange={(e) => patchModel(m.id, { apiKey: e.target.value })}
                  />
                }
              />
              <Button onClick={() => removeModel(m.id)}>Remove</Button>
            </div>
          ))}
          <Button onClick={addModel}>Add model</Button>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
