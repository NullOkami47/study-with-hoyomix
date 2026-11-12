// Bounded native tests: no package install, browser, server, or filesystem writes.
// Run from the project root with Node 22.18 or newer:
// node --experimental-vm-modules --test --test-concurrency=1 src/features/player/lx/globalSourceRepository.native-tests.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, webcrypto } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, SourceTextModule } from 'node:vm'

// Keep the repository, its CSP adapter, and the shared CSP/hostname checks real.
// Only network responses are replaced. Native TS transformation stays in memory.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const context = createContext({
  URL, Request, Response, TextEncoder, TextDecoder, crypto: webcrypto,
  fetch: async () => { throw new Error('Unexpected real network request') },
})
const modules = new Map()
async function moduleFor(file) {
  assert.ok(file.startsWith(sourceRoot + sep), 'Only local src modules may be loaded')
  if (modules.has(file)) return modules.get(file)
  const code = stripTypeScriptTypes(await readFile(file, 'utf8'), { mode: 'transform' })
  const module = new SourceTextModule(code, { context, identifier: file })
  modules.set(file, module)
  return module
}
const module = await moduleFor(resolve(dirname(fileURLToPath(import.meta.url)), 'globalSourceRepository.ts'))
await module.link((specifier, parent) => {
  assert.ok(specifier.startsWith('.'), 'No package or network imports')
  const file = resolve(dirname(parent.identifier), specifier)
  return moduleFor(file.endsWith('.ts') ? file : file + '.ts')
})
await module.evaluate()
const { createGlobalLxSourceRepository } = module.namespace

const scriptA = 'globalThis.syntheticLxSource = "first"'
const scriptB = 'globalThis.syntheticLxSource = "replacement"'
const shaA = createHash('sha256').update(scriptA).digest('hex')
const shaB = createHash('sha256').update(scriptB).digest('hex')
const managedId = 'builtin-kulao-svip'
const ids = records => Array.from(records, record => record.id)
function published(id, extra = {}) {
  return { id, name: 'Synthetic source', version: null, sha256: shaA, priority: 10, requiredOrigins: [], ...extra }
}
function managed(extra = {}) {
  return published(managedId, { enabled: true, status: 'active', ...extra })
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture(publication) {
  const state = {
    publication, bodies: new Map([[shaA, scriptA], [shaB, scriptB]]),
    bodyRequests: [], listError: false, bodyResponse: undefined,
  }
  const repository = createGlobalLxSourceRepository({
    now: () => 1000,
    selfOrigin: 'https://study.example',
    cspSources: { connect: ["'self'", 'https://allowed.example'], media: ["'self'"] },
    fetch: async input => {
      const url = new URL(String(input), 'https://study.example')
      assert.equal(url.origin, 'https://study.example')
      if (url.pathname === '/api/lx/sources') {
        if (state.listError) throw new Error('Synthetic registry outage')
        return Response.json(state.publication)
      }
      assert.match(url.pathname, /^\/api\/lx\/sources\/[^/]+\/script$/)
      state.bodyRequests.push(url.pathname)
      if (state.bodyResponse) return state.bodyResponse(url)
      const script = state.bodies.get(url.searchParams.get('sha256'))
      return new Response(script ?? 'missing', { status: script === undefined ? 404 : 200 })
    },
  })
  return { state, repository }
}

for (const [name, policy] of [
  ['disabled', managed({ enabled: false, status: 'disabled' })],
  ['deleted', managed({ enabled: false, status: 'disabled', deleted: true, sha256: '0'.repeat(64) })],
  ['pending network approval', managed({ status: 'pending_network_approval' })],
  ['failed', managed({ status: 'failed' })],
]) {
  test('same-revision ' + name + ' revokes the managed source but preserves ordinary sources', async () => {
    const { state, repository } = fixture({ revision: 5, sources: [published('ordinary')], managedSource: managed() })
    assert.deepEqual(ids(await repository.list()), ['global:builtin-kulao-svip', 'global:ordinary'])
    state.publication = { revision: 5, sources: [published('ordinary')], managedSource: policy }
    assert.deepEqual(ids(await repository.list()), ['global:ordinary'])
    assert.deepEqual(ids(await repository.list()), ['global:ordinary'])
    assert.equal(repository.managedSource().enabled, policy.enabled)
    assert.equal(repository.managedSource().status, policy.status)
    assert.equal(state.bodyRequests.length, 1, 'Verified bytes may remain cached without retaining grants')
  })
}

test('same-revision omission of the managed policy removes its previous authorisation', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  assert.equal((await repository.list()).length, 1)
  state.publication = { revision: 5, sources: [] }
  assert.deepEqual(ids(await repository.list()), [])
  assert.equal(repository.managedSource(), undefined)
})

