import { describe, expect, it } from 'vitest'
import { encodeOffer } from './pairing'
import { inviteFromArgv } from './invite-deep-link'

const offer = encodeOffer({
  relayEndpoint: 'wss://relay.example.test',
  pairingToken: 'single-use-token',
  hostPublicKeyB64: 'host-public-key'
})

describe('inviteFromArgv', () => {
  it('returns a canonical invite from a nodeterm pairing argument', () => {
    expect(inviteFromArgv(['electron', '--flag', offer])).toEqual({
      offer,
      relayEndpoint: 'wss://relay.example.test',
      hostPublicKeyB64: 'host-public-key'
    })
  })

  it('ignores malformed and unsupported protocol arguments', () => {
    expect(
      inviteFromArgv([
        'electron',
        'nodeterm://other?code=invalid',
        'nodeterm://pair?code=invalid',
        'https://example.test'
      ])
    ).toBeNull()
  })
})
