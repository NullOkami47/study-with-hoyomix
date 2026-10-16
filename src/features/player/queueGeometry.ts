export const QUEUE_SIZE_KEY = 'study-with-hoyomix.queue-size.v1'
export interface QueueSize { width: number; height: number }

export function clampQueueSize(size: QueueSize, viewportWidth: number, viewportHeight: number): QueueSize {
  const maxWidth = Math.max(1, viewportWidth - 32)
  const maxHeight = Math.max(1, viewportHeight - 32)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(320, maxWidth), Number.isFinite(size.width) ? size.width : 512)),
    height: Math.min(maxHeight, Math.max(Math.min(420, maxHeight), Number.isFinite(size.height) ? size.height : maxHeight)),
  }
}

export function readQueueSize(storage: Pick<Storage, 'getItem'> | undefined, width: number, height: number): QueueSize {
  try {
    const raw = storage?.getItem(QUEUE_SIZE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && 'width' in parsed && 'height' in parsed &&
        typeof parsed.width === 'number' && typeof parsed.height === 'number') {
        return clampQueueSize({ width: parsed.width, height: parsed.height }, width, height)
      }
    }
  } catch { /* Invalid or unavailable storage uses safe defaults. */ }
  return clampQueueSize({ width: 512, height: height - 32 }, width, height)
}