test('same-revision origin changes reapply the real CSP check before reusing verified bytes', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed({ requiredOrigins: ['https://allowed.example'] }) })
  assert.equal((await repository.list()).length, 1)
  state.publication.managedSource = managed({ requiredOrigins: ['https://blocked.example'] })
  assert.deepEqual(ids(await repository.list()), [])
  assert.deepEqual(ids(repository.pendingApproval()), ['builtin-kulao-svip'])
  assert.equal(state.bodyRequests.length, 1)
})

test('same-revision digest change cannot fall back to the old grant when the new body fails verification', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  assert.equal((await repository.list())[0].script, scriptA)
  state.publication.managedSource = managed({ sha256: shaB })
  state.bodies.set(shaB, 'wrong body')
  assert.deepEqual(ids(await repository.list()), [])
  state.bodies.set(shaB, scriptB)
  const recovered = await repository.list()
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].script, scriptB)
  assert.equal(recovered[0].sha256, shaB)
  assert.equal(state.bodyRequests.length, 3, 'The rejected bytes must not enter the verified cache')
})

test('same-revision metadata changes update the result while retaining the verified body cache', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  await repository.list()
  state.publication.managedSource = managed({ name: 'Renamed source', priority: 30, version: '2' })
  const records = await repository.list()
  assert.equal(records[0].name, 'Renamed source')
  assert.equal(records[0].priority, 30)
  assert.equal(records[0].version, '2')
  assert.equal(state.bodyRequests.length, 1)
})

test('a same-revision removal from the ordinary publication list revokes that source', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [published('ordinary')] })
  assert.equal((await repository.list()).length, 1)
  state.publication = { revision: 5, sources: [] }
  assert.deepEqual(ids(await repository.list()), [])
})

test('revocation clears pending policy immediately while an unrelated new body is still downloading', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed({ requiredOrigins: ['https://blocked.example'] }) })
  assert.deepEqual(ids(await repository.list()), [])
  assert.deepEqual(ids(repository.pendingApproval()), ['builtin-kulao-svip'])
  const started = deferred()
  const body = deferred()
  state.publication = {
    revision: 5, sources: [published('new-source', { sha256: shaB })],
    managedSource: managed({ enabled: false, status: 'disabled', deleted: true }),
  }
  state.bodyResponse = () => { started.resolve(); return body.promise }
  const loading = repository.list()
  // A broken same-revision fast path finishes without requesting the new body.
  const requestedBody = await Promise.race([started.promise.then(() => true), loading.then(() => false)])
  const pendingWhileLoading = ids(repository.pendingApproval())
  const observedPolicy = repository.managedSource()
  body.resolve(new Response(scriptB))
  const records = await loading
  assert.equal(requestedBody, true)
  assert.deepEqual(pendingWhileLoading, [])
  assert.equal(observedPolicy.deleted, true)
  assert.deepEqual(ids(records), ['global:new-source'])
})

test('an unchanged publication retains the fast path and does not redownload verified script bytes', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  const first = await repository.list()
  const second = await repository.list()
  assert.strictEqual(second, first)
  assert.equal(state.bodyRequests.length, 1)
})

test('an older revision cannot restore a source after a newer revision revoked it', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  await repository.list()
  state.publication = { revision: 6, sources: [], managedSource: managed({ enabled: false, status: 'disabled' }) }
  assert.deepEqual(ids(await repository.list()), [])
  state.publication = { revision: 5, sources: [], managedSource: managed() }
  assert.deepEqual(ids(await repository.list()), [])
  assert.equal(repository.revision(), 6)
  assert.equal(repository.managedSource().enabled, false)
})

test('registry errors fail closed and an explicit later reauthorisation can reuse verified bytes', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  await repository.list()
  state.listError = true
  assert.deepEqual(ids(await repository.list()), [])
  state.listError = false
  state.publication.managedSource = managed({ enabled: false, status: 'disabled' })
  assert.deepEqual(ids(await repository.list()), [])
  state.publication.managedSource = managed()
  assert.deepEqual(ids(await repository.list()), ['global:builtin-kulao-svip'])
  assert.equal(state.bodyRequests.length, 1)
})

test('a malformed same-revision publication fails closed before a cached grant is reused', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  await repository.list()
  state.publication = { revision: 5, sources: null }
  assert.deepEqual(ids(await repository.list()), [])
})

test('invalidation prevents a pending old body from restoring source grants or cached bytes', async () => {
  const { state, repository } = fixture({ revision: 5, sources: [], managedSource: managed() })
  const started = deferred()
  const body = deferred()
  state.bodyResponse = () => { started.resolve(); return body.promise }
  const oldRequest = repository.list()
  await started.promise
  repository.invalidate()
  state.publication = { revision: 6, sources: [], managedSource: managed({ enabled: false, status: 'disabled' }) }
  assert.deepEqual(ids(await repository.list()), [])
  body.resolve(new Response(scriptA))
  assert.deepEqual(ids(await oldRequest), [])
  state.bodyResponse = undefined
  state.publication = { revision: 7, sources: [], managedSource: managed() }
  assert.equal((await repository.list()).length, 1)
  assert.equal(state.bodyRequests.length, 2, 'An invalidated body must not populate the verified cache')
})
