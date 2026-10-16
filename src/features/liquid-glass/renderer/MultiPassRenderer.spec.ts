import { describe, expect, it, vi } from 'vitest'
import { computeGaussianKernelByRadius, MultiPassRenderer } from './MultiPassRenderer'

function createGl(options: { compileFails?: boolean; framebufferStatus?: number; linkFails?: boolean } = {}) {
  const textures = new Set<object>(); let textureId = 0
  const gl: any = {
    canvas: { width: 4, height: 3 }, ACTIVE_ATTRIBUTES: 1, ACTIVE_UNIFORMS: 2, ARRAY_BUFFER: 3, CLAMP_TO_EDGE: 4,
    COLOR_ATTACHMENT0: 5, COLOR_BUFFER_BIT: 6, COMPILE_STATUS: 7, DEPTH_BUFFER_BIT: 8, FLOAT: 9, FLOAT_VEC2: 10,
    FRAGMENT_SHADER: 11, FRAMEBUFFER: 12, FRAMEBUFFER_COMPLETE: 13, LINEAR: 14, LINK_STATUS: 15, RGBA: 16, RGBA16F: 17,
    SAMPLER_2D: 18, STATIC_DRAW: 19, TEXTURE0: 100, TEXTURE_2D: 20, TEXTURE_MAG_FILTER: 21, TEXTURE_MIN_FILTER: 22,
    TEXTURE_WRAP_S: 23, TEXTURE_WRAP_T: 24, TRIANGLE_STRIP: 25, VERTEX_SHADER: 26,
    activeTexture: vi.fn(), attachShader: vi.fn(), bindBuffer: vi.fn(), bindFramebuffer: vi.fn(), bindTexture: vi.fn(), bindVertexArray: vi.fn(),
    bufferData: vi.fn(), checkFramebufferStatus: vi.fn(() => options.framebufferStatus ?? 13), clear: vi.fn(), clearColor: vi.fn(), compileShader: vi.fn(),
    createBuffer: vi.fn(() => ({})), createFramebuffer: vi.fn(() => ({})), createProgram: vi.fn(() => ({})), createShader: vi.fn(() => ({})),
    createTexture: vi.fn(() => { const texture = { id: ++textureId }; textures.add(texture); return texture }), createVertexArray: vi.fn(() => ({})),
    deleteBuffer: vi.fn(), deleteFramebuffer: vi.fn(), deleteProgram: vi.fn(), deleteShader: vi.fn(), deleteTexture: vi.fn(), deleteVertexArray: vi.fn(),
    drawArrays: vi.fn(), enableVertexAttribArray: vi.fn(), framebufferTexture2D: vi.fn(), getActiveAttrib: vi.fn(() => ({ name: 'a_position', size: 1, type: 10 })),
    getActiveUniform: vi.fn(() => ({ name: 'u_prevPassTexture', size: 1, type: 18 })), getAttachedShaders: vi.fn(() => []), getAttribLocation: vi.fn(() => 0),
    getExtension: vi.fn(() => ({})), getProgramInfoLog: vi.fn(() => 'link failure'),
    getProgramParameter: vi.fn((_: unknown, parameter: number) => parameter === 1 || parameter === 2 ? 1 : parameter === 15 ? !options.linkFails : true),
    getShaderInfoLog: vi.fn(() => 'compile failure'), getShaderParameter: vi.fn(() => !options.compileFails), getUniformLocation: vi.fn(() => ({})),
    isTexture: vi.fn((value: object) => textures.has(value)), linkProgram: vi.fn(), shaderSource: vi.fn(), texImage2D: vi.fn(), texParameteri: vi.fn(),
    uniform1i: vi.fn(), useProgram: vi.fn(), vertexAttribPointer: vi.fn(), viewport: vi.fn(),
  }
  return gl
}
const shader = { vertex: '#version 300 es\nin vec2 a_position;\nvoid main(){gl_Position=vec4(a_position,0.0,1.0);}', fragment: '#version 300 es\nprecision highp float;\nuniform sampler2D u_prevPassTexture;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.0);}' }
const canvas = (gl: any) => ({ width: 4, height: 3, getContext: vi.fn(() => gl) }) as unknown as HTMLCanvasElement

