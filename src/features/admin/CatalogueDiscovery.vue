<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Search,
  RefreshCw,
  Check,
  AlertTriangle,
  Pencil,
  Save,
} from 'lucide-vue-next'
import type {
  AdminRepository,
  AdminDiscoveryStatus,
  AdminDiscoveryCandidate,
} from './client'
import AdminStatusChip from './primitives/AdminStatusChip.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
const props = defineProps<{ repository: AdminRepository }>()
const { locale } = usePreferences()
const text = (key: string) =>
  translate(
    locale.value,
    ('admin.catalogue.discovery.' + key) as TranslationKey,
  )
const status = ref<AdminDiscoveryStatus>()
const busy = ref(false)
const error = ref('')
const editing = ref<string>()
const draft = ref('')
const importText = ref('')
const importMode = ref<'manifest' | 'suggestions'>('manifest')
const resolutionTracks = ref<Record<string, string>>({})
const resolutionReasons = ref<Record<string, string>>({})
const rows = computed(() => status.value?.candidates ?? [])
async function load() {
  status.value = await props.repository.getDiscoveryStatus()
  resolutionTracks.value = {}
  resolutionReasons.value = {}
}
async function run(action: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
    await load()
  } catch (failure) {
    error.value = translate(locale.value, 'admin.catalogue.error')
    try {
      await load()
    } catch {}
  } finally {
    busy.value = false
  }
}
async function more() {
  if (!status.value?.nextCursor) return
  busy.value = true
  try {
    const next = await props.repository.getDiscoveryStatus(
      status.value.nextCursor,
    )
    status.value = {
      ...next,
      candidates: [...status.value.candidates, ...next.candidates],
    }
  } catch {
    error.value = translate(locale.value, 'admin.catalogue.error')
  } finally {
    busy.value = false
  }
}
onMounted(() => run(load))
function ready(c: AdminDiscoveryCandidate) {
  return (
    c.classificationReviewed &&
    !c.conflicts.length &&
    !c.suggestion.uncertainties.length &&
    c.suggestion.vocal_status !== 'uncertain' &&
    c.stageState !== 'uncertain' &&
    c.sources.some(
      (s) =>
        s.status === 'valid' &&
        ['gd-studio', 'chksz', 'lx-huibq', 'lx-ikun'].includes(s.provider) &&
        Date.now() - s.checkedAt >= 0 &&
        Date.now() - s.checkedAt < 30 * 60 * 1000,
    ) &&
    status.value?.sheetsConfigured
  )
}
function edit(c: AdminDiscoveryCandidate) {
  editing.value = c.id
  draft.value = JSON.stringify(c.suggestion, null, 2)
}
async function save(c: AdminDiscoveryCandidate) {
  await run(async () => {
    const suggestion = JSON.parse(draft.value)
    await props.repository.updateDiscoveryCandidate(
      c.id,
      { suggestion },
      c.revision,
    )
    editing.value = undefined
  })
}
async function resolveIdentity(c: AdminDiscoveryCandidate) {
  const reason = resolutionReasons.value[c.id]?.trim()
  if (!reason) return
  const trackId = resolutionTracks.value[c.id]?.trim() || c.id
  await run(async () => {
    await props.repository.resolveDiscoveryCandidate(
      c.id,
      c.revision,
      trackId,
      reason,
    )
    delete resolutionTracks.value[c.id]
    delete resolutionReasons.value[c.id]
  })
}
async function importArtifact() {
  await run(async () => {
    const payload = JSON.parse(importText.value)
    if (importMode.value === 'manifest')
      await props.repository.importDiscoveryManifest(payload)
    else {
      // Preserve the artefact's revision so the server can reject stale AI output.
      await props.repository.importDiscoverySuggestions(payload)
    }
    importText.value = ''
  })
}
const when = (n: number) =>
  new Date(n).toLocaleString(locale.value === 'en' ? 'en-GB' : locale.value)
