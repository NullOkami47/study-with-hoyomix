<script setup lang="ts">
// Admin console section for the global LX source registry.
//
// The rules this screen enforces are the ones the server enforces too; the screen exists so the
// Owner can see *why* something is or is not published, and so that adopting a new script is always
// an explicit, reviewable act.
//
// A script is never executed on the server. "Test" runs it in this browser's QuickJS Web Worker
// sandbox — the same sandbox a listener's copy runs in — so the test result means something.
import { computed, onMounted, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-vue-next'

import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
import { probeLxScript } from '../player/lx/probeScript'
import AdminConfirmDialog from './primitives/AdminConfirmDialog.vue'
import type {
  AdminLxSource,
  AdminLxSourcePreview,
  AdminLxUpdateCandidate,
  AdminRepository,
} from './client'

const props = defineProps<{ repository: AdminRepository }>()

const { locale } = usePreferences()
function t(key: string, params?: Record<string, unknown>): string {
  return translate(locale.value, key as TranslationKey, params)
}

const sources = ref<AdminLxSource[]>([])
const revision = ref(0)
const loading = ref(false)
const busy = ref<string | null>(null)
const error = ref<string | null>(null)

// --- add form ---
const sourceUrl = ref('')
const sourceName = ref('')
const uploadedFile = ref<File | null>(null)
const preview = ref<AdminLxSourcePreview | null>(null)
const previewing = ref(false)
const probeNote = ref<string | null>(null)
const probeOk = ref(false)
const disclosureConfirmed = ref(false)
let candidateGeneration = 0
const pendingDisclosure = ref<{source: AdminLxSource; sha256: string; script?: string; keys: string[]} | null>(null)
watch([sourceUrl, uploadedFile], () => {
  candidateGeneration++
  preview.value = null
  disclosureConfirmed.value = false
  probeNote.value = null
}, {flush:'sync'})

// --- per-source transient state ---
const candidates = ref<Record<string, AdminLxUpdateCandidate>>({})
const notes = ref<Record<string, string>>({})
const pendingDelete = ref<AdminLxSource | null>(null)
const expanded = ref<string | null>(null)
const editingName = ref<string | null>(null)
const editedName = ref('')

const canSubmit = computed(
  () => (sourceUrl.value.trim().length > 0 || uploadedFile.value !== null) && !previewing.value && busy.value === null
    && (!(preview.value?.credentialKeys?.length) || disclosureConfirmed.value),
)

function statusLabel(source: AdminLxSource): string {
  if (source.status === 'pending_network_approval') return t('admin.lxSources.statusPending')
  if (source.status === 'disabled') return t('admin.lxSources.statusDisabled')
  if (source.status === 'failed') return t('admin.lxSources.statusFailed')
  return t('admin.lxSources.statusActive')
}

function shortDigest(digest: string): string {
  return digest.length > 16 ? `${digest.slice(0, 16)}…` : digest
}

function hasIpOrigin(origins: readonly string[]): boolean {
  return origins.some((origin) => {
    try {
      const host = new URL(origin).hostname
      return /^\d+\.\d+\.\d+\.\d+$/u.test(host) || host.startsWith('[')
    } catch { return false }
  })
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await props.repository.listLxSources()
    sources.value = result.sources
    revision.value = result.revision
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function previewCandidate(): Promise<void> {
  const generation = ++candidateGeneration
  previewing.value = true
  preview.value = null
  disclosureConfirmed.value = false
  probeNote.value = null
  error.value = null
  try {
    const script = uploadedFile.value ? await uploadedFile.value.text() : undefined
    if (generation !== candidateGeneration) return
    const result = await props.repository.previewLxSource(
      script !== undefined ? { script } : { url: sourceUrl.value.trim() },
    )
    if (generation !== candidateGeneration) return
    preview.value = result
    // The sandbox test runs in the worker, never on this thread.
    const probe = await probeLxScript(result.script)
    if (generation !== candidateGeneration) return
    probeOk.value = probe.ok
    probeNote.value = probe.ok
      ? t('admin.lxSources.testOk', { platforms: probe.platforms.join(', ') || '—' })
      : t('admin.lxSources.testFailed', { error: probe.error ?? 'unknown error' })
  } catch (err: unknown) {
    if (generation !== candidateGeneration) return
    probeOk.value = false
    probeNote.value = t('admin.lxSources.testFailed', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    previewing.value = false
  }
}

async function addSource(): Promise<void> {
  if (busy.value !== null) return
  const generation = candidateGeneration
  busy.value = 'add'
  error.value = null
  try {
    const script = uploadedFile.value ? await uploadedFile.value.text() : undefined
    if (generation !== candidateGeneration) return
    const input: { url?: string; script?: string; name?: string; credentialDisclosureSha256?: string } = {}
    if (script !== undefined) input.script = script
    else input.url = sourceUrl.value.trim()
    if (sourceName.value.trim()) input.name = sourceName.value.trim()
    if (!preview.value) {
      const result = await props.repository.previewLxSource(input)
      if (generation !== candidateGeneration) return
      preview.value = result
      disclosureConfirmed.value = false
    }
    if (preview.value.credentialKeys?.length) {
      if (!disclosureConfirmed.value) return
      input.credentialDisclosureSha256 = preview.value.sha256
    }
    await props.repository.createLxSource(input)
    disclosureConfirmed.value = false
    sourceUrl.value = ''
    sourceName.value = ''
    uploadedFile.value = null
    preview.value = null
    probeNote.value = null
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

function beginNameEdit(source: AdminLxSource): void {
  editingName.value = source.id
  editedName.value = source.name
}

async function saveName(source: AdminLxSource): Promise<void> {
  const name = editedName.value.trim()
  if (!name || busy.value !== null) return
  busy.value = source.id
  error.value = null
  try {
    await props.repository.updateLxSource(source.id, { name })
    editingName.value = null
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

async function toggleSource(source: AdminLxSource, enabled: boolean): Promise<void> {
  busy.value = source.id
  error.value = null
  try {
    await props.repository.updateLxSource(source.id, { enabled })
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

async function move(source: AdminLxSource, delta: number): Promise<void> {
  const index = sources.value.findIndex((candidate) => candidate.id === source.id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= sources.value.length) return
  busy.value = source.id
  error.value = null
  try {
    const ids = sources.value.map((candidate) => candidate.id)
    const [moved] = ids.splice(index, 1)
    ids.splice(target, 0, moved!)
    await props.repository.reorderLxSources(ids)
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

async function checkUpdate(source: AdminLxSource): Promise<void> {
  busy.value = source.id
  error.value = null
  try {
    const candidate = await props.repository.checkLxSourceUpdate(source.id)
    candidates.value = { ...candidates.value, [source.id]: candidate }
    if (candidate.hasUpdate && candidate.candidateScript) {
      const probe = await probeLxScript(candidate.candidateScript)
      notes.value = {
        ...notes.value,
        [source.id]: probe.ok
          ? t('admin.lxSources.testOk', { platforms: probe.platforms.join(', ') || '—' })
          : t('admin.lxSources.testFailed', { error: probe.error ?? 'unknown error' }),
      }
    }
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

async function adopt(source: AdminLxSource): Promise<void> {
  const candidate = candidates.value[source.id]
  if (!candidate) return
  if (candidate.credentialKeys?.length) {
    pendingDisclosure.value = {source,sha256:candidate.candidateSha256,script:candidate.candidateScript,keys:candidate.credentialKeys}
    return
  }
  busy.value = source.id
  error.value = null
  try {
    await props.repository.adoptLxSource(source.id, candidate.candidateSha256, candidate.candidateScript)
    delete candidates.value[source.id]
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

async function rollback(source: AdminLxSource, sha256: string): Promise<void> {
  const keys = source.snapshots.find(snapshot => snapshot.sha256 === sha256)?.credentialKeys
  if (keys?.length) {
    pendingDisclosure.value = {source,sha256,keys}
    return
  }
  busy.value = source.id
  error.value = null
  try {
    await props.repository.adoptLxSource(source.id, sha256)
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

async function confirmDisclosure(): Promise<void> {
  const pending = pendingDisclosure.value
  if (!pending || busy.value !== null) return
  pendingDisclosure.value = null
  busy.value = pending.source.id
  error.value = null
  try {
    await props.repository.adoptLxSource(pending.source.id,pending.sha256,pending.script,pending.sha256)
    delete candidates.value[pending.source.id]
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally { busy.value = null }
}

async function confirmDelete(): Promise<void> {
  const source = pendingDelete.value
  if (!source) return
  busy.value = source.id
  error.value = null
  try {
    await props.repository.deleteLxSource(source.id)
    pendingDelete.value = null
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = null
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  uploadedFile.value = input.files && input.files.length > 0 ? input.files[0]! : null
  preview.value = null
  probeNote.value = null
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="lx-sources" data-lx-source-manager>
    <header class="lx-sources__header">
      <div>
        <h3>{{ t('admin.lxSources.title') }}</h3>
        <p class="lx-sources__description">{{ t('admin.lxSources.description') }}</p>
      </div>
      <div class="lx-sources__header-actions">
        <span class="lx-sources__revision" data-lx-registry-revision>
          {{ t('admin.lxSources.revision', { revision }) }}
        </span>
        <button type="button" class="lx-sources__button" :disabled="loading" @click="load">
          {{ loading ? t('admin.lxSources.refreshing') : t('admin.lxSources.refresh') }}
        </button>
      </div>
    </header>

    <p v-if="error" class="lx-sources__error" role="alert" data-lx-source-error>{{ error }}</p>

    <div class="lx-sources__add">
      <h4>{{ t('admin.lxSources.addTitle') }}</h4>
      <label class="lx-sources__field">
        <span>{{ t('admin.lxSources.urlLabel') }}</span>
        <input
          v-model="sourceUrl"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('admin.lxSources.urlPlaceholder')"
          data-lx-source-url
          :disabled="uploadedFile !== null"
        />
      </label>
      <label class="lx-sources__field">
        <span>{{ t('admin.lxSources.uploadLabel') }}</span>
        <input type="file" accept=".js,text/javascript" data-lx-source-file @change="onFileChange" />
      </label>
      <label class="lx-sources__field">
        <span>{{ t('admin.lxSources.nameLabel') }}</span>
        <input v-model="sourceName" type="text" autocomplete="off" data-lx-source-name />
      </label>
      <div class="lx-sources__add-actions">
        <button
          type="button"
          class="lx-sources__button"
          :disabled="!canSubmit"
          data-lx-source-preview
          @click="previewCandidate"
        >
          {{ previewing ? t('admin.lxSources.testing') : t('admin.lxSources.test') }}
        </button>
        <button
          type="button"
          class="lx-sources__button lx-sources__button--primary"
          :disabled="!canSubmit"
          data-lx-source-add
          @click="addSource"
        >
          {{ t('admin.lxSources.add') }}
        </button>
      </div>
      <p v-if="preview" class="lx-sources__preview" data-lx-source-preview-result>
        <span class="lx-sources__digest">{{ shortDigest(preview.sha256) }}</span>
        <span v-if="preview.version"> · {{ preview.version }}</span>
        <span v-if="preview.requiredOrigins.length > 0">
          · {{ t('admin.lxSources.requiredOrigins') }}: {{ preview.requiredOrigins.join(', ') }}
        </span>
        <!--
          An empty list is not "this script needs no network". It means static analysis found no
          absolute URL destinations — an obfuscated or composed URL is invisible to it. Saying so
          here is the difference between a reviewable statement and a false reassurance.
        -->
        <span v-else :title="t('admin.lxSources.noStaticOriginsHint')" data-lx-source-no-static-origins>
          · {{ t('admin.lxSources.noStaticOrigins') }}
        </span>
        <span v-if="preview.headerOrigins.length > 0" :title="t('admin.lxSources.headerOriginsHint')">
          · {{ t('admin.lxSources.headerOrigins') }}: {{ preview.headerOrigins.join(', ') }}
        </span>
      </p>
      <p
        v-if="probeNote"
        class="lx-sources__probe"
        :class="probeOk ? 'lx-sources__probe--ok' : 'lx-sources__probe--bad'"
        data-lx-source-probe
      >
        {{ probeNote }}
      </p>
    </div>

    <label v-if="preview?.credentialKeys?.length" class="lx-sources__field" data-lx-source-disclosure>
      <span>{{ t('admin.lxSources.credentialWarning', {keys:preview.credentialKeys.join(', '),sha256:preview.sha256}) }}</span>
      <span class="lx-sources__toggle">
        <input v-model="disclosureConfirmed" type="checkbox" data-lx-source-disclosure-confirm :disabled="busy !== null || previewing" />
        <span>{{ t('admin.lxSources.credentialConfirm') }}</span>
      </span>
    </label>
    <p v-if="preview?.plaintextOrigins?.length" class="lx-sources__origins lx-sources__origins--pending" data-lx-source-plaintext-warning>
      {{ t('admin.lxSources.plaintextWarning') }}: {{ preview.plaintextOrigins.join(', ') }}
    </p>
    <p v-if="preview && hasIpOrigin(preview.requiredOrigins)" class="lx-sources__origins lx-sources__origins--pending" data-lx-source-ip-warning>
      {{ t('admin.lxSources.ipOriginWarning') }}
    </p>
    <p v-if="sources.length === 0 && !loading" class="lx-sources__empty" data-lx-source-empty>
      {{ t('admin.lxSources.empty') }}
    </p>

    <ol v-else class="lx-sources__list">
      <li
        v-for="(source, index) in sources"
        :key="source.id"
        class="lx-sources__item"
        :data-lx-source-id="source.id"
        :data-lx-source-status="source.status"
      >
        <div class="lx-sources__order">
          <span class="lx-sources__order-badge">{{ index + 1 }}</span>
          <button
            type="button"
            class="lx-sources__icon-button"
            :aria-label="t('admin.lxSources.moveUp')"
            :disabled="index === 0 || busy === source.id"
            @click="move(source, -1)"
          >
            <ArrowUp :size="16" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="lx-sources__icon-button"
            :aria-label="t('admin.lxSources.moveDown')"
            :disabled="index === sources.length - 1 || busy === source.id"
            @click="move(source, 1)"
          >
            <ArrowDown :size="16" aria-hidden="true" />
          </button>
        </div>

        <div class="lx-sources__body">
          <div class="lx-sources__title-row">
            <span class="lx-sources__name">{{ source.name }}</span>
            <span v-if="source.managed" class="lx-sources__status">{{ t('settings.lx.builtIn') }}</span>
            <button
              type="button"
              class="lx-sources__button"
              data-lx-source-edit-name
              :aria-label="t('admin.lxSources.renameNamed', { name: source.name })"
              :disabled="busy !== null"
              @click="beginNameEdit(source)"
            >{{ t('admin.lxSources.rename') }}</button>
            <span class="lx-sources__status" :data-status="source.status">{{ statusLabel(source) }}</span>
          </div>
          <form v-if="editingName === source.id" data-lx-source-name-form class="lx-sources__actions" @submit.prevent="saveName(source)">
            <label class="lx-sources__field">
              <span>{{ t('admin.lxSources.nameLabel') }}</span>
              <input v-model="editedName" maxlength="120" required data-lx-source-name-input :disabled="busy !== null" />
            </label>
            <button type="submit" class="lx-sources__button" data-lx-source-save-name :disabled="busy !== null || !editedName.trim()">{{ t('admin.lxSources.saveName') }}</button>
            <button type="button" class="lx-sources__button" :disabled="busy !== null" @click="editingName = null">{{ t('admin.lxSources.confirmDeleteCancel') }}</button>
          </form>
          <dl class="lx-sources__meta">
            <div>
              <dt>{{ t('admin.lxSources.version') }}</dt>
              <dd>{{ source.version ?? '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('admin.lxSources.origin') }}</dt>
              <dd class="lx-sources__origin">{{ source.originUrl }}</dd>
            </div>
            <div>
              <dt>{{ t('admin.lxSources.digest') }}</dt>
              <dd class="lx-sources__digest" :title="source.sha256">{{ shortDigest(source.sha256) }}</dd>
            </div>
            <div>
              <dt>{{ t('admin.lxSources.lastCheck') }}</dt>
              <dd>{{ source.lastCheckNote ?? t('admin.lxSources.neverChecked') }}</dd>
            </div>
          </dl>
          <p v-if="source.requiredOrigins.length > 0" class="lx-sources__origins">
            {{ t('admin.lxSources.requiredOrigins') }}: {{ source.requiredOrigins.join(', ') }}
          </p>
          <p v-else class="lx-sources__origins" :title="t('admin.lxSources.noStaticOriginsHint')">
            {{ t('admin.lxSources.noStaticOrigins') }}
          </p>
          <p
            v-if="source.pendingOrigins.length > 0"
            class="lx-sources__origins lx-sources__origins--pending"
            data-lx-source-pending-origins
          >
            {{ t('admin.lxSources.pendingOrigins') }}: {{ source.pendingOrigins.join(', ') }}
          </p>
          <p v-if="notes[source.id]" class="lx-sources__note">{{ notes[source.id] }}</p>
          <p v-if="source.plaintextOrigins?.length" class="lx-sources__origins lx-sources__origins--pending" data-lx-source-plaintext-warning>
            {{ t('admin.lxSources.plaintextWarning') }}: {{ source.plaintextOrigins.join(', ') }}
          </p>
          <p v-if="hasIpOrigin(source.pendingOrigins)" class="lx-sources__origins lx-sources__origins--pending" data-lx-source-ip-warning>
            {{ t('admin.lxSources.ipOriginWarning') }}
          </p>
          <p
            v-if="candidates[source.id]?.hasUpdate"
            class="lx-sources__note lx-sources__note--update"
            data-lx-source-update-available
          >
            {{ t('admin.lxSources.updateAvailable') }}
            <span class="lx-sources__digest">{{ shortDigest(candidates[source.id]!.candidateSha256) }}</span>
          </p>
          <p
            v-else-if="candidates[source.id]"
            class="lx-sources__note"
            data-lx-source-update-none
          >
            {{ t('admin.lxSources.upToDate') }}
          </p>

          <div class="lx-sources__actions">
            <label class="lx-sources__toggle">
              <input
                type="checkbox"
                :checked="source.enabled"
                :disabled="busy === source.id"
                data-lx-source-enabled
                @change="toggleSource(source, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ t('admin.lxSources.enabled') }}</span>
            </label>
            <button
              type="button"
              class="lx-sources__button"
              :disabled="busy === source.id || source.originKind !== 'url'"
              data-lx-source-check-update
              @click="checkUpdate(source)"
            >
              {{ busy === source.id ? t('admin.lxSources.checkingUpdate') : t('admin.lxSources.checkUpdate') }}
            </button>
            <button
              v-if="candidates[source.id]?.hasUpdate"
              type="button"
              class="lx-sources__button lx-sources__button--primary"
              :disabled="busy === source.id"
              data-lx-source-adopt
              @click="adopt(source)"
            >
              {{ t('admin.lxSources.adopt') }}
            </button>
            <button
              type="button"
              class="lx-sources__button"
              :disabled="busy === source.id || source.snapshots.length < 2"
              data-lx-source-snapshots-toggle
              @click="expanded = expanded === source.id ? null : source.id"
            >
              {{ t('admin.lxSources.snapshots') }}
            </button>
            <button
              type="button"
              class="lx-sources__button lx-sources__button--danger"
              :disabled="busy === source.id"
              data-lx-source-delete
              @click="pendingDelete = source"
            >
              <Trash2 :size="14" aria-hidden="true" />
              <span>{{ t('admin.lxSources.delete') }}</span>
            </button>
          </div>

          <ul v-if="expanded === source.id" class="lx-sources__snapshots" data-lx-source-snapshots>
            <li v-for="snapshot in source.snapshots" :key="snapshot.sha256">
              <span class="lx-sources__digest" :title="snapshot.sha256">{{ shortDigest(snapshot.sha256) }}</span>
              <span v-if="snapshot.version"> · {{ snapshot.version }}</span>
              <span v-if="snapshot.active"> · ●</span>
              <button
                v-if="!snapshot.active"
                type="button"
                class="lx-sources__button"
                :disabled="busy === source.id"
                data-lx-source-rollback
                @click="rollback(source, snapshot.sha256)"
              >
                {{ t('admin.lxSources.rollback') }}
              </button>
            </li>
          </ul>
        </div>
      </li>
    </ol>

    <AdminConfirmDialog
      :open="pendingDisclosure !== null"
      :teleport="false"
      variant="warning"
      :title="t('admin.lxSources.credentialConfirm')"
      :description="pendingDisclosure ? t('admin.lxSources.credentialWarning', {keys:pendingDisclosure.keys.join(', '),sha256:pendingDisclosure.sha256}) : ''"
      :confirm-text="t('admin.lxSources.credentialConfirm')"
      dialog-data-attr="data-lx-disclosure-dialog"
      confirm-data-attr="data-lx-disclosure-confirm"
      @cancel="pendingDisclosure = null"
      @confirm="confirmDisclosure"
    />
    <AdminConfirmDialog
      :open="pendingDelete !== null"
      :teleport="false"
      variant="danger"
      :title="t('admin.lxSources.confirmDeleteTitle')"
      :description="t('admin.lxSources.confirmDeleteDescription')"
      :confirm-text="t('admin.lxSources.confirmDeleteConfirm')"
      :cancel-text="t('admin.lxSources.confirmDeleteCancel')"
      dialog-data-attr="data-lx-source-delete-dialog"
      cancel-data-attr="data-lx-source-delete-cancel"
      confirm-data-attr="data-lx-source-delete-confirm"
      @cancel="pendingDelete = null"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.lx-sources {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 1rem);
  padding: var(--space-4, 1rem);
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.lx-sources__header {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3, 0.75rem);
  align-items: flex-start;
  justify-content: space-between;
}

.lx-sources__header h3,
.lx-sources__add h4 {
  margin: 0;
}

.lx-sources__description {
  margin: var(--space-2, 0.5rem) 0 0;
  max-width: 60ch;
  color: var(--colour-text-secondary);
  font-size: 0.9rem;
}

.lx-sources__header-actions {
  display: flex;
  gap: var(--space-2, 0.5rem);
  align-items: center;
}

.lx-sources__revision {
  color: var(--colour-text-secondary);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.lx-sources__error {
  margin: 0;
  padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
  border-radius: var(--radius-control, 0.5rem);
  /* The Admin console is a dark surface, so the danger colour has to be the light red the rest of
     it uses (`AuditLog`'s error line, the confirm dialog's danger button) rather than a mid red that
     reads well only on white. #c05050 here was 3.1:1 — under AA — and axe flagged it. */
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
}

.lx-sources__add {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 0.75rem);
  padding: var(--space-3, 0.75rem);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.lx-sources__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 0.25rem);
  font-size: 0.85rem;
}

.lx-sources__field input {
  padding: var(--space-2, 0.5rem);
  color: var(--colour-text-primary);
  background: var(--colour-surface-raised, rgba(255, 255, 255, 0.06));
  border: var(--glass-border);
  border-radius: var(--radius-control, 0.5rem);
  font: inherit;
}

.lx-sources__add-actions,
.lx-sources__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 0.5rem);
  align-items: center;
}

.lx-sources__button {
  display: inline-flex;
  gap: var(--space-1, 0.25rem);
  align-items: center;
  padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-control, 0.5rem);
  font: inherit;
  cursor: pointer;
  transition: filter var(--motion-duration, 150ms) ease;
}

.lx-sources__button:hover:not(:disabled) {
  filter: var(--control-hover-filter, brightness(1.1));
}

.lx-sources__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.lx-sources__button--primary {
  color: var(--colour-accent-strong);
}

.lx-sources__button--danger {
  color: #f87171;
}

.lx-sources__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-1, 0.25rem);
  color: var(--colour-text-primary);
  background: transparent;
  border: var(--glass-border);
  border-radius: var(--radius-control, 0.5rem);
  cursor: pointer;
}

.lx-sources__icon-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.lx-sources__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 0.75rem);
  margin: 0;
  padding: 0;
  list-style: none;
}

.lx-sources__item {
  display: flex;
  gap: var(--space-3, 0.75rem);
  padding: var(--space-3, 0.75rem);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.lx-sources__order {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 0.25rem);
  align-items: center;
}

.lx-sources__order-badge {
  font-variant-numeric: tabular-nums;
  color: var(--colour-text-secondary);
}

.lx-sources__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2, 0.5rem);
  min-width: 0;
}

.lx-sources__title-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 0.5rem);
  align-items: baseline;
  justify-content: space-between;
}

.lx-sources__name {
  font-weight: 600;
}

.lx-sources__status {
  padding: 0.1rem var(--space-2, 0.5rem);
  border: var(--glass-border);
  border-radius: 999px;
  font-size: 0.75rem;
  color: var(--colour-text-secondary);
}

.lx-sources__status[data-status='active'] {
  color: var(--colour-accent-strong);
}

.lx-sources__status[data-status='pending_network_approval'] {
  color: var(--colour-warning, #b8860b);
}

.lx-sources__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--space-2, 0.5rem);
  margin: 0;
  font-size: 0.8rem;
}

.lx-sources__meta dt {
  color: var(--colour-text-secondary);
}

.lx-sources__meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.lx-sources__digest {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
}

.lx-sources__origins,
.lx-sources__note,
.lx-sources__preview,
.lx-sources__probe {
  margin: 0;
  color: var(--colour-text-secondary);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.lx-sources__origins--pending,
.lx-sources__probe--bad {
  color: var(--colour-warning, #b8860b);
}

.lx-sources__probe--ok {
  color: var(--colour-accent-strong);
}

.lx-sources__note--update {
  color: var(--colour-accent-strong);
}

.lx-sources__toggle {
  display: inline-flex;
  gap: var(--space-2, 0.5rem);
  align-items: center;
  font-size: 0.85rem;
}

.lx-sources__snapshots {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 0.5rem);
  margin: 0;
  padding: var(--space-2, 0.5rem) 0 0 var(--space-3, 0.75rem);
  list-style: none;
  border-top: var(--glass-border);
}

.lx-sources__snapshots li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 0.5rem);
  align-items: center;
}

.lx-sources__empty {
  margin: 0;
  color: var(--colour-text-secondary);
}

@media (max-width: 640px) {
  .lx-sources__item {
    flex-direction: column;
  }

  .lx-sources__order {
    flex-direction: row;
    justify-content: flex-start;
  }
}
</style>
