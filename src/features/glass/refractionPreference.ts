import { ref } from 'vue'

// Device-local on purpose: whether edge refraction is worth its GPU cost depends on the device, so the
// choice never rides the account preference sync (`ui-preferences`).
export const REFRACTION_PREFERENCE_KEY = 'study-with-hoyomix.glass-refraction'

export type RefractionChoice = 'on' | 'off'

function readStored(): RefractionChoice | null {
  try {
    const value = window.localStorage.getItem(REFRACTION_PREFERENCE_KEY)
    return value === 'on' || value === 'off' ? value : null
  } catch {
    // Storage blocked by browser policy: treat as "automatic".
    return null
  }
}

/** The stored choice, or null for "automatic". */
export const refractionPreference = ref<RefractionChoice | null>(readStored())

/** Re-reads storage. A test seam: no `storage` listener calls it, so another tab's change applies on reload. */
export function reloadRefractionPreference(): void {
  refractionPreference.value = readStored()
}

export function setRefractionPreference(on: boolean): void {
  if (typeof on !== 'boolean') return
  const value: RefractionChoice = on ? 'on' : 'off'
  refractionPreference.value = value
  try {
    window.localStorage.setItem(REFRACTION_PREFERENCE_KEY, value)
  } catch {
    // Storage that throws keeps the choice for this session only.
  }
}
