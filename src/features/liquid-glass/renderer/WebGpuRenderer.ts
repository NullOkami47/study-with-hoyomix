/**
 * The adapter/device/context/pipeline lifecycle is adapted from
 * liquid-glass-studio src/utils/GPUUtils.ts at
 * d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
import { liquidFieldWgslShader } from '../shaders/liquid-field.wgsl'

import type { GlassRenderer } from './Renderer'

interface GpuBufferLike {
  destroy: () => void
}

interface GpuPassLike {
  draw: (vertices: number) => void
  end: () => void
  setBindGroup: (index: number, bindGroup: unknown) => void
  setPipeline: (pipeline: GpuPipelineLike) => void
}

interface GpuCommandEncoderLike {
  beginRenderPass: (descriptor: unknown) => GpuPassLike
  finish: () => unknown
}

interface GpuPipelineLike {
  getBindGroupLayout: (index: number) => unknown
}

interface GpuDeviceLike {
  createBindGroup: (descriptor: unknown) => unknown
  createBuffer: (descriptor: { size: number; usage: number }) => GpuBufferLike
  createCommandEncoder: () => GpuCommandEncoderLike
  createRenderPipeline: (descriptor: unknown) => GpuPipelineLike
  createShaderModule: (descriptor: { code: string }) => unknown
  destroy?: () => void
  queue: {
    submit: (commands: unknown[]) => void
    writeBuffer: (buffer: GpuBufferLike, offset: number, data: BufferSource) => void
  }
}

interface GpuAdapterLike {
  requestDevice: () => Promise<GpuDeviceLike>
}

interface GpuLike {
  getPreferredCanvasFormat: () => string
  requestAdapter: () => Promise<GpuAdapterLike | null>
}

interface GpuCanvasContextLike {
  configure: (descriptor: unknown) => void
  getCurrentTexture: () => { createView: () => unknown }
  unconfigure?: () => void
}

function gpuApi(): GpuLike {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) throw new Error('WebGPU is unavailable')
  return gpu
}

function gpuBufferUsage(): { COPY_DST: number; UNIFORM: number } {
  const usage = (globalThis as typeof globalThis & {
    GPUBufferUsage?: { COPY_DST: number; UNIFORM: number }
  }).GPUBufferUsage
  if (!usage) throw new Error('WebGPU buffer usage constants are unavailable')
  return usage
}

function releaseGpuResources(
  context: GpuCanvasContextLike | null,
  uniformBuffer: GpuBufferLike | null,
  device: GpuDeviceLike,
): void {
  try {
    uniformBuffer?.destroy()
  } catch {
    // Continue releasing the remaining independently owned resources.
  }
  try {
    context?.unconfigure?.()
  } catch {
    // A failed context cleanup must not prevent device cleanup.
  }
  try {
    device.destroy?.()
  } catch {
    // Cleanup remains best effort after both initialisation and normal use.
  }
}

export class WebGpuRenderer implements GlassRenderer {
  readonly capability = 'webgpu' as const

  private disposed = false

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: GpuCanvasContextLike,
    private readonly device: GpuDeviceLike,
    private readonly pipeline: GpuPipelineLike,
    private readonly bindGroup: unknown,
    private readonly uniformBuffer: GpuBufferLike,
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<WebGpuRenderer> {
    const gpu = gpuApi()
    const adapter = await gpu.requestAdapter()
    if (!adapter) throw new Error('WebGPU adapter request returned no adapter')

    const device = await adapter.requestDevice()
    let context: GpuCanvasContextLike | null = null
    let uniformBuffer: GpuBufferLike | null = null
    try {
      context = (canvas.getContext as (contextId: string) => unknown)('webgpu') as
        | GpuCanvasContextLike
        | null
      if (!context || typeof context.configure !== 'function') {
        throw new Error('WebGPU canvas context is unavailable')
      }

      const format = gpu.getPreferredCanvasFormat()
      context.configure({ alphaMode: 'opaque', device, format })

      const module = device.createShaderModule({ code: liquidFieldWgslShader })
      const pipeline = device.createRenderPipeline({
        fragment: {
          entryPoint: 'fragmentMain',
          module,
          targets: [{ format }],
        },
        layout: 'auto',
        primitive: { topology: 'triangle-list' },
        vertex: { entryPoint: 'vertexMain', module },
      })

      const usage = gpuBufferUsage()
      uniformBuffer = device.createBuffer({
        size: 16,
        usage: usage.UNIFORM | usage.COPY_DST,
      })
      const bindGroup = device.createBindGroup({
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        layout: pipeline.getBindGroupLayout(0),
      })

      return new WebGpuRenderer(canvas, context, device, pipeline, bindGroup, uniformBuffer)
    } catch (error) {
      releaseGpuResources(context, uniformBuffer, device)
      throw error
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const width = Math.max(1, Math.round(cssWidth * dpr))
    const height = Math.max(1, Math.round(cssHeight * dpr))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
  }

  render(timestamp: number): void {
    if (this.disposed) return

    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.canvas.width, this.canvas.height, timestamp / 1000, 0]),
    )
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          clearValue: { a: 1, b: 0.055, g: 0.028, r: 0.018 },
          loadOp: 'clear',
          storeOp: 'store',
          view: this.context.getCurrentTexture().createView(),
        },
      ],
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(3)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    releaseGpuResources(this.context, this.uniformBuffer, this.device)
  }
}
