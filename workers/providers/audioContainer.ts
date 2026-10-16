/**
 * Audio container identification for the ChKSz transient-media proxy.
 *
 * ## Why this exists
 *
 * The CDN serves some higher tiers as `application/octet-stream` even though the body is a valid
 * audio asset. The MIME guard is strict by design, and the fix for that quirk must not be to
 * widen the guard: accepting a generic type on the strength of its header alone would admit any
 * payload. Instead the leading bytes are sniffed, and only a positively identified container
 * earns a corrected `content-type`.
 *
 * This module holds the vocabulary that fix is built on — the closed set of containers the
 * deployment can serve, and the MIME type each one corrects to. Keeping it separate means the
 * mapping is testable on its own, and that simply adding a format does not require a change to
 * the proxy.
 *
 * ## Identification is closed, not free-form
 *
 * {@link AudioContainer} is a union, not a string. A caller cannot report a container this
 * deployment does not know about, and an unrecognised prefix resolves to `unknown` rather than
 * to a name invented from the bytes.
 */

/**
 * Containers this deployment can plausibly serve. A closed union, so an identified container can
 * only ever be one of these names — it is not a free-form string field.
 */
export type AudioContainer =
  | 'flac'
  | 'mp3'
  | 'ogg'
  | 'wav'
  | 'm4a'
  | 'aac'
  | 'ape'
  | 'wma'
  | 'unknown'

/**
 * The `audio/*` type that corresponds to each identified container.
 *
 * Used to *correct* a generic upstream declaration rather than forward it, so a client is never
 * handed `application/octet-stream` for something we have positively identified as audio.
 * `unknown` has no entry, which is what makes the allowance narrow: any container we cannot name
 * keeps the strict `audio/*` requirement.
 */
export const AUDIO_CONTAINER_MIME: Readonly<Partial<Record<AudioContainer, string>>> = Object.freeze({
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ape: 'audio/x-ape',
  wma: 'audio/x-ms-wma',
})

/** MIME essence bound: long enough for any real type, short enough to be a non-channel. */
const MAX_MIME_LENGTH = 128
const MIME_ESSENCE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/

/**
 * Reduce a `content-type` header to its essence, or `undefined` when it is not a plausible
 * MIME type.
 *
 * Parameters (including `charset`) are dropped, because a parameter is an unbounded string
 * and therefore a potential exfiltration channel. Anything failing the essence grammar is
 * discarded rather than truncated: a mangled value would be worse than no value.
 */
export const mimeEssence = (raw: string | null | undefined): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const essence = raw.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (essence.length === 0 || essence.length > MAX_MIME_LENGTH) return undefined
  return MIME_ESSENCE.test(essence) ? essence : undefined
}
