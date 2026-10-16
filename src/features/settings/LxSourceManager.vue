<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { LxRuntimeClient } from '../player/lx/runtime/client'
import { getDefaultLxSourceRepository } from '../player/lx/sourceRepository'
import {
  LX_MAX_SCRIPT_BYTES,
  type LxSourceRecord,
  type LxSourceRepository,
} from '../player/lx/types'
import { translate, type Locale, type TranslationKey } from '../../i18n'

/**
 * Loads a stored script in the QuickJS worker so a user can check it before relying on it.
 * Rejects when the script fails to boot; the component turns that into a generic status
 * rather than echoing the runner's message.
 */
export type LxSourceTestRunner = (source: LxSourceRecord) => Promise<void>

const props = defineProps<{
  locale: Locale
  repository?: LxSourceRepository
  testRunner?: LxSourceTestRunner
  requestConsent?: () => Promise<boolean>
}>()

const repository = props.repository ?? getDefaultLxSourceRepository()

const text = (key: TranslationKey, params?: Record<string, unknown>): string =>
  translate(props.locale, key, params)

const defaultTestRunner: LxSourceTestRunner = async (source) => {
  const client = new LxRuntimeClient()
  try {
    await client.loadSource(source.script)
  } finally {
    try {
      await client.dispose()
    } catch {
      // The worker is torn down either way; a disposal failure is not a source failure.
    }
  }
}

const sources = ref<LxSourceRecord[]>([])
const busy = ref(false)
const status = ref('')
const failure = ref('')
const urlText = ref('')
const pasteText = ref('')
const refreshTargetId = ref<string | null>(null)

/**
 * The bundled snapshot is pinned first. The repository already keeps it at the lowest
 * priority, but the pin is the component's contract: reordering is only ever offered for
 * custom sources, so the built-in cannot be displaced even by inconsistent stored data.
 */
const builtInSource = computed<LxSourceRecord | null>(
  () => sources.value.find((source) => source.builtIn) ?? null,
)
const customSources = computed<LxSourceRecord[]>(() =>
  sources.value
    .filter((source) => !source.builtIn)
    .slice()
    .sort((left, right) => left.priority - right.priority),
)
const rows = computed<LxSourceRecord[]>(() => {
  const pinned = builtInSource.value
  return pinned ? [pinned, ...customSources.value] : [...customSources.value]
})

const pasteBytes = computed(() => new TextEncoder().encode(pasteText.value).byteLength)

const isFirstCustom = (source: LxSourceRecord): boolean =>
  customSources.value[0]?.id === source.id
const isLastCustom = (source: LxSourceRecord): boolean =>
  customSources.value[customSources.value.length - 1]?.id === source.id

const tooLarge = (): string => text('settings.lx.errorTooLarge', { limit: LX_MAX_SCRIPT_BYTES })

/**
 * Import and refresh failures carry raw messages from the network, the sandbox and
 * IndexedDB. The repository has no error codes, so the one condition a user can act on is
 * recognised by its documented wording and everything else -- including any upstream text
 * or script content -- is reported generically.
 */
function describeFailure(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : ''
  if (message.includes('maximum allowed size')) return tooLarge()
  return text('settings.lx.errorGeneric')
}

async function reload(): Promise<void> {
  sources.value = await repository.list()
}

async function withMutation(
  action: () => Promise<unknown>,
  outcome: { success?: TranslationKey; failure?: TranslationKey } = {},
): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  status.value = ''
  failure.value = ''
  try {
    await action()
    await reload()
    if (outcome.success) status.value = text(outcome.success)
    return true
  } catch (caught) {
    failure.value = outcome.failure ? text(outcome.failure) : describeFailure(caught)
    return false
  } finally {
    busy.value = false
  }
}

async function onToggle(source: LxSourceRecord, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  if (enabled && !source.builtIn && props.requestConsent && !await props.requestConsent()) {
    input.checked = source.enabled
    return
  }
  // The checkbox is bound one way, so a rejected write has to put the control back itself;
  // otherwise the page would claim a provider is off when the store still has it on.
  if (!await withMutation(() => repository.setEnabled(source.id, enabled))) {
    input.checked = source.enabled
  }
}

