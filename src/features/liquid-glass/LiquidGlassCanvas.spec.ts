import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AppShell from '../../components/shell/AppShell.vue'
import LiquidGlassCanvas from './LiquidGlassCanvas.vue'
import { WebGlRenderer } from './renderer/WebGlRenderer'

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  readonly disconnect = vi.fn()
  readonly observe = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  emit(width: number, height: number): void {
    this.callback(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

function createWebGl2Context(
  options: { failShader?: boolean; failVertexArray?: boolean; throwBuffer?: boolean } = {},
) {
  const loseContext = vi.fn()
  const gl = {
    ARRAY_BUFFER: 0x8892,
    COLOR_BUFFER_BIT: 0x4000,
    COMPILE_STATUS: 0x8b81,
    FLOAT: 0x1406,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    STATIC_DRAW: 0x88e4,
    TRIANGLE_STRIP: 0x0005,
    VERTEX_SHADER: 0x8b31,
    attachShader: vi.fn(),
    bindBuffer: vi.fn(),
    bindVertexArray: vi.fn(),
    bufferData: vi.fn(),
    clear: vi.fn(),
    clearColor: vi.fn(),
    compileShader: vi.fn(),
    createBuffer: vi.fn(() => {
      if (options.throwBuffer) throw new Error('Buffer allocation failed')
      return {}
    }),
    createProgram: vi.fn(() => ({})),
    createShader: vi.fn(() => (options.failShader ? null : {})),
    createVertexArray: vi.fn(() => (options.failVertexArray ? null : {})),
    deleteBuffer: vi.fn(),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    deleteVertexArray: vi.fn(),
    drawArrays: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
    getProgramInfoLog: vi.fn(() => ''),
    getProgramParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    getShaderParameter: vi.fn(() => true),
    getUniformLocation: vi.fn(() => ({})),
    linkProgram: vi.fn(),
    shaderSource: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    useProgram: vi.fn(),
    vertexAttribPointer: vi.fn(),
    viewport: vi.fn(),
  }

  return { gl, loseContext }
}

function createWebGpuBoundary(
  options: { failPipeline?: boolean; throwBufferDestroy?: boolean; throwUnconfigure?: boolean } = {},
) {
  const buffer = {
    destroy: vi.fn(() => {
      if (options.throwBufferDestroy) throw new Error('Buffer destruction failed')
    }),
  }
  const pass = {
    draw: vi.fn(),
    end: vi.fn(),
    setBindGroup: vi.fn(),
    setPipeline: vi.fn(),
  }
  const encoder = {
    beginRenderPass: vi.fn(() => pass),
    finish: vi.fn(() => ({})),
  }
  const pipeline = { getBindGroupLayout: vi.fn(() => ({})) }
  const device = {
    createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn(() => buffer),
    createCommandEncoder: vi.fn(() => encoder),
    createRenderPipeline: vi.fn(() => {
      if (options.failPipeline) throw new Error('Pipeline creation failed')
      return pipeline
    }),
    createShaderModule: vi.fn(() => ({})),
    destroy: vi.fn(),
    queue: {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
    },
  }
  const adapter = { requestDevice: vi.fn(async () => device) }
  const gpu = {
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    requestAdapter: vi.fn(async () => adapter),
  }
  const texture = { createView: vi.fn(() => ({})) }
  const context = {
    configure: vi.fn(),
    getCurrentTexture: vi.fn(() => texture),
    unconfigure: vi.fn(() => {
      if (options.throwUnconfigure) throw new Error('Context unconfigure failed')
    }),
  }

  return { buffer, context, device, gpu }
}

function setGpu(value: unknown): void {
  Object.defineProperty(navigator, 'gpu', { configurable: true, value })
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
  Object.defineProperty(document, 'hidden', { configurable: true, value: value === 'hidden' })
}

function installBrowserBoundaries(options: { reducedMotion?: boolean } = {}) {
  const media = {
    matches: options.reducedMotion ?? false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++
    callbacks.set(id, callback)
    return id
  })
  const cancelAnimationFrame = vi.fn((id: number) => callbacks.delete(id))

  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
  vi.stubGlobal('GPUBufferUsage', { COPY_DST: 0x0008, UNIFORM: 0x0040 })
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => media) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 180,
    height: 180,
    left: 0,
    right: 320,
    top: 0,
    width: 320,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })

  function runNextFrame(timestamp = 16): boolean {
    const next = callbacks.entries().next()
    if (next.done) return false
    const [id, callback] = next.value
    callbacks.delete(id)
    callback(timestamp)
    return true
  }

  return {
    cancelAnimationFrame,
    media,
    pendingAnimationFrames: () => callbacks.size,
    requestAnimationFrame,
    runNextFrame,
  }
}