</script>
<template>
  <section
    class="catalogue-discovery"
    :aria-label="text('title')"
    data-catalogue-discovery
  >
    <header class="catalogue-discovery__header">
      <div>
        <h3>{{ text('title') }}</h3>
        <p>{{ text('subtitle') }}</p>
      </div>
      <button
        type="button"
        data-discovery-scan
        :disabled="busy || !status?.configured"
        @click="run(() => repository.scanDiscovery())"
      >
        <Search :size="16" aria-hidden="true" />{{
          busy ? text('scanning') : text('scan')
        }}
      </button>
    </header>
    <details class="catalogue-discovery__import">
      <summary>
        {{
          locale === 'en'
            ? 'Import scanner or AI artefact'
            : locale === 'zh-Hans'
              ? '导入扫描或 AI 文件'
              : '匯入掃描或 AI 檔案'
        }}
      </summary>
      <label for="discovery-import-mode">{{
        locale === 'en'
          ? 'Artefact type'
          : locale === 'zh-Hans'
            ? '文件类型'
            : '檔案類型'
      }}</label
      ><select id="discovery-import-mode" v-model="importMode">
        <option value="manifest">
          {{
            locale === 'en'
              ? 'Scanner manifest'
              : locale === 'zh-Hans'
                ? '扫描结果'
                : '掃描結果'
          }}
        </option>
        <option value="suggestions">
          {{ locale === 'en' ? 'AI suggestions' : 'AI 建議' }}
        </option></select
      ><label for="discovery-import-json">JSON</label
      ><textarea
        id="discovery-import-json"
        v-model="importText"
        data-discovery-import-json
        rows="5"
        spellcheck="false"
        :disabled="busy"
      /><button
        type="button"
        data-discovery-import
        :disabled="busy || !importText.trim()"
        @click="importArtifact"
      >
        {{
          locale === 'en'
            ? 'Import for review'
            : locale === 'zh-Hans'
              ? '导入待审'
              : '匯入待審'
        }}
      </button>
    </details>
    <p v-if="error" role="alert" class="catalogue-discovery__error">
      {{ error }}
    </p>
    <p v-if="status && !status.configured" role="status">
      {{
        locale === 'en'
          ? 'Configure official channel IDs on the server before scanning.'
          : locale === 'zh-Hans'
            ? '请先在服务器设置官方频道 ID。'
            : '請先在伺服器設定官方頻道 ID。'
      }}
    </p>
    <div v-if="status" class="catalogue-discovery__adapters">
      <span>{{ text('adapters') }}</span
      ><span v-for="adapter in status.adapters" :key="adapter.id"
        ><AdminStatusChip
          :variant="adapter.available ? 'success' : 'neutral'"
          size="sm"
          >{{ adapter.id }}</AdminStatusChip
        ><small v-if="!adapter.available">
          {{ text('manualOnly') }}</small
        ></span
      >
    </div>
    <p v-if="status && !rows.length">{{ text('noCandidates') }}</p>
    <article
      v-for="candidate in rows"
      :key="candidate.id"
      class="catalogue-discovery__candidate"
      :data-discovery-candidate="candidate.id"
    >
      <div class="catalogue-discovery__identity">
        <div>
          <h4>{{ candidate.discovery.title }}</h4>
          <p>{{ candidate.suggestion.album }}</p>
          <small>{{ candidate.trackId }}</small>
        </div>
        <AdminStatusChip
          :variant="
            candidate.conflicts.length
              ? 'danger'
              : ready(candidate)
                ? 'success'
                : 'warning'
          "
          size="sm"
          >{{
            Math.round(candidate.suggestion.confidence * 100)
          }}%</AdminStatusChip
        >
      </div>
      <dl class="catalogue-discovery__metadata">
        <div>
          <dt>{{ locale === 'en' ? 'Games' : '遊戲' }}</dt>
          <dd>{{ candidate.suggestion.games.join(', ') }}</dd>
        </div>
        <div>
          <dt>{{ locale === 'en' ? 'Listening' : '聆聽分類' }}</dt>
          <dd>
            {{ candidate.suggestion.vocal_status }} ·
            {{ candidate.suggestion.tabs.join(', ') || '—' }}
          </dd>
        </div>
      </dl>
      <ul class="catalogue-discovery__reasons">
        <li v-for="reason in candidate.suggestion.reasons" :key="reason">
          {{ reason }}
        </li>
      </ul>
      <p
        v-if="candidate.suggestion.uncertainties.length"
        class="catalogue-discovery__warning"
      >
        <AlertTriangle :size="16" aria-hidden="true" />{{ text('uncertain') }}:
        {{ candidate.suggestion.uncertainties.join(', ') }}
      </p>
      <p
        v-for="conflict in candidate.conflicts"
        :key="conflict"
        class="catalogue-discovery__error"
      >
        {{ text('conflict') }}: {{ conflict }}
      </p>
      <div class="catalogue-discovery__sources">
        <h5>{{ text('source') }}</h5>
        <ul>
          <li
            v-for="source in candidate.sources"
            :key="source.provider + source.externalId"
          >
            <AdminStatusChip
              :variant="
                source.status === 'valid'
                  ? 'success'
                  : source.status === 'invalid'
                    ? 'danger'
                    : 'neutral'
              "
              size="sm"
              >{{ source.provider }} · {{ source.status }}</AdminStatusChip
            ><code>{{ source.externalId || '—' }}</code
            ><small>{{ source.reason }}</small>
          </li>
        </ul>
      </div>
      <details class="catalogue-discovery__evidence">
        <summary>{{ locale === 'en' ? 'Evidence' : '證據' }}</summary>
        <ul>
          <li v-for="evidence in candidate.suggestion.evidence" :key="evidence">
            {{ evidence }}
          </li>
        </ul>
      </details>
      <details
        v-if="candidate.conflicts.length"
        class="catalogue-discovery__editor"
      >
        <summary>
          {{
            locale === 'en'
              ? 'Resolve recording identity'
              : locale === 'zh-Hans'
                ? '确认录音身份'
                : '確認錄音身分'
          }}
        </summary>
        <label :for="'identity-target-' + candidate.id">{{
          locale === 'en'
            ? 'Existing canonical ID (leave blank for a distinct recording)'
            : '既有 canonical ID（不同錄音請留白）'
        }}</label>
        <input
          :id="'identity-target-' + candidate.id"
          v-model="resolutionTracks[candidate.id]"
          :disabled="busy"
        />
        <label :for="'identity-reason-' + candidate.id">{{
          locale === 'en' ? 'Evidence and reason' : '證據與理由'
        }}</label>
        <input
          :id="'identity-reason-' + candidate.id"
          v-model="resolutionReasons[candidate.id]"
          :disabled="busy"
        />
        <button
          type="button"
          :disabled="busy || !resolutionReasons[candidate.id]?.trim()"
          @click="resolveIdentity(candidate)"
        >
          {{ locale === 'en' ? 'Record identity decision' : '記錄身分判定' }}
        </button>
      </details>
      <div v-if="candidate.stageState === 'uncertain'" role="status">
        <p>
          {{
            locale === 'en'
              ? 'Staging response is uncertain. Reconcile existing rows before any further change.'
              : '暫存回應不明，請先對帳既有資料再進行變更。'
          }}
        </p>
        <button
          type="button"
          data-discovery-reconcile
          :disabled="busy"
          @click="
            run(() =>
              repository.reconcileDiscoveryCandidate(
                candidate.id,
                candidate.revision,
                status!.catalogueRevision,
              ),
            )
          "
        >
          {{ locale === 'en' ? 'Reconcile staging' : '暫存對帳' }}
        </button>
      </div>
      <div v-if="editing === candidate.id" class="catalogue-discovery__editor">
        <label :for="'discovery-suggestion-' + candidate.id"
          >{{ text('edit') }} JSON</label
        ><textarea
          :id="'discovery-suggestion-' + candidate.id"
          v-model="draft"
          rows="12"
          spellcheck="false"
          :disabled="busy"
        /><button
          type="button"
          data-discovery-save
          :disabled="busy"
          @click="save(candidate)"
        >
          <Save :size="16" aria-hidden="true" />{{ text('save') }}
        </button>
      </div>
      <div class="catalogue-discovery__actions">
        <button
          type="button"
          data-discovery-edit
          :disabled="busy || candidate.stageState === 'uncertain'"
          @click="edit(candidate)"
        >
          <Pencil :size="16" aria-hidden="true" />{{ text('edit') }}</button
        ><button
          type="button"
          data-discovery-check
          :disabled="busy"
          @click="
            run(() =>
              repository.checkDiscoveryCandidate(
                candidate.id,
                candidate.revision,
              ),
            )
          "
        >
          <RefreshCw :size="16" aria-hidden="true" />{{ text('check') }}</button
        ><button
          type="button"
          data-discovery-stage
          :disabled="
            busy || !ready(candidate) || candidate.stageState === 'staged'
          "
          @click="
            run(() =>
              repository.stageDiscoveryCandidate(
                candidate.id,
                candidate.revision,
                status!.catalogueRevision,
              ),
            )
          "
        >
          <Check :size="16" aria-hidden="true" />{{ text('stage') }}
        </button>
      </div>
      <p v-if="candidate.stageState === 'staged'" role="status">
        {{ text('staged') }}
      </p>
    </article>
    <button
      v-if="status?.nextCursor"
      type="button"
      data-discovery-more
      :disabled="busy"
      @click="more"
    >
      {{
        locale === 'en'
          ? 'More candidates'
          : locale === 'zh-Hans'
            ? '更多候选'
            : '更多候選'
      }}
    </button>
    <details v-if="status?.runs.length" class="catalogue-discovery__runs" open>
      <summary>{{ text('runs') }}</summary>
      <ol>
        <li v-for="run in status.runs" :key="run.runId">
          <strong>{{ run.runId }}</strong
          ><span>{{ when(run.createdAt) }}</span
          ><span
            >{{ run.outcome }} · {{ run.added }} / {{ run.discovered }}</span
          >
        </li>
      </ol>
    </details>
  </section>
