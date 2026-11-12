import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Read from disk: Vitest does not process CSS, so a `?raw` import of a stylesheet resolves to ''.
const css = readFileSync(join(process.cwd(), 'src', 'styles', 'glass.css'), 'utf8')

interface Declaration { property: string; value: string; important: boolean }
interface RuleNode { type: 'rule'; selector: string; declarations: Declaration[]; ancestors: string[]; index: number }
interface AtNode { type: 'at'; prelude: string; children: Node[] }
type Node = RuleNode | AtNode

const SCOPE = ':root[data-theme="studio"]'

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseDeclarations(body: string): Declaration[] {
  const declarations: Declaration[] = []
  let depth = 0
  let start = 0
  const parts: string[] = []
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ';' && depth === 0) {
      parts.push(body.slice(start, index))
      start = index + 1
    }
  }
  parts.push(body.slice(start))
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    const property = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    const important = /!important\s*$/.test(value)
    if (important) value = value.replace(/!important\s*$/, '').trim()
    declarations.push({ property, value, important })
  }
  return declarations
}

/** A small brace-matching parser: at-rules with blocks, and style rules with declarations. */
function parse(text: string): { nodes: Node[]; rules: RuleNode[] } {
  const rules: RuleNode[] = []
  let position = 0
  function block(ancestors: string[]): Node[] {
    const nodes: Node[] = []
    while (position < text.length) {
      const close = text.indexOf('}', position)
      const open = text.indexOf('{', position)
      if (close !== -1 && (open === -1 || close < open)) {
        position = close + 1
        return nodes
      }
      if (open === -1) {
        position = text.length
        return nodes
      }
      const prelude = text.slice(position, open).trim()
      position = open + 1
      if (prelude.startsWith('@')) {
        nodes.push({ type: 'at', prelude, children: block([...ancestors, prelude]) })
      } else {
        let depth = 0
        let end = position
        for (; end < text.length; end += 1) {
          if (text[end] === '(') depth += 1
          else if (text[end] === ')') depth -= 1
          else if (text[end] === '}' && depth === 0) break
        }
        const rule: RuleNode = {
          type: 'rule',
          selector: prelude.replace(/\s+/g, ' '),
          declarations: parseDeclarations(text.slice(position, end)),
          ancestors,
          index: rules.length,
        }
        rules.push(rule)
        nodes.push(rule)
        position = end + 1
      }
    }
    return nodes
  }
  const nodes = block([])
  return { nodes, rules }
}

function selectors(selector: string): string[] {
  const list: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      list.push(selector.slice(start, index).trim())
      start = index + 1
    }
  }
  list.push(selector.slice(start).trim())
  return list
}

const source = stripComments(css)
const { rules } = parse(source)
describe('Studio material static invariants', () => {
  it('parses a meaningful material system and scopes every rule to Studio', () => {
    expect(rules.length).toBeGreaterThan(40)
    for (const rule of rules) for (const selector of selectors(rule.selector)) expect(selector.startsWith(SCOPE), selector).toBe(true)
  })
  it('keeps no-backdrop handling compatible with prefixed Safari', () => {
    expect(source).toContain('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))')
    expect(source).not.toMatch(/@supports\s+not\s*\(\s*backdrop-filter/)
  })
  it('has no arbitrary important overrides, GPU substrate, data images or static filter IDs', () => {
    for (const rule of rules) expect(rule.declarations.some(d => d.important), rule.selector).toBe(false)
    expect(source).not.toContain('data-studio-glass-rendered')
    expect(source).not.toContain('url(')
  })
  it('only positions the noninteractive feathered optical centre, never the actual controls', () => {
    const layout = new Set(['position', 'isolation', 'overflow', 'width', 'height', 'border-width', 'border-radius'])
    for (const rule of rules) {
      if (rule.selector === SCOPE + ' [data-studio-glass-ready="true"]::after') {
        expect(rule.declarations).toContainEqual({ property: 'pointer-events', value: 'none', important: false })
        expect(rule.declarations.some(d => d.property === 'mask-image')).toBe(true)
        continue
      }
      for (const d of rule.declarations) expect(layout.has(d.property), rule.selector + d.property).toBe(false)
    }
  })
  it('disables the ready host backdrop instead of filtering both host and overlay', () => {
    const ready = rules.find(r => r.selector === SCOPE + ' [data-studio-glass-ready="true"]')!
    expect(ready.declarations).toContainEqual({ property: 'backdrop-filter', value: 'none', important: false })
    expect(ready.declarations).toContainEqual({ property: 'background', value: 'transparent', important: false })
  })
  it('paints the masked specular rim above the optical child, without catching input', () => {
    const rim = rules.find(r => r.selector === SCOPE + ' [data-studio-glass-ready="true"]::before')!
    expect(rim?.declarations).toContainEqual({ property: 'z-index', value: '0', important: false })
    expect(rim?.declarations).toContainEqual({ property: 'pointer-events', value: 'none', important: false })
  })
  it('does not animate layout or backdrop-filter', () => {
    const forbidden = /^(scale|translate|rotate|transform|clip-path|width|height|inset|margin|padding)(-|$)/
    for (const rule of rules.filter(r => r.ancestors.some(a => a.startsWith('@starting-style')))) {
      for (const d of rule.declarations) expect(d.property).not.toMatch(forbidden)
    }
    for (const rule of rules) for (const d of rule.declarations.filter(d => d.property === 'transition')) expect(d.value).not.toContain('backdrop-filter')
  })
  it('connects blur and gray preferences to actual material declarations', () => {
    expect(source).toContain('var(--studio-blur, 16px)')
    expect(source).toContain('var(--studio-gray, 0.26)')
    expect(source).toContain('--lgm-backdrop: none')
  })
  it('retains separate both-theme accessibility fallbacks', () => {
    const a11y = readFileSync(join(process.cwd(), 'src/styles/glass-accessibility.css'), 'utf8')
    expect(a11y).toContain('[data-theme="cinematic"], [data-theme="studio"]')
    for (const preference of ['prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'forced-colors: active']) expect(a11y).toContain(preference)
    expect(a11y).toContain('backdrop-filter: none !important')
    expect(a11y).toContain('background: Canvas !important')
  })
})
