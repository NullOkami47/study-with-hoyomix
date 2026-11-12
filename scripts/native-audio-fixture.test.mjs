import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { silentWav, nativeAudioMiddleware, nativeAudioUrl } from './native-audio-fixture.mjs'

test('deterministic original PCM fixture travels through real HTTP with byte ranges', async () => {
  const middleware = nativeAudioMiddleware()
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const body = silentWav(180)
    assert.equal(body.length, 2_880_044)
    assert.equal(body.readUInt32LE(24), 8000)
    assert.equal(body.readUInt32LE(40) / body.readUInt32LE(28), 180)
    assert.deepEqual(body, silentWav(180))
    const url = origin + nativeAudioUrl(180)
    assert.equal(new URL(url).pathname.split('/').at(-1).length, 32)
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'audio/wav')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body)
    for (const [range, start, end] of [['bytes=0-43', 0, 43], ['bytes=100-', 100, body.length - 1], ['bytes=-20', body.length - 20, body.length - 1], ['bytes=20-9999999', 20, body.length - 1]]) {
      const part = await fetch(url, { headers: { range } })
      assert.equal(part.status, 206)
      assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/${body.length}`)
      assert.equal(Number(part.headers.get('content-length')), end - start + 1)
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), body.subarray(start, end + 1))
    }
    for (const range of ['bytes=9999999-', 'bytes=5-2', 'bytes=-0', 'bytes=0-2,4-6', 'nonsense']) {
      const response = await fetch(url, { headers: { range } })
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('content-range'), `bytes */${body.length}`)
    }
    assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), String(body.length))
    assert.equal((await fetch(origin + '/api/providers/jellyfin/media/real/real-ticket')).status, 404)
    assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

async function nativeAudioOrigin(t) {
  const middleware = nativeAudioMiddleware()
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('not a fixture') }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return `http://127.0.0.1:${server.address().port}`
}

test('native audio URL builder defaults to the registered GD Studio provider', () => {
  assert.equal(nativeAudioUrl(), '/api/providers/gd-studio/media/netease%3A1001%3A320/fixture000010abcdefghijklmnopqrs')
  assert.equal(nativeAudioUrl(180, 'netease:1002:320'), '/api/providers/gd-studio/media/netease%3A1002%3A320/fixture000180abcdefghijklmnopqrs')
  assert.equal(nativeAudioUrl(180, 'netease:1002:320', 'gd-studio'), '/api/providers/gd-studio/media/netease%3A1002%3A320/fixture000180abcdefghijklmnopqrs')
  assert.equal(nativeAudioUrl(180, 'netease:1002:320', undefined), '/api/providers/gd-studio/media/netease%3A1002%3A320/fixture000180abcdefghijklmnopqrs')
})

test('GD Studio fixture URLs encode external ids for production proxy validation', () => {
  assert.equal(nativeAudioUrl(180, 'netease:1001:320', 'gd-studio'), '/api/providers/gd-studio/media/netease%3A1001%3A320/fixture000180abcdefghijklmnopqrs')
  assert.equal(nativeAudioUrl(undefined, undefined, 'gd-studio'), '/api/providers/gd-studio/media/netease%3A1001%3A320/fixture000010abcdefghijklmnopqrs')
})

test('native audio URL builder rejects unsupported providers', () => {
  for (const provider of ['jellyfin', 'chksz', 'GD-STUDIO', 'gd-studio/media', '', null, 0]) {
    assert.throws(() => nativeAudioUrl(180, 'netease:1001:320', provider), TypeError, `provider ${String(provider)}`)
  }
})

