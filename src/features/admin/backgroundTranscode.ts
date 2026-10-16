export interface BackgroundUploadOptions { onProgress?: (progress: number) => void; onStage?: (stage: 'uploading') => void; signal?: AbortSignal }
export interface PreparedBackgroundVideo { video: File; highVideo: File; poster: File }
export async function prepareBackgroundVideo(file: File, options: BackgroundUploadOptions = {}): Promise<PreparedBackgroundVideo> {
  if (file.size > 200 * 1024 * 1024) throw new Error('video_source_too_large')
  if (options.signal?.aborted) throw new Error('video_conversion_cancelled')
  const worker = new Worker(new URL('./backgroundTranscode.worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    const cleanup = () => { options.signal?.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { cleanup(); reject(new Error('video_conversion_cancelled')) }
    options.signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = () => { cleanup(); reject(new Error('video_conversion_failed')) }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { options.onProgress?.(data.progress); return }
      cleanup()
      if (data.type === 'error') { reject(new Error(data.error)); return }
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 120)
      resolve({ video: new File([data.video], `${name}.mp4`, { type: 'video/mp4' }), highVideo: new File([data.highVideo], `${name}-high.mp4`, { type: 'video/mp4' }), poster: new File([data.poster], `${name}.jpg`, { type: 'image/jpeg' }) })
    }
    worker.postMessage(file)
  })
}
