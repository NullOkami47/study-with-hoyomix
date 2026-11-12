// Shared bounded artwork ingress; audio metadata budgets are deliberately separate.
export const ARTWORK_TIMEOUT_MS = 8_000
export const MAX_ARTWORK_DIMENSION = 512
export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024
const SAFE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export function normaliseImageMime(value: string | null): string | null {
  const match = value?.match(/^\s*(image\/(?:jpeg|jpg|png|webp|gif))(?:\s*;\s*charset\s*=\s*[a-z0-9_-]+)?\s*$/i)
  const essence = match?.[1]?.toLowerCase()
  if (essence === 'image/jpg') return 'image/jpeg'
  return essence && SAFE_IMAGE_MIMES.has(essence) ? essence : null
}

export async function readArtworkBytes(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ARTWORK_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  if (size === 0) return null
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