async function move(source: LxSourceRecord, delta: -1 | 1): Promise<void> {
  const order = customSources.value.map((record) => record.id)
  const from = order.indexOf(source.id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return
  ;[order[from], order[to]] = [order[to], order[from]]
  await withMutation(() => repository.reorder(order))
}

async function removeSource(source: LxSourceRecord): Promise<void> {
  await withMutation(() => repository.delete(source.id), { success: 'settings.lx.removed' })
}

async function testSource(source: LxSourceRecord): Promise<void> {
  if (!source.builtIn && props.requestConsent && !await props.requestConsent()) return
  const runner = props.testRunner ?? defaultTestRunner
  await withMutation(() => runner(source), {
    success: 'settings.lx.testSucceeded',
    failure: 'settings.lx.testFailed',
  })
}

function readFileText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('file_read_failed'))
    reader.onabort = () => reject(new Error('file_read_aborted'))
    reader.readAsText(file)
  })
}

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared first so choosing the same file twice still fires a change event.
  input.value = ''
  if (!file) return

  failure.value = ''
  status.value = ''
  if (file.size > LX_MAX_SCRIPT_BYTES) {
    failure.value = tooLarge()
    return
  }

  let script: string
  try {
    script = await readFileText(file)
  } catch {
    failure.value = text('settings.lx.errorGeneric')
    return
  }
  if (new TextEncoder().encode(script).byteLength > LX_MAX_SCRIPT_BYTES) {
    failure.value = tooLarge()
    return
  }

  const name = file.name.replace(/\.js$/iu, '')
  if (props.requestConsent && !await props.requestConsent()) return
  await withMutation(() => repository.importScript(script, { name }), {
    success: 'settings.lx.imported',
  })
}

async function importFromUrl(): Promise<void> {
  const raw = urlText.value.trim()
  if (!raw) return

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    failure.value = text('settings.lx.errorHttps')
    status.value = ''
    return
  }
  if (parsed.protocol !== 'https:') {
    failure.value = text('settings.lx.errorHttps')
    status.value = ''
    return
  }

  if (props.requestConsent && !await props.requestConsent()) return

  if (await withMutation(() => repository.importRemote(raw), { success: 'settings.lx.imported' })) {
    urlText.value = ''
  }
}

async function importPasted(): Promise<void> {
  const script = pasteText.value
  if (!script.trim()) return
  if (pasteBytes.value > LX_MAX_SCRIPT_BYTES) {
    failure.value = tooLarge()
    status.value = ''
    return
  }

  if (props.requestConsent && !await props.requestConsent()) return

  if (await withMutation(() => repository.importScript(script), { success: 'settings.lx.imported' })) {
    pasteText.value = ''
  }
}

function beginRefresh(source: LxSourceRecord): void {
  refreshTargetId.value = source.id
  status.value = ''
  failure.value = ''
}

function cancelRefresh(): void {
  refreshTargetId.value = null
}

/**
 * Remote content is never adopted silently. The confirmation states the SHA-256 of the
 * snapshot that would be replaced, and only then does the repository fetch and store the
 * current remote content.
 */
async function confirmRefresh(source: LxSourceRecord): Promise<void> {
  if (!source.builtIn && props.requestConsent && !await props.requestConsent()) return
  const replacedSha = source.sha256
  let adoptedSha = ''
  const succeeded = await withMutation(async () => {
    adoptedSha = (await repository.refreshRemote(source.id)).sha256
  }, { failure: 'settings.lx.refreshFailed' })
  refreshTargetId.value = null
  if (!succeeded) return

  status.value = adoptedSha === replacedSha
    ? text('settings.lx.refreshUnchanged', { sha: adoptedSha })
    : text('settings.lx.refreshReplaced', { old: replacedSha, new: adoptedSha })
}

onMounted(() => {
  void reload().catch(() => {
    sources.value = []
    failure.value = text('settings.lx.errorGeneric')
  })
})
</script>

