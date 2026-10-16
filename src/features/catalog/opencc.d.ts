/** Node moduleResolution cannot follow the package's conditional ESM exports.
 * Re-export the upstream types; only dictionary subpaths lack declarations. */
declare module 'opencc-js/core' {
  export { ConverterFactory } from 'opencc-js'
}
declare module 'opencc-js/from/cn' { const dictionaries: readonly import('opencc-js').DictGroup[]; export default dictionaries }
declare module 'opencc-js/from/hk' { const dictionaries: readonly import('opencc-js').DictGroup[]; export default dictionaries }
declare module 'opencc-js/to/cn' { const dictionaries: readonly import('opencc-js').DictGroup[]; export default dictionaries }
declare module 'opencc-js/to/hk' { const dictionaries: readonly import('opencc-js').DictGroup[]; export default dictionaries }
