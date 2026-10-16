import { ConverterFactory } from 'opencc-js/core'
import fromChinese from 'opencc-js/from/cn'
import fromHongKong from 'opencc-js/from/hk'
import toChinese from 'opencc-js/to/cn'
import toHongKong from 'opencc-js/to/hk'

// Phrase dictionaries precede character dictionaries. HK forms, without the
// hkp regional vocabulary rewrite, suit the app's general Traditional UI.
export const toTraditional = ConverterFactory(fromChinese, toHongKong)
export const toSimplified = ConverterFactory(fromHongKong, toChinese)
