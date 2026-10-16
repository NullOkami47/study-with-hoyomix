import type { LxScriptHeaderMeta } from './types'

export function parseLxScriptHeader(script: string): LxScriptHeaderMeta {
  const meta: LxScriptHeaderMeta = {}
  const headerSlice = script.slice(0, 4096)
  const lines = headerSlice.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    const nameMatch = trimmed.match(/(?:^|\*|\/\/)\s*@name\s*[:\s]\s*([^*]+)/)
    if (nameMatch && !meta.name) {
      meta.name = nameMatch[1].replace(/\*\/$/, '').trim()
    }
    const versionMatch = trimmed.match(/(?:^|\*|\/\/)\s*@version\s*[:\s]\s*([^*]+)/)
    if (versionMatch && !meta.version) {
      meta.version = versionMatch[1].replace(/\*\/$/, '').trim()
    }
    const descMatch = trimmed.match(/(?:^|\*|\/\/)\s*@description\s*[:\s]\s*([^*]+)/)
    if (descMatch && !meta.description) {
      meta.description = descMatch[1].replace(/\*\/$/, '').trim()
    }
  }

  return meta
}
