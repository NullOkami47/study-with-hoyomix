import { readonly, ref, type InjectionKey } from 'vue'
import type { ProviderPreferencesStore } from '../player/providerPreferences'

type ProviderState = { id: string; available: boolean; enabled: boolean }

/** Presentation-only permissions, fed by the existing public configuration and preferences. */
export function createArtworkPermissions(preferences: Pick<ProviderPreferencesStore, 'isDisabled' | 'subscribe'>) {
  const revision = ref(0)
  let states: readonly ProviderState[] | undefined
  const enabled = (provider: string) => !preferences.isDisabled(provider) &&
    (states === undefined || states.some(row => row.id === provider && row.available && row.enabled))
  const identity = () => ['lx', 'gd-studio', 'chksz'].map(enabled).join(',')
  let previous = identity()
  const changed = () => { const current = identity(); if (current !== previous) { previous = current; revision.value++ } }
  const dispose = preferences.subscribe(changed)
  return {
    revision: readonly(revision),
    update(value: readonly ProviderState[]) { states = value.map(row => ({ ...row })); changed() },
    allows(source: string) {
      void revision.value
      const provider = /^\/api\/providers\/(lx|gd-studio|chksz)\/artwork(?:\/|\?)/u.exec(source)?.[1]
      if (!provider) return false
      // Before configuration arrives the approved Worker remains authoritative for the GET.
      // An observed explicit disablement is never bypassed by cached public bytes.
      return enabled(provider)
    },
    dispose,
  }
}

export const artworkPermissionsKey: InjectionKey<ReturnType<typeof createArtworkPermissions>> = Symbol('artworkPermissions')
