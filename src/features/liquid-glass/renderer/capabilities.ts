export type GlassCapability = 'webgpu' | 'webgl2' | 'css'

interface WebGpuCanvasContextLike {
  configure: (...args: unknown[]) => unknown
  unconfigure?: () => void
}

interface WebGl2ProbeContextLike {
  getExtension?: (name: string) => { loseContext?: () => void } | null
}

function hasUsableWebGpuContext(canvas: HTMLCanvasElement): boolean {
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu
  if (!gpu) return false

  let context: WebGpuCanvasContextLike | null = null
  try {
    context = canvas.getContext('webgpu') as unknown as WebGpuCanvasContextLike | null
    return typeof context?.configure === 'function'
  } catch {
    return false
  } finally {
    try {
      context?.unconfigure?.()
    } catch {
      // Probe cleanup must not change the selected capability.
    }
  }
}

function hasWebGl2Context(canvas: HTMLCanvasElement): boolean {
  let context: WebGl2ProbeContextLike | null = null
  try {
    context = canvas.getContext('webgl2') as unknown as WebGl2ProbeContextLike | null
    return context !== null
  } catch {
    return false
  } finally {
    try {
      context?.getExtension?.('WEBGL_lose_context')?.loseContext?.()
    } catch {
      // Probe cleanup must not change the selected capability.
    }
  }
}

export function detectGlassCapability(): GlassCapability {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return 'css'

  if (hasUsableWebGpuContext(document.createElement('canvas'))) return 'webgpu'
  if (hasWebGl2Context(document.createElement('canvas'))) return 'webgl2'
  return 'css'
}
