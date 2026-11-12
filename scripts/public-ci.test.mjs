import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const workflowPath = new URL('../.github/workflows/public-ci.yml', import.meta.url)
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n') : ''
const verify = workflow.split('  verify:\n')[1]?.split('  gate:\n')[0] ?? ''
const gate = workflow.split('  gate:\n')[1] ?? ''
const commands = [
  'node --test scripts/public-ci.test.mjs',
  'npm ci --no-audit --no-fund',
  'npm run test:lx-policy-native',
  'npm run typecheck',
  'npm test',
  'npm run test:workers -- --maxWorkers=2',
  'npm run build',
  'npm run d1:migrate:local',
  'npm audit --omit=dev --audit-level=high',
]

// This is a deliberately narrow policy check, not a general YAML parser.
// GitHub validates workflow syntax; a YAML parser is also used during local review.
test('public PR, main push and manual events have no path or draft bypass', () => {
  assert.match(workflow, /^on:\n  pull_request:\n    branches: \[main\]\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/m)
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|paths-ignore:|\bpaths:|github\.event\.pull_request\.draft/)
})

test('hosted runners and immutable actions keep the token read-only and unpersisted', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m)
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 2)
  assert.deepEqual([...workflow.matchAll(/uses: (\S+)/g)].map(m => m[1]), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  ])
  assert.match(verify, /persist-credentials: false/)
  assert.match(verify, /fetch-depth: 1/)
  assert.match(verify, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(verify, /node-version: '>=22\.18\.0 <23'/)
  assert.match(verify, /package-manager-cache: false/)
  assert.doesNotMatch(workflow, /secrets\.|self-hosted|pull-requests:|id-token:|statuses:|checks:|contents: write|upload-artifact|download-artifact|actions\/cache|^\s+cache:/m)
})

test('the complete public validation runs sequentially without optional failures', () => {
  let previous = -1
  for (const command of commands) {
    const at = verify.indexOf(`run: ${command}\n`)
    assert.ok(at > previous, `missing or reordered command: ${command}`)
    previous = at
  }
  assert.deepEqual([...(workflow.split('jobs:\n')[1] ?? '').matchAll(/^  ([a-z][a-z-]*):\n/gm)].map(m => m[1]), ['verify', 'gate'])
  assert.doesNotMatch(workflow, /continue-on-error|strategy:|--remote|--maxWorkers=(?!2\b)\d/)
  assert.doesNotMatch(verify, /^    (?:if|needs):|^        if:/m)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const name of ['typecheck', 'test', 'test:workers', 'build', 'd1:migrate:local']) {
    assert.equal(typeof pkg.scripts[name], 'string', `missing public script: ${name}`)
  }
  assert.match(pkg.scripts['d1:migrate:local'], /--local\b/)
  assert.doesNotMatch(pkg.scripts['d1:migrate:local'], /--remote\b/)
})

test('input provenance precedes package execution and uses fixed file names', () => {
  assert.ok(verify.indexOf('name: Record public inputs') >= 0)
  assert.ok(verify.indexOf('name: Record public inputs') < verify.indexOf('run: npm ci'))
  for (const path of ['package.json', 'package-lock.json', 'vite.config.ts', 'vitest.config.ts', 'vitest.workers.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'wrangler.toml', '.github/workflows/public-ci.yml', 'scripts/public-ci.test.mjs']) {
    assert.ok(verify.includes(`'${path}'`), `missing input hash: ${path}`)
  }
  assert.match(verify, /GITHUB_STEP_SUMMARY/)
  assert.match(verify, /createHash\('sha256'\)/)
  assert.match(verify, /git', \['rev-parse', 'HEAD'\]/)
  assert.match(verify, /head !== process\.env\.GITHUB_SHA/)
  assert.doesNotMatch(workflow, /github\.event\.(?:pull_request\.(?:title|body|head\.ref)|inputs)|inputs\.|github\.head_ref|eval\b/)
  for (const block of workflow.matchAll(/run: \|\n((?:          .*\n|\n)+)/g)) {
    assert.doesNotMatch(block[1], /\$\{\{/, 'expressions must enter scripts only through environment values')
  }
})

test('the native all-success job always evaluates the verification result', () => {
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m)
  assert.match(gate, /^    needs: \[verify\]$/m)
  assert.match(gate, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/)
  assert.doesNotMatch(gate, /uses:|continue-on-error/)
  assert.match(gate, /Object\.keys\(results\)\.length !== 1/)
  assert.match(gate, /results\.verify\?\.result !== 'success'/)
})

test('the actual gate code rejects every non-success result and missing/extra jobs', () => {
  const match = gate.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)
  assert.ok(match, 'gate Node script is required')
  const script = match[1].split('\n').map(line => line.replace(/^          /, '')).join('\n')
  const cases = [
    [{ verify: { result: 'success' } }, 0],
    ...['failure', 'cancelled', 'skipped', 'pending', '', 'SUCCESS'].map(result => [{ verify: { result } }, 1]),
    [{}, 1], [{ verify: {} }, 1], [{ other: { result: 'success' } }, 1],
    [{ verify: { result: 'success' }, extra: { result: 'skipped' } }, 1],
    ['malformed', 1],
  ]
  for (const [results, expected] of cases) {
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, NEEDS_JSON: typeof results === 'string' ? results : JSON.stringify(results) },
      encoding: 'utf8', timeout: 5000,
    })
    assert.equal(child.status, expected, `gate result for ${JSON.stringify(results)}: ${child.stderr}`)
  }
})

test('frontend invocation preserves the existing single worker limit', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /--maxWorkers=3$/);
  assert.match(verify, /run: npm test\n/);
  assert.doesNotMatch(verify, /run: npm test --/);
});


test('the portable LX policy regression suite is a real mandatory command', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['test:lx-policy-native'],
    'node --experimental-vm-modules --test --test-concurrency=1 src/features/player/lx/globalSourceRepository.native-tests.mjs')
  assert.ok(existsSync(new URL('../src/features/player/lx/globalSourceRepository.native-tests.mjs', import.meta.url)))
  assert.ok(verify.includes("'src/features/player/lx/globalSourceRepository.native-tests.mjs'"), 'Native test input must be hashed before execution')
})


test('the public build uses verification-only explicit response policy without operator files', () => {
  const buildStep = verify.split('name: Build the public app\n')[1]?.split('\n      - name:')[0] ?? ''
  assert.match(buildStep, /RESPONSE_POLICY_PUBLIC_ORIGIN: 'https:\/\/public-ci\.example\.invalid'/)
  assert.match(buildStep, /RESPONSE_POLICY_R2_BASE_URL: 'https:\/\/media\.public-ci\.example\.invalid\/'/)
  assert.match(buildStep, /LX_ALLOWED_ORIGINS: ''/)
  assert.match(buildStep, /run: npm run build/)
  assert.doesNotMatch(buildStep, /--mode|--allow-unknown|wrangler\.(?:remote|staging)|secrets\./)
})
