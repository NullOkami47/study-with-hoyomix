/** An asynchronous consumer no longer owns the configuration it started with. */
export class ProviderConfigurationChangedError extends Error {
  constructor() {
    super('Provider configuration changed during playback resolution')
    this.name = 'ProviderConfigurationChangedError'
  }
}

/** A transport failure says nothing about whether a track or provider is available. */
export class ProviderConfigurationUnavailableError extends Error {
  constructor(
    readonly classification: 'network' | 'timeout' | 'http',
    readonly status: number | null = null,
  ) {
    super('Provider configuration temporarily unavailable')
    this.name = 'ProviderConfigurationUnavailableError'
  }
}
