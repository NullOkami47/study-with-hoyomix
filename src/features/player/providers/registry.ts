import type { Track } from '../../catalog/types'
import type { AudioProvider } from './types'

export function isProviderEligible(provider: AudioProvider, track: Track): boolean {
  try {
    return provider.canResolve
      ? Boolean(provider.canResolve(track))
      : track.sources.some((source) => source.provider === provider.id)
  } catch {
    return false
  }
}

export interface ProviderRegistration {
  provider: AudioProvider
  enabled: boolean
  automaticEligible?: boolean
  priority: number
  timeoutMs: number
}

export type ProviderRegistrationSnapshot = Readonly<ProviderRegistration>

const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateRegistration(
  registration: ProviderRegistration,
): asserts registration is ProviderRegistration {
  if (!isRecord(registration) || !isRecord(registration.provider)) {
    throw new Error('Provider registration must contain a provider')
  }
  if (
    typeof registration.provider.id !== 'string' ||
    !PROVIDER_ID_PATTERN.test(registration.provider.id)
  ) {
    throw new Error('Provider id must be a lowercase ASCII slug')
  }
  if (typeof registration.provider.resolve !== 'function') {
    throw new Error(`Provider ${registration.provider.id} requires a resolve function`)
  }
  if (typeof registration.enabled !== 'boolean') {
    throw new Error(`Provider ${registration.provider.id} requires a boolean enabled flag`)
  }
  if (typeof registration.priority !== 'number' || !Number.isFinite(registration.priority)) {
    throw new Error(`Provider ${registration.provider.id} requires a finite priority`)
  }
  if (
    typeof registration.timeoutMs !== 'number' ||
    !Number.isFinite(registration.timeoutMs) ||
    registration.timeoutMs <= 0
  ) {
    throw new Error(`Provider ${registration.provider.id} requires a positive timeout`)
  }
}

function compareProviderIds(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export class ProviderRegistry {
  private readonly registrations: readonly ProviderRegistrationSnapshot[]

  constructor(registrations: ProviderRegistration[]) {
    const ids = new Set<string>()

    this.registrations = Object.freeze(
      registrations.map((registration) => {
        validateRegistration(registration)
        if (ids.has(registration.provider.id)) {
          throw new Error(`Duplicate provider registration: ${registration.provider.id}`)
        }
        ids.add(registration.provider.id)
        return Object.freeze({ ...registration })
      }),
    )
  }

  enabled(sourceOverride?: string): readonly ProviderRegistrationSnapshot[] {
    const selectable = this.registrations
      .filter((registration) => registration.enabled)
      .sort(
        (left, right) =>
          left.priority - right.priority || compareProviderIds(left.provider.id, right.provider.id),
      )

    if (sourceOverride) {
      const override = selectable.find(
        (registration) => registration.provider.id === sourceOverride,
      )
      return override ? this.snapshot([override]) : this.snapshot([])
    }

    const ordered = selectable.filter((registration) => registration.automaticEligible !== false)
    return this.snapshot(ordered)
  }

  selectable(): readonly ProviderRegistrationSnapshot[] {
    return this.snapshot(this.registrations
      .filter((registration) => registration.enabled)
      .sort((left, right) =>
        left.priority - right.priority || compareProviderIds(left.provider.id, right.provider.id)))
  }

  selectableFor(track?: Track): readonly ProviderRegistrationSnapshot[] {
    if (!track) return this.snapshot([])
    return this.selectable().filter((registration) =>
      isProviderEligible(registration.provider, track),
    )
  }

  private snapshot(
    registrations: readonly ProviderRegistrationSnapshot[],
  ): readonly ProviderRegistrationSnapshot[] {
    return Object.freeze(
      registrations.map((registration) => Object.freeze({ ...registration })),
    )
  }
}
