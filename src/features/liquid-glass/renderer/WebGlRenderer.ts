/**
 * The compile/link/dispose lifecycle in this single-pass renderer is adapted
 * from liquid-glass-studio src/utils/GLUtils.ts at
 * d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
import { fullscreenVertexShader } from '../shaders/fullscreen.glsl'
import { liquidFieldFragmentShader } from '../shaders/liquid-field.glsl'

import type { GlassRenderer } from './Renderer'

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to create WebGL shader')

  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) ?? 'unknown compile error'
    gl.deleteShader(shader)
    throw new Error(`Unable to compile WebGL shader: ${detail}`)
  }

  return shader
}

export class WebGlRenderer implements GlassRenderer {
  readonly capability = 'webgl2' as const

  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext
  private buffer: WebGLBuffer | null = null
  private program: WebGLProgram | null = null
  private vertexArray: WebGLVertexArrayObject | null = null
  private resolutionLocation: WebGLUniformLocation | null = null
  private timeLocation: WebGLUniformLocation | null = null
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
      stencil: false,
    })
    if (!gl) throw new Error('WebGL2 context is unavailable')

    this.canvas = canvas
    this.gl = gl

    let vertexShader: WebGLShader | null = null
    let fragmentShader: WebGLShader | null = null

    try {
      vertexShader = compileShader(gl, gl.VERTEX_SHADER, fullscreenVertexShader)
      fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, liquidFieldFragmentShader)

      const program = gl.createProgram()
      if (!program) throw new Error('Unable to create WebGL program')
      this.program = program
      gl.attachShader(program, vertexShader)
      gl.attachShader(program, fragmentShader)
      gl.linkProgram(program)

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Unable to link WebGL program: ${gl.getProgramInfoLog(program) ?? 'unknown error'}`)
      }

      this.vertexArray = gl.createVertexArray()
      this.buffer = gl.createBuffer()
      if (!this.vertexArray || !this.buffer) {
        throw new Error('Unable to create WebGL geometry resources')
      }

      gl.bindVertexArray(this.vertexArray)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      )

      const positionLocation = gl.getAttribLocation(program, 'a_position')
      if (positionLocation < 0) throw new Error('WebGL position attribute is unavailable')
      gl.enableVertexAttribArray(positionLocation)
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      gl.bindVertexArray(null)

      this.resolutionLocation = gl.getUniformLocation(program, 'u_resolution')
      this.timeLocation = gl.getUniformLocation(program, 'u_time')
    } catch (error) {
      this.dispose()
      throw error
    } finally {
      if (vertexShader) gl.deleteShader(vertexShader)
      if (fragmentShader) gl.deleteShader(fragmentShader)
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const width = Math.max(1, Math.round(cssWidth * dpr))
    const height = Math.max(1, Math.round(cssHeight * dpr))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    this.gl.viewport(0, 0, width, height)
  }

  render(timestamp: number): void {
    if (this.disposed || !this.program || !this.vertexArray) return

    const gl = this.gl
    gl.useProgram(this.program)
    if (this.resolutionLocation) {
      gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height)
    }
    if (this.timeLocation) gl.uniform1f(this.timeLocation, timestamp / 1000)
    gl.bindVertexArray(this.vertexArray)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const gl = this.gl
    const buffer = this.buffer
    const vertexArray = this.vertexArray
    const program = this.program
    this.buffer = null
    this.vertexArray = null
    this.program = null

    try {
      if (buffer) gl.deleteBuffer(buffer)
    } catch {
      // Continue releasing independently owned resources.
    }
    try {
      if (vertexArray) gl.deleteVertexArray(vertexArray)
    } catch {
      // Continue releasing independently owned resources.
    }
    try {
      if (program) gl.deleteProgram(program)
    } catch {
      // Context loss remains an independent best-effort cleanup step.
    }
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      // Explicit resource deletion above remains the portable cleanup path.
    }
  }
}
