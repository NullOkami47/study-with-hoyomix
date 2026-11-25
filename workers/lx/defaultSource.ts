import type { LxSourceRecord } from '../../src/features/player/lx/types'

/** Public releases ship no bundled music source. Operators may supply a licensed default. */
export function configuredDefaultSource(): LxSourceRecord | null {
  return null
}
