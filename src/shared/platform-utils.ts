/**
 * Platform detection and display helpers for cross-platform keyboard shortcuts.
 * Used by the renderer to show the correct modifier key symbol.
 */

/** Detects whether the current platform is macOS (darwin). */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}

/** Returns the keyboard modifier display symbol for the current platform. */
export function modSymbol(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl'
}

/** Replaces ⌘ in a shortcut hint string with the platform-appropriate modifier label. */
export function hintLabel(text: string): string {
  if (isMacPlatform()) return text
  return text.replace(/⌘/g, 'Ctrl')
}
