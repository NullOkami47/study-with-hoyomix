import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const upstreamRevision = 'd13c3e53813ebc1d8b52d878071b63212a550ebc'
const adaptedFiles = [
  'src/features/liquid-glass/renderer/MultiPassRenderer.ts',
  'src/features/liquid-glass/renderer/WebGlRenderer.ts',
  'src/features/liquid-glass/renderer/WebGpuRenderer.ts',
  'src/features/liquid-glass/shaders/fullscreen.glsl.ts',
  'src/features/liquid-glass/shaders/studio-vertex.glsl.ts',
  'src/features/liquid-glass/shaders/studio-fragment-bg.glsl.ts',
  'src/features/liquid-glass/shaders/studio-fragment-bg-vblur.glsl.ts',
  'src/features/liquid-glass/shaders/studio-fragment-bg-hblur.glsl.ts',
  'src/features/liquid-glass/shaders/studio-fragment-main.glsl.ts',
  'src/features/liquid-glass/shaders/color-lib.glsl.ts',
  'src/features/liquid-glass/shaders/math-lib.glsl.ts',
  'src/features/liquid-glass/shaders/sdf.glsl.ts',
]

describe('Liquid Glass attribution', () => {
  it('keeps the directory and global notices aligned to the audited upstream revision', () => {
    const featureNotice = readFileSync(resolve(repositoryRoot, 'src/features/liquid-glass/NOTICE.md'), 'utf8')
    const globalNotice = readFileSync(resolve(repositoryRoot, 'docs/THIRD_PARTY_NOTICES.md'), 'utf8')
    for (const notice of [featureNotice, globalNotice]) {
      expect(notice).toContain(upstreamRevision)
      expect(notice).toContain('Copyright (c) 2024 Charles Yin')
    }
    expect(featureNotice).toContain('Every materially adapted renderer or shader source file carries an inline source header')
    expect(globalNotice).toContain('src/shaders/fragment-main.glsl')
    expect(globalNotice).toContain('src/shaders/lib/{color,math,sdf}.glsl')
  })

  it.each(adaptedFiles)('keeps the upstream revision and MIT copyright header in %s', (relativePath) => {
    const content = readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
    expect(content).toContain(upstreamRevision)
    expect(content).toContain('Copyright (c) 2024 Charles Yin')
    expect(content).toContain('MIT licensed; see ../NOTICE.md.')
  })

  it('keeps original integration shaders outside the adapted-file header contract', () => {
    const content = readFileSync(resolve(repositoryRoot, 'src/features/liquid-glass/shaders/liquid-field.glsl.ts'), 'utf8')
    expect(content).toContain('Original single-pass procedural field')
    expect(content).not.toContain(upstreamRevision)
  })
})