beforeEach(() => {
  TestResizeObserver.instances = []
  setGpu(undefined)
  setVisibility('visible')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LiquidGlassCanvas', () => {
  it('renders an inert decorative WebGL layer and applies bounded DPR caps', async () => {
    installBrowserBoundaries()
    const { gl } = createWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, {
      props: { lowPower: false, backgroundUrl: 'invalid://optional', albumArtUrl: '' },
    })
    await flushPromises()

    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.attributes('data-capability')).toBe('webgl2')
    expect(wrapper.get('canvas').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('.liquid-glass__fallback').attributes('aria-hidden')).toBe('true')
    expect(getComputedStyle(wrapper.element).pointerEvents).toBe('none')
    expect(wrapper.get<HTMLCanvasElement>('canvas').element.width).toBe(480)
    expect(wrapper.get<HTMLCanvasElement>('canvas').element.height).toBe(270)

    await wrapper.setProps({ lowPower: true })
    await nextTick()

    expect(wrapper.get<HTMLCanvasElement>('canvas').element.width).toBe(320)
    expect(wrapper.get<HTMLCanvasElement>('canvas').element.height).toBe(180)
    wrapper.unmount()
  })

  it('renders one still frame without scheduling continuous animation for reduced motion', async () => {
    const { requestAnimationFrame } = installBrowserBoundaries({ reducedMotion: true })
    const { gl } = createWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(gl.drawArrays).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('initialises and resizes without rendering or scheduling while the document is hidden', async () => {
    const { requestAnimationFrame } = installBrowserBoundaries()
    setVisibility('hidden')
    const { gl } = createWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 480, 270)
    expect(gl.drawArrays).not.toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(gl.drawArrays).toHaveBeenCalledOnce()
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('applies a low-power resize while hidden without rendering or scheduling a frame', async () => {
    const { requestAnimationFrame } = installBrowserBoundaries()
    const { gl } = createWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()
    const canvas = wrapper.get<HTMLCanvasElement>('canvas').element
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    const renderCount = gl.drawArrays.mock.calls.length
    const scheduledCount = requestAnimationFrame.mock.calls.length

    await wrapper.setProps({ lowPower: true })
    await nextTick()

    expect(canvas.width).toBe(320)
    expect(canvas.height).toBe(180)
    expect(gl.drawArrays).toHaveBeenCalledTimes(renderCount)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(scheduledCount)
    wrapper.unmount()
  })

  it('pauses while hidden, resumes when visible, resizes, and releases WebGL resources', async () => {
    const { cancelAnimationFrame, media, requestAnimationFrame } = installBrowserBoundaries()
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')
    const { gl, loseContext } = createWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()
    const canvas = wrapper.get<HTMLCanvasElement>('canvas').element
    const observer = TestResizeObserver.instances[0]

    observer.emit(200, 100)
    expect(canvas.width).toBe(300)
    expect(canvas.height).toBe(150)
    expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 300, 150)

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cancelAnimationFrame).toHaveBeenCalled()

    const callsBeforeResume = requestAnimationFrame.mock.calls.length
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(requestAnimationFrame.mock.calls.length).toBeGreaterThan(callsBeforeResume)

    wrapper.unmount()

    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(gl.deleteBuffer).toHaveBeenCalledOnce()
    expect(gl.deleteVertexArray).toHaveBeenCalledOnce()
    expect(gl.deleteProgram).toHaveBeenCalledOnce()
    expect(loseContext).toHaveBeenCalledTimes(2)
  })

  it('continues WebGL cleanup when an early resource deletion throws', async () => {
    installBrowserBoundaries()
    const { gl, loseContext } = createWebGl2Context()
    gl.deleteBuffer.mockImplementation(() => {
      throw new Error('Buffer deletion failed')
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(() => wrapper.unmount()).not.toThrow()
    expect(gl.deleteBuffer).toHaveBeenCalledOnce()
    expect(gl.deleteVertexArray).toHaveBeenCalledOnce()
    expect(gl.deleteProgram).toHaveBeenCalledOnce()
    expect(loseContext).toHaveBeenCalledTimes(2)
  })

  it('uses a real WebGPU pipeline and destroys its owned resources on unmount', async () => {
    installBrowserBoundaries()
    const webgpu = createWebGpuBoundary()
    setGpu(webgpu.gpu)
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((kind) => (kind === 'webgpu' ? webgpu.context : null) as never)

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(wrapper.attributes('data-capability')).toBe('webgpu')
    expect(webgpu.context.configure).toHaveBeenCalledOnce()
    expect(webgpu.device.createRenderPipeline).toHaveBeenCalledOnce()
    expect(webgpu.device.queue.submit).toHaveBeenCalled()
    expect(getContext).not.toHaveBeenCalledWith('webgl2')

    wrapper.unmount()

    expect(webgpu.buffer.destroy).toHaveBeenCalledOnce()
    expect(webgpu.context.unconfigure).toHaveBeenCalledTimes(2)
    expect(webgpu.device.destroy).toHaveBeenCalledOnce()
  })

  it('continues WebGPU cleanup when buffer destruction throws', async () => {
    installBrowserBoundaries()
    const webgpu = createWebGpuBoundary({ throwBufferDestroy: true })
    setGpu(webgpu.gpu)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgpu' ? webgpu.context : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(() => wrapper.unmount()).not.toThrow()
    expect(webgpu.buffer.destroy).toHaveBeenCalledOnce()
    expect(webgpu.context.unconfigure).toHaveBeenCalledTimes(2)
    expect(webgpu.device.destroy).toHaveBeenCalledOnce()
  })

  it('continues WebGPU cleanup when context unconfigure throws', async () => {
    installBrowserBoundaries()
    const webgpu = createWebGpuBoundary({ throwUnconfigure: true })
    setGpu(webgpu.gpu)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgpu' ? webgpu.context : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(() => wrapper.unmount()).not.toThrow()
    expect(webgpu.buffer.destroy).toHaveBeenCalledOnce()
    expect(webgpu.context.unconfigure).toHaveBeenCalledTimes(2)
    expect(webgpu.device.destroy).toHaveBeenCalledOnce()
  })

  it('falls from a WebGPU initialisation error to WebGL2 on a fresh canvas', async () => {
    installBrowserBoundaries()
    const webgpu = createWebGpuBoundary({ failPipeline: true })
    const { gl } = createWebGl2Context()
    setGpu(webgpu.gpu)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      if (kind === 'webgpu') return webgpu.context as never
      if (kind === 'webgl2') return gl as never
      return null
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(wrapper.attributes('data-capability')).toBe('webgl2')
    expect(wrapper.findAll('canvas')).toHaveLength(1)
    expect(gl.drawArrays).toHaveBeenCalled()
    expect(webgpu.device.destroy).toHaveBeenCalledOnce()
    expect(webgpu.context.unconfigure).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('destroys the WebGPU device and retries WebGL2 on a fresh canvas when getContext throws', async () => {
    installBrowserBoundaries()
    const webgpu = createWebGpuBoundary()
    const { gl } = createWebGl2Context()
    setGpu(webgpu.gpu)
    let webgpuCalls = 0
    let failedCanvas: HTMLCanvasElement | null = null
    let fallbackCanvas: HTMLCanvasElement | null = null
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      kind,
    ) {
      if (kind === 'webgpu') {
        webgpuCalls += 1
        if (webgpuCalls === 1) return webgpu.context as never
        failedCanvas = this
        throw new DOMException('Context creation failed', 'InvalidStateError')
      }
      if (kind === 'webgl2') {
        fallbackCanvas = this
        return gl as never
      }
      return null
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(wrapper.attributes('data-capability')).toBe('webgl2')
    expect(gl.drawArrays).toHaveBeenCalled()
    expect(webgpu.device.destroy).toHaveBeenCalledOnce()
    expect(webgpu.context.unconfigure).toHaveBeenCalledOnce()
    expect(fallbackCanvas).not.toBe(failedCanvas)
    wrapper.unmount()
  })

  it('releases a VAO when WebGL buffer allocation fails', async () => {
    installBrowserBoundaries()
    const { gl, loseContext } = createWebGl2Context({ throwBuffer: true })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(wrapper.attributes('data-capability')).toBe('css')
    expect(gl.deleteVertexArray).toHaveBeenCalledOnce()
    expect(gl.deleteBuffer).not.toHaveBeenCalled()
    expect(gl.deleteProgram).toHaveBeenCalledOnce()
    expect(loseContext).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('releases a buffer when WebGL VAO allocation fails', async () => {
    installBrowserBoundaries()
    const { gl, loseContext } = createWebGl2Context({ failVertexArray: true })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(wrapper.attributes('data-capability')).toBe('css')
    expect(gl.deleteBuffer).toHaveBeenCalledOnce()
    expect(gl.deleteVertexArray).not.toHaveBeenCalled()
    expect(gl.deleteProgram).toHaveBeenCalledOnce()
    expect(loseContext).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the CSS fallback usable when every runtime renderer fails', async () => {
    installBrowserBoundaries()
    const webgpu = createWebGpuBoundary({ failPipeline: true })
    const { gl } = createWebGl2Context({ failShader: true })
    setGpu(webgpu.gpu)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      if (kind === 'webgpu') return webgpu.context as never
      if (kind === 'webgl2') return gl as never
      return null
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(wrapper.attributes('data-capability')).toBe('css')
    expect(wrapper.get('.liquid-glass__fallback').attributes('data-active')).toBe('true')
    expect(wrapper.get('canvas').attributes('data-active')).toBe('false')
    wrapper.unmount()
  })

  it('selects the CSS fallback when rendering and renderer disposal both throw', async () => {
    installBrowserBoundaries()
    const { gl } = createWebGl2Context()
    gl.drawArrays.mockImplementation(() => {
      throw new Error('WebGL render failed')
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })
    const dispose = vi.spyOn(WebGlRenderer.prototype, 'dispose').mockImplementation(() => {
      throw new Error('Renderer cleanup failed')
    })
    const errorHandler = vi.fn()

    const wrapper = mount(LiquidGlassCanvas, {
      global: { config: { errorHandler } },
      props: { lowPower: false },
    })
    await flushPromises()

    expect(errorHandler).not.toHaveBeenCalled()
    expect(wrapper.attributes('data-capability')).toBe('css')
    expect(wrapper.get('.liquid-glass__fallback').attributes('data-active')).toBe('true')
    expect(wrapper.get('canvas').attributes('data-active')).toBe('false')
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => wrapper.unmount()).not.toThrow()
  })

  it('finishes component teardown when renderer disposal throws', async () => {
    const { cancelAnimationFrame, media } = installBrowserBoundaries()
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')
    const { gl } = createWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })
    const dispose = vi.spyOn(WebGlRenderer.prototype, 'dispose').mockImplementation(() => {
      throw new Error('Renderer cleanup failed')
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()
    const observer = TestResizeObserver.instances[0]

    expect(() => wrapper.unmount()).not.toThrow()
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('is mounted by the real AppShell before the workspace-owned semantic main', async () => {
    installBrowserBoundaries()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

    const wrapper = mount(AppShell, {
      slots: { default: '<main id="app-content"><aside>Controls</aside></main>' },
    })
    await flushPromises()

    expect(wrapper.findAll('.liquid-glass')).toHaveLength(1)
    expect(wrapper.findAll('header')).toHaveLength(0)
    expect(wrapper.findAll('h1')).toHaveLength(0)
    expect(wrapper.findAll('main')).toHaveLength(1)
    expect(wrapper.findAll('aside')).toHaveLength(1)
    expect(wrapper.get('.liquid-glass').element.compareDocumentPosition(wrapper.get('main').element))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    wrapper.unmount()
  })

  it('stops the live loop in low-power mode and safely restarts it when disabled', async () => {
    const {
      cancelAnimationFrame,
      pendingAnimationFrames,
      requestAnimationFrame,
      runNextFrame,
    } = installBrowserBoundaries()
    const { gl } = createWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => {
      return (kind === 'webgl2' ? gl : null) as never
    })

    const wrapper = mount(LiquidGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(gl.drawArrays).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    expect(pendingAnimationFrames()).toBe(1)

    await wrapper.setProps({ lowPower: true })
    await nextTick()

    expect(cancelAnimationFrame).toHaveBeenCalledOnce()
    expect(gl.drawArrays).toHaveBeenCalledTimes(2)
    expect(pendingAnimationFrames()).toBe(0)
    expect(runNextFrame()).toBe(false)

    await wrapper.setProps({ lowPower: false })
    await nextTick()

    expect(gl.drawArrays).toHaveBeenCalledTimes(3)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
    expect(pendingAnimationFrames()).toBe(1)
    expect(runNextFrame()).toBe(true)
    expect(gl.drawArrays).toHaveBeenCalledTimes(4)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3)
    expect(pendingAnimationFrames()).toBe(1)

    wrapper.unmount()
    expect(pendingAnimationFrames()).toBe(0)
  })
})
