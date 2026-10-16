/**
 * Multipass WebGL2 renderer adapted from liquid-glass-studio's GLUtils.ts
 * at d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
type GL = WebGL2RenderingContext
interface ShaderSource { vertex: string; fragment: string }
interface RenderPassConfig { name: string; shader: ShaderSource; inputs?: Record<string, string>; outputToScreen?: boolean }
interface UniformInfo { location: WebGLUniformLocation; type: number; isArray: false | { size: number } }
interface AttributeInfo { location: number; size: number; type: number }

export class ShaderProgram {
  private uniforms = new Map<string, UniformInfo>(); private attributes = new Map<string, AttributeInfo>()
  private program: WebGLProgram
  constructor(private gl: GL, source: ShaderSource) { this.program = this.createProgram(source); this.detectAttributes(); this.detectUniforms() }
  private createShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type); if (!shader) throw new Error('Failed to create shader')
    this.gl.shaderSource(shader, source); this.gl.compileShader(shader)
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) { const info = this.gl.getShaderInfoLog(shader) ?? 'unknown'; this.gl.deleteShader(shader); throw new Error('Shader compile error: ' + info) }
    return shader
  }
  private createProgram(source: ShaderSource): WebGLProgram {
    const gl = this.gl; const program = gl.createProgram(); if (!program) throw new Error('Failed to create program')
    let vertexShader: WebGLShader | null = null; let fragmentShader: WebGLShader | null = null
    try {
      vertexShader = this.createShader(gl.VERTEX_SHADER, source.vertex); fragmentShader = this.createShader(gl.FRAGMENT_SHADER, source.fragment)
      gl.attachShader(program, vertexShader); gl.attachShader(program, fragmentShader); gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program link error: ' + (gl.getProgramInfoLog(program) ?? 'unknown'))
      return program
    } catch (error) { gl.deleteProgram(program); throw error }
    finally { if (vertexShader) gl.deleteShader(vertexShader); if (fragmentShader) gl.deleteShader(fragmentShader) }
  }
  private detectAttributes(): void {
    const n = this.gl.getProgramParameter(this.program, this.gl.ACTIVE_ATTRIBUTES) as number
    for (let i = 0; i < n; i++) { const info = this.gl.getActiveAttrib(this.program, i); if (!info) continue; this.attributes.set(info.name, { location: this.gl.getAttribLocation(this.program, info.name), size: info.size, type: info.type }) }
  }
  private detectUniforms(): void {
    const n = this.gl.getProgramParameter(this.program, this.gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < n; i++) { const info = this.gl.getActiveUniform(this.program, i); if (!info) continue; const location = this.gl.getUniformLocation(this.program, info.name); if (!location) continue
      const baseName = info.name.replace(/\[\d+\]$/, ''); this.uniforms.set(baseName, { location, type: info.type, isArray: baseName !== info.name ? { size: info.size } : false }) }
  }
  use(): void { this.gl.useProgram(this.program) }
  setUniform(name: string, value: unknown): void {
    const gl = this.gl; const info = this.uniforms.get(name); if (!info) return
    if (info.isArray && (Array.isArray(value) || value instanceof Float32Array)) {
      const floats = value as Float32List
      switch (info.type) { case gl.FLOAT: gl.uniform1fv(info.location, floats); break; case gl.FLOAT_VEC2: gl.uniform2fv(info.location, floats); break; case gl.FLOAT_VEC3: gl.uniform3fv(info.location, floats); break; case gl.FLOAT_VEC4: gl.uniform4fv(info.location, floats); break }
      return
    }
    switch (info.type) {
      case gl.FLOAT: gl.uniform1f(info.location, value as number); break
      case gl.FLOAT_VEC2: gl.uniform2fv(info.location, value as Float32List); break
      case gl.FLOAT_VEC3: gl.uniform3fv(info.location, value as Float32List); break
      case gl.FLOAT_VEC4: gl.uniform4fv(info.location, value as Float32List); break
      case gl.INT: case gl.SAMPLER_2D: gl.uniform1i(info.location, value as number); break
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(info.location, false, value as Float32List); break
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(info.location, false, value as Float32List); break
    }
  }
  getAttributeLocation(name: string): number { return this.attributes.get(name)?.location ?? -1 }
  dispose(): void { this.gl.deleteProgram(this.program); this.uniforms.clear(); this.attributes.clear() }
}

export class FrameBuffer {
  private fbo: WebGLFramebuffer; private texture: WebGLTexture
  constructor(private gl: GL, private _width: number, private _height: number) {
    const fbo = gl.createFramebuffer(); if (!fbo) throw new Error('Failed to create framebuffer')
    let texture: WebGLTexture | null = null
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); texture = gl.createTexture(); if (!texture) throw new Error('Failed to create texture')
      gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, _width, _height, 0, gl.RGBA, gl.FLOAT, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER); if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: ' + status)
      this.fbo = fbo; this.texture = texture
    } catch (error) { if (texture) gl.deleteTexture(texture); gl.deleteFramebuffer(fbo); throw error }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindTexture(gl.TEXTURE_2D, null) }
  }
  bind(): void { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo) }
  unbind(): void { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null) }
  getTexture(): WebGLTexture { return this.texture }
  get width(): number { return this._width } get height(): number { return this._height }
  resize(width: number, height: number): void {
    // Reallocating equal dimensions clears the existing pass pixels without resizing.
    if (width === this._width && height === this._height) return
    this._width = width; this._height = height
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }
  dispose(): void { this.gl.deleteFramebuffer(this.fbo); this.gl.deleteTexture(this.texture) }
}

export class RenderPass {
  private program: ShaderProgram; private frameBuffer: FrameBuffer | null; private vao: WebGLVertexArrayObject; private buffer: WebGLBuffer
  public config: RenderPassConfig
  constructor(private gl: GL, shaderSource: ShaderSource, outputToScreen = false) {
    this.config = { name: '', shader: shaderSource, outputToScreen }; this.program = new ShaderProgram(gl, shaderSource)
    try { this.frameBuffer = !outputToScreen ? new FrameBuffer(gl, gl.canvas.width, gl.canvas.height) : null; const resources = this.createVAO(); this.vao = resources.vao; this.buffer = resources.buffer }
    catch (error) { this.program.dispose(); throw error }
  }
  private createVAO(): { vao: WebGLVertexArrayObject; buffer: WebGLBuffer } {
    const gl = this.gl; const vao = gl.createVertexArray(); if (!vao) throw new Error('Failed to create VAO'); gl.bindVertexArray(vao)
    const buffer = gl.createBuffer(); if (!buffer) { gl.deleteVertexArray(vao); throw new Error('Failed to create buffer') }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const location = this.program.getAttributeLocation('a_position'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null); return { vao, buffer }
  }
  setConfig(config: RenderPassConfig): void { this.config = config }
  render(uniforms?: Record<string, unknown>): void {
    const gl = this.gl; if (this.frameBuffer) this.frameBuffer.bind(); else gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.frameBuffer ? this.frameBuffer.width : (gl.canvas as HTMLCanvasElement).width, this.frameBuffer ? this.frameBuffer.height : (gl.canvas as HTMLCanvasElement).height)
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); this.program.use()
    let textureUnit = 0
    for (const [name, value] of Object.entries(uniforms ?? {})) {
      if (isTextureUniform(gl, value)) { gl.activeTexture(gl.TEXTURE0 + textureUnit); gl.bindTexture(gl.TEXTURE_2D, value); this.program.setUniform(name, textureUnit++) }
      else this.program.setUniform(name, value)
    }
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.bindVertexArray(null); if (this.frameBuffer) this.frameBuffer.unbind()
  }
  getOutputTexture(): WebGLTexture | null { return this.frameBuffer?.getTexture() ?? null }
  resize(width: number, height: number): void { this.frameBuffer?.resize(width, height) }
  dispose(): void { this.frameBuffer?.dispose(); this.program.dispose(); this.gl.deleteVertexArray(this.vao); this.gl.deleteBuffer(this.buffer) }
}

function isTextureUniform(gl: GL, value: unknown): value is WebGLTexture {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) return false
  try { return gl.isTexture(value as WebGLTexture) } catch { return typeof WebGLTexture !== 'undefined' && value instanceof WebGLTexture }
}

export class MultiPassRenderer {
  private gl: GL; private passes = new Map<string, RenderPass>(); private passesArray: RenderPass[] = []; private globalUniforms: Record<string, unknown> = {}; private disposed = false
  constructor(canvas: HTMLCanvasElement, configs: RenderPassConfig[]) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, powerPreference: 'low-power', preserveDrawingBuffer: false, stencil: false })
    if (!gl) throw new Error('WebGL2 not supported'); if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float not supported'); this.gl = gl
    try { for (const cfg of configs) { if (this.passes.has(cfg.name)) throw new Error(`Duplicate render pass: ${cfg.name}`); const pass = new RenderPass(gl, cfg.shader, cfg.outputToScreen); pass.setConfig(cfg); this.passes.set(cfg.name, pass); this.passesArray.push(pass) } }
    catch (error) { this.passesArray.forEach((pass) => pass.dispose()); this.passes.clear(); this.passesArray = []; throw error }
  }
  resize(width: number, height: number): void { if (this.disposed) return; const w = Math.max(1, Math.floor(width)); const h = Math.max(1, Math.floor(height)); this.passesArray.forEach((pass) => pass.resize(w, h)) }
  setUniform(name: string, value: unknown): void { if (!this.disposed) this.globalUniforms[name] = value }
  setUniforms(uniforms: Record<string, unknown>): void { if (!this.disposed) Object.assign(this.globalUniforms, uniforms) }
  getGL(): GL | null { return this.disposed ? null : this.gl }
  render(passUniforms?: Record<string, Record<string, unknown>>[]): void {
    if (this.disposed) throw new Error('Renderer has been disposed')
    this.passesArray.forEach((pass, index) => { const uniforms: Record<string, unknown> = { ...this.globalUniforms, ...(passUniforms?.[index] ?? {}) }
      for (const [uniformName, fromPassName] of Object.entries(pass.config.inputs ?? {})) { const fromPass = this.passes.get(fromPassName); if (fromPass) uniforms[uniformName] = fromPass.getOutputTexture() }
      pass.render(uniforms) })
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.passesArray.forEach((pass) => pass.dispose()); this.passes.clear(); this.passesArray = []; this.globalUniforms = {}; this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null); this.gl.bindTexture(this.gl.TEXTURE_2D, null) }
}

export function computeGaussianKernelByRadius(radius: number): number[] {
  const safeRadius = Math.max(0, Math.floor(radius)); if (safeRadius === 0) return [1]; const sigma = safeRadius / 3; const weights: number[] = []; let sum = 0
  for (let i = 0; i <= safeRadius; i++) { const weight = Math.exp(-(i * i) / (2 * sigma * sigma)); weights.push(weight); sum += weight * (i === 0 ? 1 : 2) }
  return weights.map((weight) => weight / sum)
}
