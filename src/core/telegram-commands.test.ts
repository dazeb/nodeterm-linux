import { describe, expect, it } from 'vitest'
import { telegramBotCommands, telegramMenuButton } from './telegram-commands'

describe('telegramBotCommands', () => {
  it('registers /start in Telegram command menus', () => {
    expect(telegramBotCommands).toContainEqual({
      command: 'start',
      description: 'Open the nodeterm menu'
    })
  })

  it('uses the slash-command menu button', () => {
    expect(telegramMenuButton).toEqual({ type: 'commands' })
  })
})
