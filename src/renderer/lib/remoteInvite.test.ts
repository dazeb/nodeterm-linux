import { describe, expect, it } from 'vitest'
import type { RemoteInvite } from '@shared/types'
import {
  acceptReplacement,
  emptyInviteState,
  hostKeyLabel,
  receiveInvite
} from './remoteInvite'

function invite(id: string): RemoteInvite {
  return {
    offer: `nodeterm://pair?code=${id}`,
    relayEndpoint: 'wss://relay.example.test',
    hostPublicKeyB64: `host-public-key-${id}`
  }
}

describe('remote invite state', () => {
  it('holds a second link as a replacement until the user accepts it', () => {
    const first = invite('first')
    const second = invite('second')
    const state = receiveInvite(receiveInvite(emptyInviteState(), first), second)

    expect(state.pending).toEqual(first)
    expect(state.replacement).toEqual(second)
    expect(acceptReplacement(state)).toEqual({ pending: second, replacement: null })
  })

  it('shortens the host public key for confirmation display', () => {
    expect(hostKeyLabel('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefgh...stuvwxyz')
  })
})
