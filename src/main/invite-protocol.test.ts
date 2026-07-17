import { describe, expect, it } from 'vitest'
import { encodeOffer } from './remote/pairing'
import { createInviteProtocol, type InviteProtocolApp } from './invite-protocol'

const offer = encodeOffer({
  relayEndpoint: 'wss://relay.example.test',
  pairingToken: 'single-use-token',
  hostPublicKeyB64: 'host-public-key'
})

function fakeApp(): InviteProtocolApp & { emitSecondInstance(argv: string[]): void; schemes: string[] } {
  let secondInstance: ((event: unknown, argv: string[]) => void) | undefined
  const schemes: string[] = []
  return {
    schemes,
    setAsDefaultProtocolClient: (scheme) => {
      schemes.push(scheme)
      return true
    },
    on: (_event, listener) => {
      secondInstance = listener
    },
    emitSecondInstance: (argv) => secondInstance?.({}, argv)
  }
}

describe('createInviteProtocol', () => {
  it('queues a first-launch invite until a renderer sink is attached', () => {
    const app = fakeApp()
    const protocol = createInviteProtocol(app, ['electron', offer])
    const received: string[] = []

    protocol.attach((invite) => received.push(invite.offer))

    expect(app.schemes).toEqual(['nodeterm'])
    expect(received).toEqual([offer])
  })

  it('forwards a valid second-instance invite after the sink is attached', () => {
    const app = fakeApp()
    const protocol = createInviteProtocol(app, ['electron'])
    const received: string[] = []
    protocol.attach((invite) => received.push(invite.offer))

    app.emitSecondInstance(['electron', offer])

    expect(received).toEqual([offer])
  })
})
