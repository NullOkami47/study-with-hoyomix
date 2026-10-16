/// <reference lib="webworker" />
import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, Conversion, Input, Mp4OutputFormat, Output } from 'mediabunny'
import { backgroundVideoSize, BACKGROUND_VIDEO_MAX_DURATION_SECONDS, BACKGROUND_VIDEO_MAX_FPS } from '../backgrounds/videoPolicy'

self.onmessage = async ({ data: file }: MessageEvent<File>) => {
  let input: Input | undefined
  try {
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') throw new Error('video_conversion_unsupported')
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('invalid_video')
    const firstTimestamp = await track.getFirstTimestamp()
    const duration = await track.computeDuration() - firstTimestamp
    if (!Number.isFinite(duration) || duration <= 0 || duration > BACKGROUND_VIDEO_MAX_DURATION_SECONDS) throw new Error('video_duration_limit')
    const width = await track.getDisplayWidth(), height = await track.getDisplayHeight()
    const size = backgroundVideoSize(width, height)
    const metrics = await track.computeFrameRateMetrics()
    const fps = Math.min(BACKGROUND_VIDEO_MAX_FPS, metrics.bestGuessFrameRate)
    if (!Number.isFinite(fps) || fps <= 0) throw new Error('invalid_video')
    // Leave headroom under the 25 MiB server limit, including container overhead.
    const bitrate = Math.min(7_000_000, Math.floor(23 * 1024 * 1024 * 8 / duration))
    const sink = new CanvasSink(track, { width: Math.min(640, size.width), height: Math.min(360, size.height), fit: 'contain' })
    const first = await sink.getCanvas(firstTimestamp)
    if (!first) throw new Error('invalid_video')
    const canvas = new OffscreenCanvas(first.canvas.width, first.canvas.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('video_conversion_unsupported')
    context.drawImage(first.canvas, 0, 0)
    const poster = await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer()
    const encode = async (quality: 'playback' | 'high', step: number): Promise<ArrayBuffer> => {
      const target = new BufferTarget()
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
      const conversion = await Conversion.init({ input: input!, output, tracks: 'primary', trim: {start:firstTimestamp,end:firstTimestamp+duration}, video: { ...backgroundVideoSize(width, height, quality), fit: 'contain', frameRate: fps, codec: 'avc', bitrate, forceTranscode: true, allowTransformationMetadata: false }, audio: { discard: true } })
      if (!conversion.isValid) throw new Error('video_conversion_unsupported')
      conversion.onProgress = progress => self.postMessage({ type: 'progress', progress: (step + progress) / 2 })
      await conversion.execute()
      if (!target.buffer || target.buffer.byteLength > 25 * 1024 * 1024) throw new Error('video_output_too_large')
      return target.buffer
    }
    // Encode sequentially so an upload never requires two simultaneous decoders.
    const video = await encode('playback', 0)
    const highVideo = await encode('high', 1)
    self.postMessage({ type: 'complete', video, highVideo, poster }, { transfer: [video, highVideo, poster] })
  } catch (error) { self.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'video_conversion_failed' }) }
  finally { input?.dispose() }
}
