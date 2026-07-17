import { decodeOffer, encodeOffer } from './pairing'

/** Validated, canonicalized pairing data that is safe to forward to the renderer. */
export interface RemoteInvite {
  offer: string
  relayEndpoint: string
  hostPublicKeyB64: string
}

/** Extract the first valid nodeterm pairing offer from OS command-line arguments. */
export function inviteFromArgv(argv: readonly string[]): RemoteInvite | null {
  for (const arg of argv) {
    const decoded = decodeOffer(arg)
    if (decoded) {
      return {
        offer: encodeOffer(decoded),
        relayEndpoint: decoded.relayEndpoint,
        hostPublicKeyB64: decoded.hostPublicKeyB64
      }
    }
  }
  return null
}
