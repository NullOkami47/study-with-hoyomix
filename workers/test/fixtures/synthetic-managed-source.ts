import { createHash } from 'node:crypto'
import { LX_BUILTIN_ID, type LxSourceRecord } from '../../../src/features/player/lx/types'

const script = `/** @name Synthetic Managed Source */
const API = 'https://api.example.com/synthetic-managed';
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => API);
`
export const syntheticManagedSource: LxSourceRecord = {
  id: LX_BUILTIN_ID, name: 'Synthetic Managed Source', version: '1.0.0',
  originUrl: 'https://example.invalid/synthetic-source.js',
  sha256: createHash('sha256').update(script).digest('hex'), script,
  enabled: true, priority: 10, builtIn: true, importedAt: 0, updatedAt: 0,
}
