/**
 * Pure view-model for the Settings → Team Access section
 * (docs/superpowers/plans/2026-07-15-team-access.md, Task 4). Kept free of React/DOM so the
 * gate/counter/invite-share logic is unit-tested without a renderer. The section component is a thin
 * shell over these + the stores.
 */

export interface TeamAccessView {
  /** Not premium → show the pitch/CTA, hide the seat panel. */
  gated: boolean
  /** Seat usage line, e.g. "Used 2 / 5" (used = pending + connected, matching the seat cap). */
  counterText: string
  /** Premium AND a seat is free → the invite button is enabled. */
  canInvite: boolean
}

export function teamAccessView({
  premium,
  seats,
  used
}: {
  premium: boolean
  seats: number
  used: number
}): TeamAccessView {
  return {
    gated: !premium,
    counterText: `Used ${used} / ${seats}`,
    canInvite: premium && used < seats
  }
}

export interface InviteShare {
  /** A friendly, copyable message carrying the pairing code. */
  copyText: string
  /** A `mailto:` URL (recipientless when no email) prefilled with subject + body + the code. */
  mailtoUrl: string
}

const SHARE_INSTRUCTION = 'Open this invite link in nodeterm to join the remote team:'

export function inviteShare({ offer, email }: { offer: string; email?: string }): InviteShare {
  const copyText = `You're invited to my nodeterm session.\n\n${SHARE_INSTRUCTION}\n\n${offer}`
  const subject = "You're invited to a nodeterm Team Access seat"
  const body = `${SHARE_INSTRUCTION}\n\n${offer}`
  const recipient = (email ?? '').trim()
  const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  return {
    copyText,
    mailtoUrl: `mailto:${recipient}?${query}`
  }
}

/** Build a Telegram deep link to share an invite via a running bot. Returns null
 *  when the bot username is not known (bot not running). */
export function inviteShareTelegram(
  offer: string,
  botUsername: string | null,
  email?: string
): string | null {
  if (!botUsername) return null
  const label = (email ?? '').trim() || 'a teammate'
  const text =
    `You're invited to my nodeterm session by ${label}.\n` +
    `${SHARE_INSTRUCTION}\n${offer}`
  return `https://t.me/${botUsername}?start=invite_${encodeURIComponent(offer)}`
}

/**
 * Map a rejected `relayHost.invite()` to the "All seats in use" UI: true when the coded seat-cap
 * error surfaces (Task 2 rejects with a message CONTAINING `E_SEATS_FULL`).
 */
export function seatFullMessage(err: unknown): boolean {
  const msg = (err as { message?: unknown } | null)?.message
  return String(msg ?? err).includes('E_SEATS_FULL')
}
