import type { RemoteInvite } from '@shared/types'

export interface RemoteInviteState {
  pending: RemoteInvite | null
  replacement: RemoteInvite | null
}

export function emptyInviteState(): RemoteInviteState {
  return { pending: null, replacement: null }
}

/** A visible confirmation is never silently retargeted by a later OS link. */
export function receiveInvite(state: RemoteInviteState, invite: RemoteInvite): RemoteInviteState {
  if (!state.pending) return { pending: invite, replacement: null }
  if (state.pending.offer === invite.offer) return state
  return { ...state, replacement: invite }
}

export function acceptReplacement(state: RemoteInviteState): RemoteInviteState {
  if (!state.replacement) return state
  return { pending: state.replacement, replacement: null }
}

export function dismissReplacement(state: RemoteInviteState): RemoteInviteState {
  if (!state.replacement) return state
  return { ...state, replacement: null }
}

export function clearInvite(): RemoteInviteState {
  return emptyInviteState()
}

/** A stable, inspectable short form of the host's public identity. */
export function hostKeyLabel(key: string): string {
  return key.length <= 16 ? key : `${key.slice(0, 8)}...${key.slice(-8)}`
}