</template>
<style scoped>
.catalogue-discovery {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}
.catalogue-discovery__header,
.catalogue-discovery__identity {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.catalogue-discovery h3,
.catalogue-discovery h4,
.catalogue-discovery h5,
.catalogue-discovery p {
  margin: 0;
}
.catalogue-discovery__header p,
.catalogue-discovery small,
.catalogue-discovery dt {
  color: var(--colour-text-muted);
}
.catalogue-discovery__candidate {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  padding: 1rem;
  border: 1px solid var(--glass-edge, rgba(255, 255, 255, 0.12));
  border-radius: var(--radius-control, 12px);
  background: var(--colour-surface-glass, rgba(255, 255, 255, 0.04));
  min-width: 0;
}
.catalogue-discovery__metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 0;
}
.catalogue-discovery dd {
  margin: 0;
}
.catalogue-discovery__adapters,
.catalogue-discovery__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.catalogue-discovery button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-control, 10px);
  border: 1px solid var(--glass-edge, rgba(255, 255, 255, 0.12));
  background: var(--colour-surface-glass, rgba(255, 255, 255, 0.06));
  color: var(--colour-text-primary);
  cursor: pointer;
}
.catalogue-discovery button:disabled {
  opacity: 0.5;
  cursor: default;
}
.catalogue-discovery button:focus-visible,
.catalogue-discovery textarea:focus-visible,
.catalogue-discovery summary:focus-visible {
  outline: 2px solid var(--colour-accent);
  outline-offset: 3px;
}
.catalogue-discovery__sources ul,
.catalogue-discovery__runs ol {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-left: 0;
  list-style: none;
  margin: 0.5rem 0 0;
}
.catalogue-discovery__sources li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.catalogue-discovery code,
.catalogue-discovery small,
.catalogue-discovery li {
  overflow-wrap: anywhere;
}
.catalogue-discovery__warning {
  display: flex;
  gap: 0.4rem;
  align-items: flex-start;
  color: var(--colour-warning, #f5cd76);
}
.catalogue-discovery__error {
  color: var(--colour-danger, #fda4af);
}
.catalogue-discovery__import {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.catalogue-discovery__editor {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}
.catalogue-discovery input,
.catalogue-discovery select {
  min-height: 44px;
  padding: 0.5rem;
  border: 1px solid var(--glass-edge, rgba(255, 255, 255, 0.12));
  border-radius: var(--radius-control, 10px);
  background: var(--colour-surface-glass);
  color: var(--colour-text-primary);
  max-width: 100%;
  box-sizing: border-box;
}
.catalogue-discovery textarea {
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--radius-control, 10px);
  padding: 0.75rem;
  background: var(--colour-surface-glass, rgba(0, 0, 0, 0.2));
  color: var(--colour-text-primary);
  border: 1px solid var(--glass-edge, rgba(255, 255, 255, 0.12));
  font: inherit;
}
.catalogue-discovery summary {
  min-height: 44px;
  cursor: pointer;
  display: flex;
  align-items: center;
}
.catalogue-discovery__runs li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--glass-edge, rgba(255, 255, 255, 0.12));
}
@media (max-width: 640px) {
  .catalogue-discovery__actions button {
    flex: 1;
  }
  .catalogue-discovery__header > button {
    width: 100%;
  }
  .catalogue-discovery__candidate {
    padding: 0.8rem;
  }
}
</style>
