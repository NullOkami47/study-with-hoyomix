// Tests a candidate LX script in the browser's QuickJS Web Worker.
//
// This is how an Owner finds out whether a script works *before* publishing it, and how the
// "last verification result" in the Admin console is produced. The script is executed only inside
// the worker sandbox — never in the page, never on the server — so a hostile script cannot reach
// the DOM, storage or the page's own origin.

import { LxRuntimeClient } from './runtime/client'

export interface LxScriptProbeResult {
  ok: boolean
  /** The platform identifiers the script announced, e.g. `wy`, `kg`, `tx`. */
  platforms: string[]
  /** The qualities the script announced per platform. */
  qualities: string[]
  /** The script's declared name and version, when its header carries them. */
  name: string | null
  version: string | null
  /** A short, human-readable reason when the probe failed. */
  error: string | null
}

interface InitedMeta {
  sources?: Record<string, { name?: string; qualitys?: string[]; qualities?: string[] }>
}

export async function probeLxScript(
  script: string,
  clientFactory: () => LxRuntimeClient = () => new LxRuntimeClient(),
): Promise<LxScriptProbeResult> {
  const client = clientFactory()
  try {
    const loaded = await client.loadSource(script)
    const meta = (loaded.initedMeta ?? null) as InitedMeta | null
    const sources = meta?.sources ?? null

    if (!sources || Object.keys(sources).length === 0) {
      return {
        ok: false,
        platforms: [],
        qualities: [],
        name: null,
        version: null,
        error: 'The script announced no platforms. It may not be an LX source, or it may still be waiting for a bootstrap request.',
      }
    }

    const platforms = Object.keys(sources)
    const qualities = [...new Set(platforms.flatMap((id) => sources[id]?.qualitys ?? sources[id]?.qualities ?? []))]

    // A script that announces platforms but cannot answer a request is not usable.
    try {
      await client.callMusicUrl('wy', { id: '0', songmid: '0', name: 'probe', singer: 'probe' }, '128k')
    } catch (error: unknown) {
      return {
        ok: false,
        platforms,
        qualities,
        name: null,
        version: null,
        error: `The script loaded but could not answer a test request: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    return { ok: true, platforms, qualities, name: null, version: null, error: null }
  } catch (error: unknown) {
    return {
      ok: false,
      platforms: [],
      qualities: [],
      name: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await client.dispose().catch(() => undefined)
  }
}
