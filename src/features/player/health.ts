import type { ProviderAttempt } from './providers/types'

export type ProviderAttemptListener = (attempt: ProviderAttempt) => void

export class ProviderHealthEvents {
  private readonly listeners = new Set<ProviderAttemptListener>()

  readonly emit = (attempt: ProviderAttempt): void => {
    for (const listener of this.listeners) {
      try {
        listener(attempt)
      } catch {
        // Observability listeners must not interrupt playback fallback.
      }
    }
  }

  subscribe(listener: ProviderAttemptListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
