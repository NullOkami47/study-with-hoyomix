import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('Studio optical ownership', () => {
  it('does not mount independent full-screen or dialog WebGL compositors', () => {
    for (const file of ['StudyWorkspace', 'OverlaySheet']) {
      expect(source(`src/features/workspace/${file}.vue`)).not.toContain('StudioGlassCanvas')
    }
  })

  it('keeps the legacy Studio important substrate out of the shared token cascade', () => {
    const tokens = source('src/styles/tokens.css')
    expect(tokens).not.toContain('[data-studio-glass-rendered="true"]')
    expect(tokens).not.toContain('var(--studio-glass-blur, 20px)')
  })

  it('does not mount Studio optics in the Cinematic branch', () => {
    const shell = source('src/components/shell/AppShell.vue')
    expect(shell).toContain('<LiquidGlassCanvas v-if="visualStyle === \'cinematic\'"')
    expect(shell).toContain('<StudioGlassEnvironment v-else-if="visualStyle === \'studio\'"')
  })
})
