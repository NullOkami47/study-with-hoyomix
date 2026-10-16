import { detectGlassCapability, type GlassCapability } from './capabilities'
import { WebGlRenderer } from './WebGlRenderer'
import { WebGpuRenderer } from './WebGpuRenderer'

export const NORMAL_DPR_CAP = 1.5
export const LOW_POWER_DPR_CAP = 1

export interface GlassRenderer {
  readonly capability: Exclude<GlassCapability, 'css'>
  dispose: () => void
  render: (timestamp: number) => void
  resize: (cssWidth: number, cssHeight: number, dpr: number) => void
}

export interface RendererInitialisation {
  canvas: HTMLCanvasElement
  capability: GlassCapability
  renderer: GlassRenderer | null
}

export function cappedDevicePixelRatio(lowPower: boolean): number {
  const cap = lowPower ? LOW_POWER_DPR_CAP : NORMAL_DPR_CAP
  const reported = typeof window === 'undefined' ? 1 : window.devicePixelRatio
  const valid = Number.isFinite(reported) && reported > 0 ? reported : 1
  return Math.max(1, Math.min(valid, cap))
}

function replaceCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const replacement = canvas.cloneNode(false) as HTMLCanvasElement
  canvas.replaceWith(replacement)
  return replacement
}

export async function initialiseGlassRenderer(
  initialCanvas: HTMLCanvasElement,
): Promise<RendererInitialisation> {
  const detected = detectGlassCapability()
  let canvas = initialCanvas

  if (detected === 'webgpu') {
    try {
      const renderer = await WebGpuRenderer.create(canvas)
      return { canvas, capability: renderer.capability, renderer }
    } catch {
      // A canvas cannot switch context modes after a context has been created.
      // Always retry WebGL2 with a fresh element after any WebGPU failure.
      canvas = replaceCanvas(canvas)
    }
  }

  if (detected === 'webgpu' || detected === 'webgl2') {
    try {
      const renderer = new WebGlRenderer(canvas)
      return { canvas, capability: renderer.capability, renderer }
    } catch {
      // The opaque CSS layer remains the final, fully usable fallback.
    }
  }

  return { canvas, capability: 'css', renderer: null }
}
