import { inviteFromArgv, type RemoteInvite } from './remote/invite-deep-link'

/** Minimal Electron app surface for protocol registration and second-instance delivery. */
export interface InviteProtocolApp {
  setAsDefaultProtocolClient(scheme: string): boolean
  on(
    event: 'second-instance',
    listener: (event: unknown, argv: string[]) => void
  ): void
}

export interface InviteProtocol {
  /** Attach the renderer delivery sink and flush the most recent queued invite. */
  attach(sink: (invite: RemoteInvite) => void): void
}

/** Register the nodeterm protocol and turn first/second instance command-line
 *  arguments into validated invites. Delivery remains buffered until the caller
 *  attaches a renderer sink. */
export function createInviteProtocol(
  app: InviteProtocolApp,
  argv: readonly string[],
  opts: { register?: boolean } = {}
): InviteProtocol {
  let sink: ((invite: RemoteInvite) => void) | null = null
  let pending = inviteFromArgv(argv)
  if (opts.register !== false) app.setAsDefaultProtocolClient('nodeterm')

  app.on('second-instance', (_event, secondArgv) => {
    const invite = inviteFromArgv(secondArgv)
    if (!invite) return
    if (sink) sink(invite)
    else pending = invite
  })

  return {
    attach(nextSink) {
      sink = nextSink
      if (pending) {
        nextSink(pending)
        pending = null
      }
    }
  }
}
