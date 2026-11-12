/** Test-only PCM16 mono silence. Byte-identical to the original 8 kHz fixture.
 * No recording, encoder dependency, random input or external media service.
 * Windows WebKit's native media loader needs an actual HTTP response: Playwright
 * route fulfilment is not a reliable media transport on that port.
 */
export function silentWav(seconds = 10) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180) throw new RangeError('Fixture duration must be 1–180 seconds')
  const sampleRate = 8000
  const dataSize = sampleRate * seconds * 2
  const value = Buffer.alloc(44 + dataSize)
  value.write('RIFF', 0)
  value.writeUInt32LE(36 + dataSize, 4)
  value.write('WAVE', 8)
  value.write('fmt ', 12)
  value.writeUInt32LE(16, 16)
  value.writeUInt16LE(1, 20)
  value.writeUInt16LE(1, 22)
  value.writeUInt32LE(sampleRate, 24)
  value.writeUInt32LE(sampleRate * 2, 28)
  value.writeUInt16LE(2, 32)
  value.writeUInt16LE(16, 34)
  value.write('data', 36)
  value.writeUInt32LE(dataSize, 40)
  return value
}

export const nativeAudioUrl = (seconds = 10, externalId = 'netease:1001:320', provider = 'gd-studio') => {
  if (provider !== 'gd-studio') throw new TypeError('Unsupported native audio fixture provider')
  return `/api/providers/${provider}/media/${encodeURIComponent(externalId)}/fixture${String(seconds).padStart(6, '0')}abcdefghijklmnopqrs`
}

export function nativeAudioMiddleware() {
  return (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/__native-audio-probe') {
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><title>Native audio fixture probe</title><audio controls></audio><button onclick="document.querySelector(\'audio\').play()">Play</button>')
      return
    }
    const match = /^\/api\/providers\/gd-studio\/media\/[A-Za-z0-9_-]+(?:%3A[A-Za-z0-9_-]+)*\/fixture(\d{6})abcdefghijklmnopqrs$/.exec(url.pathname)
    if (!match) return next()
    const seconds = Number(match[1])
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180) { res.statusCode = 400; res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return }
    const body = silentWav(seconds)
    const size = body.length
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'no-store')
    let start = 0
    let end = size - 1
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
      }
      if (!range || !(range[1] || range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end || (!range[1] && Number(range[2]) === 0)) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${size}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    res.setHeader('Content-Length', end - start + 1)
    res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1))
  }
}

/** Only supplied by the local browser test runner; never part of the shipped app. */
export const nativeAudioFixturePlugin = () => ({
  name: 'native-audio-fixture',
  configurePreviewServer(server) { server.middlewares.use(nativeAudioMiddleware()) },
})