describe('MultiPassRenderer', () => {
  it('normalises Gaussian kernels', () => {
    expect(computeGaussianKernelByRadius(0)).toEqual([1]); const weights = computeGaussianKernelByRadius(3)
    expect(weights.reduce((sum, weight, index) => sum + weight * (index === 0 ? 1 : 2), 0)).toBeCloseTo(1)
  })

  it('binds an upstream framebuffer texture into a downstream sampler and disposes pass resources', () => {
    const gl = createGl(); const renderer = new MultiPassRenderer(canvas(gl), [
      { name: 'source', shader }, { name: 'screen', shader, inputs: { u_prevPassTexture: 'source' }, outputToScreen: true },
    ])
    renderer.render()
    expect(gl.isTexture).toHaveBeenCalled(); expect(gl.activeTexture).toHaveBeenCalledWith(gl.TEXTURE0); expect(gl.uniform1i).toHaveBeenCalledWith(expect.anything(), 0)
    renderer.dispose(); expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1); expect(gl.deleteTexture).toHaveBeenCalledTimes(1); expect(gl.deleteBuffer).toHaveBeenCalledTimes(2)
  })

  it('cleans up the program and compiled shader when shader compilation fails', () => {
    const gl = createGl({ compileFails: true })
    expect(() => new MultiPassRenderer(canvas(gl), [{ name: 'screen', shader, outputToScreen: true }])).toThrow('Shader compile error: compile failure')
    expect(gl.deleteShader).toHaveBeenCalledTimes(1); expect(gl.deleteProgram).toHaveBeenCalledTimes(1)
  })

  it('cleans up both shaders and the program when linking fails', () => {
    const gl = createGl({ linkFails: true })
    expect(() => new MultiPassRenderer(canvas(gl), [{ name: 'screen', shader, outputToScreen: true }])).toThrow('Program link error: link failure')
    expect(gl.deleteShader).toHaveBeenCalledTimes(2); expect(gl.deleteProgram).toHaveBeenCalledTimes(1)
  })

  it('cleans up partial framebuffer resources when framebuffer construction fails', () => {
    const gl = createGl({ framebufferStatus: 999 })

    expect(() => new MultiPassRenderer(canvas(gl), [{ name: 'offscreen', shader }])).toThrow('Framebuffer incomplete: 999')

    expect(gl.deleteTexture).toHaveBeenCalledTimes(1)
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1)
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1)
    expect(gl.bindFramebuffer).toHaveBeenLastCalledWith(gl.FRAMEBUFFER, null)
    expect(gl.bindTexture).toHaveBeenLastCalledWith(gl.TEXTURE_2D, null)
  })

  it('disposes completed passes when a later pass fails to initialise', () => {
    const gl = createGl()
    let programCount = 0
    gl.getProgramParameter.mockImplementation((_: unknown, parameter: number) => {
      if (parameter === gl.LINK_STATUS) return ++programCount < 2
      if (parameter === gl.ACTIVE_ATTRIBUTES || parameter === gl.ACTIVE_UNIFORMS) return 1
      return true
    })

    expect(() => new MultiPassRenderer(canvas(gl), [
      { name: 'offscreen', shader },
      { name: 'broken', shader, outputToScreen: true },
    ])).toThrow('Program link error: link failure')

    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1)
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1)
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2)
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1)
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1)
  })

  it('preserves allocated pass storage when the normalised dimensions are unchanged', () => {
    const gl = createGl()
    const renderer = new MultiPassRenderer(canvas(gl), [{ name: 'offscreen', shader }])
    const allocated = gl.texImage2D.mock.calls.length
    renderer.resize(4, 3)
    renderer.resize(4.9, 3.7)
    expect(gl.texImage2D).toHaveBeenCalledTimes(allocated)
    renderer.resize(8, 6)
    expect(gl.texImage2D).toHaveBeenCalledTimes(allocated + 1)
    renderer.resize(8, 6)
    expect(gl.texImage2D).toHaveBeenCalledTimes(allocated + 1)
    renderer.dispose()
  })

  it('reallocates framebuffer texture storage on resize', () => {
    const gl = createGl()
    const renderer = new MultiPassRenderer(canvas(gl), [
      { name: 'offscreen', shader },
      { name: 'screen', shader, inputs: { u_prevPassTexture: 'offscreen' }, outputToScreen: true },
    ])

    renderer.resize(8.9, 6.2)

    expect(gl.texImage2D).toHaveBeenLastCalledWith(gl.TEXTURE_2D, 0, gl.RGBA16F, 8, 6, 0, gl.RGBA, gl.FLOAT, null)
    renderer.dispose()
  })

  it('disposes idempotently and rejects rendering after disposal', () => {
    const gl = createGl()
    const renderer = new MultiPassRenderer(canvas(gl), [{ name: 'offscreen', shader }])

    renderer.dispose()
    renderer.dispose()

    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1)
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1)
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1)
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1)
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1)
    expect(() => renderer.render()).toThrow('Renderer has been disposed')
  })
})
