import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectGlassCapability } from './capabilities'

function setGpu(value: unknown): void {
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value,
  })
}

function mockContexts(contexts: Partial<Record<string, unknown>>) {
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId) => {
    return (contexts[contextId] ?? null) as never
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  setGpu(undefined)
})

describe('detectGlassCapability', () => {
  it('prefers WebGPU when navigator.gpu and a usable canvas context are available', () => {
    setGpu({ requestAdapter: vi.fn() })
    const unconfigure = vi.fn()
    const getContext = mockContexts({
      webgpu: { configure: vi.fn(), unconfigure },
      webgl2: {},
    })

    expect(detectGlassCapability()).toBe('webgpu')
    expect(getContext).toHaveBeenCalledWith('webgpu')
    expect(getContext).not.toHaveBeenCalledWith('webgl2')
    expect(unconfigure).toHaveBeenCalledOnce()
  })

  it('keeps WebGPU selected when releasing its probe context throws', () => {
    setGpu({ requestAdapter: vi.fn() })
    const unconfigure = vi.fn(() => {
      throw new Error('Probe cleanup failed')
    })
    mockContexts({ webgpu: { configure: vi.fn(), unconfigure } })

    expect(detectGlassCapability()).toBe('webgpu')
    expect(unconfigure).toHaveBeenCalledOnce()
  })

  it('falls back to WebGL2 when WebGPU has no usable canvas context', () => {
    setGpu({ requestAdapter: vi.fn() })
    mockContexts({ webgl2: {} })

    expect(detectGlassCapability()).toBe('webgl2')
  })

  it('uses WebGL2 when navigator.gpu is unavailable', () => {
    setGpu(undefined)
    const loseContext = vi.fn()
    mockContexts({
      webgl2: { getExtension: vi.fn(() => ({ loseContext })) },
    })

    expect(detectGlassCapability()).toBe('webgl2')
    expect(loseContext).toHaveBeenCalledOnce()
  })

  it('keeps WebGL2 selected when releasing its probe context throws', () => {
    setGpu(undefined)
    const loseContext = vi.fn(() => {
      throw new Error('Probe cleanup failed')
    })
    mockContexts({
      webgl2: { getExtension: vi.fn(() => ({ loseContext })) },
    })

    expect(detectGlassCapability()).toBe('webgl2')
    expect(loseContext).toHaveBeenCalledOnce()
  })

  it('returns CSS when neither GPU context is available', () => {
    setGpu(undefined)
    mockContexts({})

    expect(detectGlassCapability()).toBe('css')
  })

  it('treats context probing errors as unsupported capabilities', () => {
    setGpu({ requestAdapter: vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new DOMException('Blocked by browser policy', 'SecurityError')
    })

    expect(detectGlassCapability()).toBe('css')
  })
})
