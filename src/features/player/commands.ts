export interface PlaybackPauseLease {
  cancel(): void
  isSettled(): boolean
  resumeIfStillOwned(): void
}

export interface PlayerCommands {
  isPlaying(): boolean
  pause(): void
  pauseForInterruption(): PlaybackPauseLease | undefined
  play(): void
  stop(): void
  previous?(): void
  next?(): void
  seek?(seconds: number): void
}

const noPlayer: PlayerCommands = {
  isPlaying: () => false,
  pause() {},
  pauseForInterruption: () => undefined,
  play() {},
  stop() {},
}

interface Registration {
  commands: PlayerCommands
  leases: Set<PlaybackPauseLease>
  token: symbol
}

const registrations: Registration[] = []
let activeRegistrationRevision = 0
const activeRegistration = (): Registration | undefined => registrations.at(-1)
const activePlayer = (): PlayerCommands => activeRegistration()?.commands ?? noPlayer

function cancelRegistrationLeases(registration: Registration | undefined): void {
  registration?.leases.forEach((lease) => cancelTrackedLease(registration, lease))
  registration?.leases.clear()
}

function observeLeaseSettlement(registration: Registration, lease: PlaybackPauseLease): boolean {
  const settled = lease.isSettled()
  if (settled) registration.leases.delete(lease)
  return settled
}

function cancelTrackedLease(registration: Registration, lease: PlaybackPauseLease): void {
  if (!observeLeaseSettlement(registration, lease)) lease.cancel()
  registration.leases.delete(lease)
}

export const playbackCommands: PlayerCommands = {
  isPlaying: () => activePlayer().isPlaying(),
  pause: () => activePlayer().pause(),
  pauseForInterruption: () => {
    const registration = activeRegistration()
    if (!registration) return undefined
    const registrationRevision = activeRegistrationRevision
    const lease = registration.commands.pauseForInterruption()
    if (!lease) return undefined
    registration.leases.add(lease)
    return {
      cancel() {
        cancelTrackedLease(registration, lease)
      },
      isSettled() {
        return observeLeaseSettlement(registration, lease)
      },
      resumeIfStillOwned() {
        if (
          activeRegistration() !== registration ||
          activeRegistrationRevision !== registrationRevision
        ) {
          cancelTrackedLease(registration, lease)
          return
        }
        if (observeLeaseSettlement(registration, lease)) return
        lease.resumeIfStillOwned()
        observeLeaseSettlement(registration, lease)
      },
    }
  },
  play: () => activePlayer().play(),
  stop: () => activePlayer().stop(),
  previous: () => activePlayer().previous?.(),
  next: () => activePlayer().next?.(),
  seek: (seconds) => activePlayer().seek?.(seconds),
}

export function registerPlayerCommands(commands: PlayerCommands): () => void {
  cancelRegistrationLeases(activeRegistration())
  const registration = { commands, leases: new Set<PlaybackPauseLease>(), token: Symbol('player-commands') }
  registrations.push(registration)
  activeRegistrationRevision += 1
  return () => {
    const index = registrations.findIndex(({ token }) => token === registration.token)
    if (index < 0) return
    const wasActive = index === registrations.length - 1
    cancelRegistrationLeases(registration)
    registrations.splice(index, 1)
    if (wasActive) activeRegistrationRevision += 1
  }
}