<template>
  <div class="lx-manager" data-lx-source-manager>
    <p data-lx-explanation>{{ text('settings.lx.explanation') }}</p>

    <fieldset class="lx-manager__group" data-lx-source-list>
      <legend>{{ text('settings.lx.title') }}</legend>
      <ul class="lx-manager__list">
        <li
          v-for="source in rows"
          :key="source.id"
          class="lx-manager__item"
          :data-lx-source="source.id"
          :data-lx-source-builtin="source.builtIn ? 'true' : 'false'"
        >
          <div class="lx-manager__heading">
            <label class="lx-manager__toggle">
              <input
                type="checkbox"
                :checked="source.enabled"
                :disabled="busy"
                @change="onToggle(source, $event)"
              />
              <span data-lx-source-name>{{ source.name }}</span>
            </label>
            <span v-if="source.builtIn" class="lx-manager__badge">{{ text('settings.lx.builtIn') }}</span>
          </div>
          <p class="lx-manager__meta">
            <span class="lx-manager__meta-label">SHA-256</span>
            <span data-lx-source-sha>{{ source.sha256 }}</span>
          </p>
          <p v-if="source.originUrl" class="lx-manager__meta">
            <span class="lx-manager__meta-label">{{ text('settings.lx.origin') }}</span>
            <span data-lx-source-origin>{{ source.originUrl }}</span>
          </p>
          <div class="lx-manager__actions">
            <button
              type="button"
              data-lx-source-move-up
              :disabled="busy || source.builtIn || isFirstCustom(source)"
              :aria-label="text('settings.lx.moveUpNamed', { name: source.name })"
              :aria-describedby="source.builtIn ? `lx-source-${source.id}-pinned` : undefined"
              @click="move(source, -1)"
            >{{ text('settings.lx.moveUp') }}</button>
            <button
              type="button"
              data-lx-source-move-down
              :disabled="busy || source.builtIn || isLastCustom(source)"
              :aria-label="text('settings.lx.moveDownNamed', { name: source.name })"
              :aria-describedby="source.builtIn ? `lx-source-${source.id}-pinned` : undefined"
              @click="move(source, 1)"
            >{{ text('settings.lx.moveDown') }}</button>
            <button
              type="button"
              data-lx-source-test
              :disabled="busy"
              :aria-label="text('settings.lx.testNamed', { name: source.name })"
              @click="testSource(source)"
            >{{ text('settings.lx.test') }}</button>
            <button
              v-if="source.originUrl"
              type="button"
              data-lx-source-refresh
              :disabled="busy"
              :aria-label="text('settings.lx.refreshNamed', { name: source.name })"
              @click="beginRefresh(source)"
            >{{ text('settings.lx.refresh') }}</button>
            <button
              type="button"
              data-lx-source-delete
              :disabled="busy || source.builtIn"
              :aria-label="text('settings.lx.deleteNamed', { name: source.name })"
              @click="removeSource(source)"
            >{{ text('settings.lx.delete') }}</button>
          </div>
          <p
            v-if="source.builtIn"
            :id="`lx-source-${source.id}-pinned`"
            class="lx-manager__note"
            data-lx-source-pinned-note
          >{{ text('settings.lx.builtInPinned') }}</p>
          <div v-if="refreshTargetId === source.id" class="lx-manager__confirm" data-lx-refresh-confirm>
            <p>{{ text('settings.lx.refreshConfirm') }}</p>
            <p class="lx-manager__meta" data-lx-refresh-old-sha>
              {{ text('settings.lx.refreshOldSha', { sha: source.sha256 }) }}
            </p>
            <div class="lx-manager__actions">
              <button
                type="button"
                data-lx-refresh-accept
                :disabled="busy"
                @click="confirmRefresh(source)"
              >{{ text('settings.lx.refreshConfirmAction') }}</button>
              <button
                type="button"
                data-lx-refresh-cancel
                :disabled="busy"
                @click="cancelRefresh"
              >{{ text('settings.lx.refreshCancel') }}</button>
            </div>
          </div>
        </li>
      </ul>
    </fieldset>

    <p
      data-lx-status
      role="status"
      aria-live="polite"
      :data-lx-status-tone="failure ? 'error' : 'info'"
    >{{ failure || status }}</p>

    <fieldset class="lx-manager__group" data-lx-import>
      <legend>{{ text('settings.lx.importHeading') }}</legend>
      <label>
        <span>{{ text('settings.lx.importFile') }}</span>
        <input
          type="file"
          accept=".js,text/javascript,application/javascript"
          data-lx-import-file
          :disabled="busy"
          @change="onFileChosen"
        />
      </label>
      <label>
        <span>{{ text('settings.lx.importUrl') }}</span>
        <input
          type="url"
          data-lx-import-url
          :value="urlText"
          :disabled="busy"
          placeholder="https://example.com/source.js"
          @input="urlText = ($event.target as HTMLInputElement).value"
        />
      </label>
      <div class="lx-manager__actions">
        <button
          type="button"
          data-lx-import-url-submit
          :disabled="busy || !urlText.trim()"
          @click="importFromUrl"
        >{{ text('settings.lx.importUrlAction') }}</button>
      </div>
      <label>
        <span>{{ text('settings.lx.importPaste') }}</span>
        <textarea
          data-lx-import-paste
          rows="6"
          :value="pasteText"
          :disabled="busy"
          @input="pasteText = ($event.target as HTMLTextAreaElement).value"
        />
      </label>
      <p v-if="pasteText" data-lx-paste-size>
        {{ text('settings.lx.pasteSize', { bytes: pasteBytes, limit: LX_MAX_SCRIPT_BYTES }) }}
      </p>
      <div class="lx-manager__actions">
        <button
          type="button"
          data-lx-import-paste-submit
          :disabled="busy || !pasteText.trim()"
          @click="importPasted"
        >{{ text('settings.lx.importPasteAction') }}</button>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.lx-manager { display: grid; gap: 0.75rem; min-width: 0; }
