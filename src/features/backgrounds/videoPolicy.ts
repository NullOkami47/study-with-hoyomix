export const BACKGROUND_VIDEO_MAX_WIDTH = 2560
export const BACKGROUND_VIDEO_MAX_HEIGHT = 1440
export const BACKGROUND_VIDEO_PLAYBACK_WIDTH = 1920
export const BACKGROUND_VIDEO_PLAYBACK_HEIGHT = 1080
export const BACKGROUND_VIDEO_MAX_FPS = 30
export const BACKGROUND_VIDEO_MAX_DURATION_SECONDS = 120

/** Fit inside the playback envelope, preserve aspect ratio, never upscale. */
export function backgroundVideoSize(width: number, height: number, quality: 'playback' | 'high' = 'playback'): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) throw new Error('invalid_video')
  const maxWidth = quality === 'high' ? BACKGROUND_VIDEO_MAX_WIDTH : BACKGROUND_VIDEO_PLAYBACK_WIDTH
  const maxHeight = quality === 'high' ? BACKGROUND_VIDEO_MAX_HEIGHT : BACKGROUND_VIDEO_PLAYBACK_HEIGHT
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) }
}
