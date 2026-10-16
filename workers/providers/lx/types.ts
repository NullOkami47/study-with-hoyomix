import type { CanonicalProviderId } from '../config'
import type { ResolverMetadataError } from '../resolverMetadata'

export type LxProviderId = Extract<CanonicalProviderId, `lx-${string}`>

export interface LxExternalIdBinding {
  source: string
  id: string
  quality: string
}

export interface LxBuiltRequest {
  url: URL
  headers?: Readonly<Record<string, string>>
}

export interface LxParsedMetadata {
  url: string
  mimeType: string
}

export type LxParsedResponse =
  | LxParsedMetadata
  | { error: ResolverMetadataError }

export interface LxResolverDescriptor {
  providerId: LxProviderId
  externalIdPattern: RegExp
  parseExternalId(value: string): LxExternalIdBinding | null
  buildRequest(input: {
    configuredOrigin: string
    binding: LxExternalIdBinding
  }): LxBuiltRequest
  parseResponse(value: unknown, binding: LxExternalIdBinding): LxParsedResponse | null
}

export type LxMetadataResult =
  | { ok: true; mediaUrl: URL; mimeType: string }
  | { ok: false; error: ResolverMetadataError }