.lx-manager p, .lx-manager ul { margin: 0; }
.lx-manager p, .lx-manager label, .lx-manager legend { color: var(--colour-text-muted); font-size: 0.875rem; line-height: 1.5; }
.lx-manager__group { display: grid; gap: 0.5rem; min-width: 0; margin: 0; padding: 0.75rem; border: var(--glass-border); border-radius: 0.5rem; }
.lx-manager__group legend { padding-inline: 0.25rem; color: var(--colour-text-primary); font-weight: 700; }
.lx-manager__list { display: grid; gap: 0.5rem; padding: 0; list-style: none; }
.lx-manager__item { display: grid; gap: 0.5rem; min-width: 0; padding: 0.5rem; border: var(--glass-border); border-radius: 0.5rem; }
.lx-manager__heading { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.lx-manager__toggle { display: flex; min-height: 2.75rem; gap: 0.5rem; align-items: center; color: var(--colour-text-primary); font-weight: 650; }
.lx-manager__toggle input { width: 1.25rem; min-height: 1.25rem; padding: 0; accent-color: var(--colour-accent); }
.lx-manager__badge { padding: 0.125rem 0.5rem; color: var(--colour-accent-strong); border: var(--glass-border); border-radius: 0.25rem; font-size: 0.75rem; font-weight: 700; }
.lx-manager__meta { display: flex; flex-wrap: wrap; gap: 0.5rem; overflow-wrap: anywhere; }
.lx-manager__meta-label { color: var(--colour-text-primary); font-weight: 700; }
.lx-manager__meta span:last-child { font-family: "Courier New", monospace; }
.lx-manager__note { color: var(--colour-accent-strong); }
.lx-manager__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.lx-manager__confirm { display: grid; gap: 0.5rem; padding: 0.5rem; border: var(--glass-border); border-radius: 0.5rem; }
.lx-manager label { display: grid; gap: 0.5rem; }
.lx-manager input, .lx-manager textarea, .lx-manager button { min-height: 2.75rem; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; font: inherit; min-width: 0; max-width: 100%; }
.lx-manager textarea { resize: vertical; font-family: "Courier New", monospace; }
.lx-manager button { cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
.lx-manager button:hover:not(:disabled) { filter: var(--control-hover-filter); }
.lx-manager button:active:not(:disabled) { transform: scale(0.96); filter: var(--control-active-filter); }
.lx-manager button:disabled, .lx-manager input:disabled, .lx-manager textarea:disabled { cursor: not-allowed; opacity: 0.55; }
</style>
