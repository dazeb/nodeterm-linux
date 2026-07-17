// Telegram's slash-command menu is configured separately from Telegraf's
// handlers. Keep this list pure so the menu remains testable and discoverable.
export const telegramBotCommands = [
  { command: 'start', description: 'Open the nodeterm menu' },
  { command: 'help', description: 'Show available commands' },
  { command: 'status', description: 'Show bot and pairing status' },
  { command: 'pair', description: 'Request access to this machine' },
  { command: 'terminals', description: 'List terminal sessions' },
  { command: 'projects', description: 'List projects' },
  { command: 'attach', description: 'View terminal output' },
  { command: 'send', description: 'Send text to a terminal' },
  { command: 'invite', description: 'Create a Team Access invite' }
] as const

/** Make Telegram's persistent menu button open the registered slash commands. */
export const telegramMenuButton = { type: 'commands' } as const