for (const [provider, path] of [
  ['gd-studio', '/api/providers/gd-studio/media/netease%3A1001%3A320/fixture000180abcdefghijklmnopqrs'],
]) {
  test(`${provider} fixture serves original PCM with real HTTP GET, HEAD and byte ranges`, async (t) => {
    const origin = await nativeAudioOrigin(t)
    const url = origin + path
    const body = silentWav(180)
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(url, { method })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'audio/wav')
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('content-length'), '2880044')
      assert.equal(response.headers.get('content-range'), null)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.deepEqual(bytes, method === 'HEAD' ? Buffer.alloc(0) : body)
      if (method === 'GET') {
        assert.equal(createHash('sha256').update(bytes).digest('hex'), '1325721de4cfd86d3952320054dac50d25b45d79789e53a89d563dc4d676e210')
      }
      for (const [range, start, end] of [
        ['bytes=0-43', 0, 43],
        ['bytes=100-', 100, 2_880_043],
        ['bytes=-20', 2_880_024, 2_880_043],
        ['bytes=20-9999999', 20, 2_880_043],
        ['bytes=2880043-', 2_880_043, 2_880_043],
      ]) {
        const part = await fetch(url, { method, headers: { range } })
        assert.equal(part.status, 206, `${method} ${range}`)
        assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/2880044`)
        assert.equal(Number(part.headers.get('content-length')), end - start + 1)
        assert.deepEqual(Buffer.from(await part.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : body.subarray(start, end + 1))
      }
      for (const range of ['bytes=9999999-', 'bytes=5-2', 'bytes=-0', 'bytes=0-2,4-6', 'bytes=-', 'bytes=9007199254740992-', 'nonsense']) {
        const invalid = await fetch(url, { method, headers: { range } })
        assert.equal(invalid.status, 416, `${method} ${range}`)
        assert.equal(invalid.headers.get('content-range'), 'bytes */2880044')
        assert.equal((await invalid.arrayBuffer()).byteLength, 0)
      }
    }
    assert.equal((await fetch(url, { method: 'POST' })).status, 405)
    for (const duration of ['000000', '000181']) {
      const invalid = await fetch(origin + path.replace('000180', duration))
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.arrayBuffer()).byteLength, 0)
    }
  })
}

test('retired Jellyfin fixture tickets never receive a successful media response', async (t) => {
  const origin = await nativeAudioOrigin(t)
  const url = origin + '/api/providers/jellyfin/media/JF_track-001/fixture000180abcdefghijklmnopqrs'
  for (const method of ['GET', 'HEAD']) {
    for (const headers of [{}, { range: 'bytes=0-43' }]) {
      const response = await fetch(url, { method, headers })
      assert.equal(response.status, 404)
      assert.equal(response.headers.get('content-type'), null)
      assert.equal(response.headers.get('accept-ranges'), null)
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'not a fixture')
    }
  }
})

test('nonfixture media paths and unknown providers fall through the native middleware', async (t) => {
  const origin = await nativeAudioOrigin(t)
  const ticket = 'fixture000180abcdefghijklmnopqrs'
  for (const path of [
    '/api/providers/jellyfin/media/real/real-ticket',
    '/api/providers/gd-studio/media/netease%3A1001%3A320/real-ticket',
    '/api/providers/gd-studio/media/netease%3A1001%3A320/0123456789abcdefghijklmnopqrstuv',
    `/api/providers/chksz/media/abcdefghijk/${ticket}`,
    `/api/providers/jellyfin/media/netease%3A1001%3A320/${ticket}`,
    `/api/providers/gd-studio/media/netease:1001:320/${ticket}`,
    `/api/providers/gd-studio/media/netease%3a1001%3a320/${ticket}`,
    `/api/providers/gd-studio/media/netease%3G1001/${ticket}`,
    `/api/providers/gd-studio/media/netease%1001/${ticket}`,
    `/api/providers/gd-studio/media/netease%2F1001%2F320/${ticket}`,
    `/api/providers/gd-studio/media/netease/1001/320/${ticket}`,
    `/api/providers/gd-studio/media//${ticket}`,
    `/api/providers/gd-studio/media/netease%3A1001%3A320/${ticket}/extra`,
    `/api/providers/gd-studio/media/netease%3A1001%3A320/${ticket}extra`,
    '/api/providers/gd-studio/media/netease%3A1001%3A320/fixture180abcdefghijklmnopqrs',
  ]) {
    const response = await fetch(origin + path)
    assert.equal(response.status, 404, path)
    assert.equal(response.headers.get('content-type'), null, path)
    assert.equal(response.headers.get('accept-ranges'), null, path)
    assert.equal(await response.text(), 'not a fixture', path)
  }
})
