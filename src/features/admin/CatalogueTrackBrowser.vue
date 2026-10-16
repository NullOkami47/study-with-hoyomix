<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { AlertTriangle, Check, Pencil, RefreshCw, Save, Search, X } from 'lucide-vue-next'
import type {
  AdminCatalogueTrack,
  AdminCatalogueTrackDetail,
  AdminCatalogueTrackEdit,
  AdminRepository,
  CatalogueGame,
  CatalogueVocalStatus,
} from './client'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
import { normaliseSearchText } from '../catalog/searchText'

const props = defineProps<{ repository: AdminRepository }>()
const { locale } = usePreferences()
const text = (key: string, params?: Record<string, unknown>) =>
  translate(locale.value, ('admin.catalogue.tracks.' + key) as TranslationKey, params)

const PAGE_SIZE = 25
const GAMES: CatalogueGame[] = ['genshin', 'hsr', 'zzz']
const VOCAL_STATUSES: CatalogueVocalStatus[] = ['instrumental', 'vocal', 'uncertain']
const TABS = ['focus', 'sleep', 'chill'] as const
const CANONICAL_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/

const tracks = ref<AdminCatalogueTrack[]>([])
const albums = ref<string[]>([])
const revision = ref(0)
const loaded = ref(false)
const loadError = ref(false)
const query = ref('')
const game = ref<'all' | CatalogueGame>('all')
const album = ref('all')
const page = ref(1)

const selectedId = ref<string>()
const detail = ref<AdminCatalogueTrackDetail>()
const detailLoading = ref(false)
const detailError = ref(false)

const editing = ref(false)
const saving = ref(false)
const saveState = ref<'idle' | 'invalid' | 'empty' | 'stale' | 'failed'>('idle')
const savedAt = ref(0)

/** The editable draft mirrors the server's editable field set exactly. */
interface TrackDraft {
  title: string
  album: string
  release_date: string
  work_group_id: string
  vocal_status: CatalogueVocalStatus
  focus: boolean
  sleep: boolean
  chill: boolean
  needs_classification: boolean
  metadata_confidence: string
  evidence: string
  notes: string
}
const blankDraft = (): TrackDraft => ({
  title: '',
  album: '',
  release_date: '',
  work_group_id: '',
  vocal_status: 'uncertain',
  focus: false,
  sleep: false,
  chill: false,
  needs_classification: false,
  metadata_confidence: '',
  evidence: '',
  notes: '',
})
const draft = ref<TrackDraft>(blankDraft())
const fieldErrors = ref<Record<string, string>>({})

let alive = true

/** Precomputed once per catalogue load, never per keystroke. */
const indexed = computed(() =>
  tracks.value.map((track) => ({
    track,
    haystack: normaliseSearchText(
      [
        track.id,
        track.title,
        track.album ?? '',
        track.workGroupId,
        track.games.join(' '),
        track.tabs.join(' '),
      ].join(' '),
    ),
  })),
)

const filtered = computed(() => {
  const needle = normaliseSearchText(query.value)
  return indexed.value.filter(({ track, haystack }) => {
    if (game.value !== 'all' && !track.games.includes(game.value)) return false
    if (album.value !== 'all' && track.album !== album.value) return false
    return needle.length === 0 || haystack.includes(needle)
  })
})

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const pageRows = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE).map((r) => r.track),
)

watch([query, game, album], () => {
  page.value = 1
})

function summarise(track: AdminCatalogueTrackDetail): AdminCatalogueTrack {
  return {
    id: track.id,
    title: track.title,
    album: track.album,
    releaseDate: track.releaseDate,
    workGroupId: track.workGroupId,
    vocalStatus: track.vocalStatus,
    tabs: track.tabs,
    games: track.games,
    needsClassification: track.needsClassification,
    updatedAt: track.updatedAt,
  }
}

function toDraft(track: AdminCatalogueTrackDetail): TrackDraft {
  return {
    title: track.title,
    album: track.album ?? '',
    release_date: track.releaseDate ?? '',
    work_group_id: track.workGroupId,
    vocal_status: track.vocalStatus,
    focus: track.tabs.includes('focus'),
    sleep: track.tabs.includes('sleep'),
    chill: track.tabs.includes('chill'),
    needs_classification: track.needsClassification,
    metadata_confidence: track.metadataConfidence === null ? '' : String(track.metadataConfidence),
    evidence: track.evidence ?? '',
    notes: track.notes ?? '',
  }
}

async function load() {
  loadError.value = false
  try {
    const index = await props.repository.listCatalogueTracks()
    if (!alive) return
    tracks.value = index.tracks
    albums.value = index.albums
    revision.value = index.revision
    loaded.value = true
  } catch {
    if (alive) loadError.value = true
  }
}

async function select(track: AdminCatalogueTrack) {
  if (saving.value) return
  editing.value = false
  saveState.value = 'idle'
  fieldErrors.value = {}
  selectedId.value = track.id
  detailLoading.value = true
  detailError.value = false
  try {
    const value = await props.repository.getCatalogueTrack(track.id)
    if (!alive) return
    detail.value = value
    draft.value = toDraft(value)
  } catch {
    if (alive) {
      detail.value = undefined
      detailError.value = true
    }
  } finally {
    if (alive) detailLoading.value = false
  }
}

function startEdit() {
  if (!detail.value || saving.value) return
  draft.value = toDraft(detail.value)
  fieldErrors.value = {}
  saveState.value = 'idle'
  editing.value = true
}

function cancelEdit() {
  if (saving.value) return
  editing.value = false
  fieldErrors.value = {}
  saveState.value = 'idle'
  if (detail.value) draft.value = toDraft(detail.value)
}

/** Builds a minimal patch of only-changed fields, mirroring the server's validation. */
function buildEdit(): { edit: AdminCatalogueTrackEdit; errors: Record<string, string> } {
  const current = detail.value
  const errors: Record<string, string> = {}
  const edit: AdminCatalogueTrackEdit = {}
  if (!current) return { edit, errors }

  const draftValue = draft.value

  const title = draftValue.title.trim()
  if (title.length === 0 || title.length > 500) errors.title = 'invalid'
  else if (title !== current.title) edit.title = title

  const albumRaw = draftValue.album.trim()
  if (albumRaw.length > 500) errors.album = 'invalid'
  else if ((albumRaw.length ? albumRaw : null) !== current.album) edit.album = albumRaw.length ? albumRaw : null

  const releaseRaw = draftValue.release_date.trim()
  if (releaseRaw && !/^\d{4}-\d{2}-\d{2}$/.test(releaseRaw)) errors.release_date = 'invalid'
  else if ((releaseRaw.length ? releaseRaw : null) !== current.releaseDate)
    edit.release_date = releaseRaw.length ? releaseRaw : null

  const workGroup = draftValue.work_group_id.trim()
  if (!CANONICAL_ID.test(workGroup)) errors.work_group_id = 'invalid'
  else if (workGroup !== current.workGroupId) edit.work_group_id = workGroup

  const vocal = draftValue.vocal_status
  if (!VOCAL_STATUSES.includes(vocal)) errors.vocal_status = 'invalid'
  else if (vocal !== current.vocalStatus) edit.vocal_status = vocal

  // `focus`/`sleep`/`chill` are independent of `vocal_status`; no combination is rejected here.
  for (const tab of TABS) {
    if (draftValue[tab] !== current.tabs.includes(tab)) edit[tab] = draftValue[tab]
  }

  if (draftValue.needs_classification !== current.needsClassification)
    edit.needs_classification = draftValue.needs_classification

  const confidenceRaw = draftValue.metadata_confidence.trim()
  if (confidenceRaw.length === 0) {
    if (current.metadataConfidence !== null) edit.metadata_confidence = null
  } else {
    const confidence = Number(confidenceRaw)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      errors.metadata_confidence = 'invalid'
    else if (confidence !== current.metadataConfidence) edit.metadata_confidence = confidence
  }

  for (const field of ['evidence', 'notes'] as const) {
    const value = draftValue[field].trim()
    if (value.length > 4000) errors[field] = 'invalid'
    else if ((value.length ? value : null) !== current[field]) edit[field] = value.length ? value : null
  }

  return { edit, errors }
}

async function save() {
  const current = detail.value
  if (!current || saving.value) return
  const { edit, errors } = buildEdit()
  fieldErrors.value = errors
  if (Object.keys(errors).length > 0) {
    saveState.value = 'invalid'
    return
  }
  if (Object.keys(edit).length === 0) {
    saveState.value = 'empty'
    return
  }
  saving.value = true
  saveState.value = 'idle'
  try {
    const result = await props.repository.updateCatalogueTrack(current.id, edit, revision.value)
    if (!alive) return
    revision.value = result.revision
    detail.value = result.track
    draft.value = toDraft(result.track)
    const summary = summarise(result.track)
    tracks.value = tracks.value.map((track) => (track.id === summary.id ? summary : track))
    editing.value = false
    savedAt.value = Date.now()
  } catch (error) {
    if (!alive) return
    saveState.value = String(error).includes('409') ? 'stale' : 'failed'
  } finally {
    if (alive) saving.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section class="track-browser" data-catalogue-track-browser :aria-busy="saving">
    <div class="track-browser__toolbar">
      <label class="track-browser__search">
        <Search :size="15" aria-hidden="true" />
        <span class="track-browser__visually-hidden">{{ text('search') }}</span>
        <input
          v-model="query"
          type="search"
          data-catalogue-track-search
          :placeholder="text('search')"
          autocomplete="off"
        />
      </label>
      <label class="track-browser__field">
        <span>{{ text('game') }}</span>
        <select v-model="game" data-catalogue-track-game>
          <option value="all">{{ text('allGames') }}</option>
          <option v-for="id in GAMES" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <label class="track-browser__field">
        <span>{{ text('album') }}</span>
        <select v-model="album" data-catalogue-track-album>
          <option value="all">{{ text('allAlbums') }}</option>
          <option v-for="name in albums" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <span class="track-browser__count" data-catalogue-track-count>
        {{ text('results', { shown: filtered.length, total: tracks.length }) }}
      </span>
      <button type="button" :disabled="saving" data-catalogue-track-refresh @click="load">
        <RefreshCw :size="15" aria-hidden="true" />
        <span>{{ text('search') }}</span>
      </button>
    </div>

    <p v-if="loadError" class="track-browser__error" role="alert" data-catalogue-track-error>
      {{ text('error') }}
    </p>
    <p v-else-if="!loaded" class="track-browser__muted" role="status" data-catalogue-track-loading>
      {{ text('loading') }}
    </p>

    <div v-else class="track-browser__grid">
      <div class="track-browser__list-pane">
        <p v-if="!filtered.length" class="track-browser__muted" data-catalogue-track-empty>
          {{ text('empty') }}
        </p>
        <ul v-else class="track-browser__list">
          <li v-for="track in pageRows" :key="track.id">
            <button
              type="button"
              class="track-browser__row"
              :class="{ 'track-browser__row--selected': track.id === selectedId }"
              :data-catalogue-track-row="track.id"
              :aria-pressed="track.id === selectedId"
              @click="select(track)"
            >
              <span class="track-browser__row-title">{{ track.title }}</span>
              <code class="track-browser__row-id">{{ track.id }}</code>
              <span class="track-browser__row-meta">
                {{ track.games.join(', ') || '—' }} · {{ track.album || '—' }}
              </span>
            </button>
          </li>
        </ul>
        <div class="track-browser__pager">
          <button
            type="button"
            data-catalogue-track-prev
            :disabled="page <= 1"
            @click="page = Math.max(1, page - 1)"
          >
            {{ text('prev') }}
          </button>
          <span data-catalogue-track-page>{{ page }} / {{ pageCount }}</span>
          <button
            type="button"
            data-catalogue-track-next
            :disabled="page >= pageCount"
            @click="page = Math.min(pageCount, page + 1)"
          >
            {{ text('next') }}
          </button>
        </div>
      </div>

      <div class="track-browser__detail-pane" data-catalogue-track-detail>
        <p v-if="detailLoading" class="track-browser__muted" role="status">{{ text('loading') }}</p>
        <p v-else-if="detailError" class="track-browser__error" role="alert">{{ text('error') }}</p>
        <p v-else-if="!detail" class="track-browser__muted">{{ text('selectPrompt') }}</p>
        <template v-else>
          <header class="track-browser__detail-header">
            <div>
              <h3>{{ detail.title }}</h3>
              <code data-catalogue-track-canonical-id>{{ detail.id }}</code>
            </div>
            <button
              v-if="!editing"
              type="button"
              data-catalogue-track-edit
              :disabled="saving"
              @click="startEdit"
            >
              <Pencil :size="15" aria-hidden="true" />
              <span>{{ text('edit') }}</span>
            </button>
          </header>

          <p v-if="savedAt" class="track-browser__success" role="status" data-catalogue-track-saved>
            <Check :size="15" aria-hidden="true" /> {{ text('saved') }}
          </p>
          <p
            v-if="saveState === 'stale' || saveState === 'failed'"
            class="track-browser__error"
            role="alert"
            data-catalogue-track-save-error
          >
            <AlertTriangle :size="15" aria-hidden="true" />
            {{ saveState === 'stale' ? text('stale') : text('saveError') }}
          </p>
          <p
            v-else-if="saveState === 'invalid' || saveState === 'empty'"
            class="track-browser__error"
            role="alert"
            data-catalogue-track-save-error
          >
            <AlertTriangle :size="15" aria-hidden="true" />
            {{ saveState === 'empty' ? text('noChanges') : text('invalidEdit') }}
          </p>

          <dl class="track-browser__facts">
            <div>
              <dt>{{ text('album') }}</dt>
              <dd>{{ detail.album || '—' }}</dd>
            </div>
            <div>
              <dt>{{ text('releaseDate') }}</dt>
              <dd>{{ detail.releaseDate || '—' }}</dd>
            </div>
            <div>
              <dt>{{ text('tabs') }}</dt>
              <dd>{{ detail.tabs.length ? detail.tabs.join(', ') : text('tabsNone') }}</dd>
            </div>
            <div>
              <dt>{{ text('vocalStatus') }}</dt>
              <dd>{{ text('vocal.' + detail.vocalStatus) }}</dd>
            </div>
            <div>
              <dt>{{ text('games') }}</dt>
              <dd>{{ detail.games.join(', ') || '—' }}</dd>
            </div>
            <div>
              <dt>{{ text('workGroup') }}</dt>
              <dd><code>{{ detail.workGroupId }}</code></dd>
            </div>
            <div>
              <dt>{{ text('metadataConfidence') }}</dt>
              <dd>{{ detail.metadataConfidence === null ? '—' : detail.metadataConfidence }}</dd>
            </div>
            <div>
              <dt>{{ text('needsClassification') }}</dt>
              <dd>{{ detail.needsClassification ? '✓' : '—' }}</dd>
            </div>
            <div>
              <dt>{{ text('relations') }}</dt>
              <dd>{{ detail.relations.length ? detail.relations.join(', ') : '—' }}</dd>
            </div>
            <div>
              <dt>{{ text('aliases') }}</dt>
              <dd>
                {{ Object.entries(detail.aliases).map(([l, v]) => `${l}: ${v.join(' / ')}`).join('; ') || '—' }}
              </dd>
            </div>
            <div>
              <dt>{{ text('evidence') }}</dt>
              <dd>{{ detail.evidence || '—' }}</dd>
            </div>
            <div>
              <dt>{{ text('notes') }}</dt>
              <dd>{{ detail.notes || '—' }}</dd>
            </div>
          </dl>

          <section class="track-browser__sources">
            <h4>{{ text('sources') }}</h4>
            <p v-if="!detail.sources.length" class="track-browser__muted">{{ text('sourcesNone') }}</p>
            <ul v-else>
              <li v-for="source in detail.sources" :key="source.sourceRowId">
                <code>{{ source.provider }}</code>
                <span>{{ source.externalId }}</span>
                <span class="track-browser__source-status">{{ source.sourceStatus }}</span>
              </li>
            </ul>
          </section>

          <form v-if="editing" class="track-browser__editor" @submit.prevent="save">
            <h4>{{ text('detail') }}</h4>
            <div class="track-browser__form-grid">
              <label>
                <span>{{ text('title') }}</span>
                <input v-model="draft.title" type="text" data-catalogue-track-field="title" :disabled="saving" />
              </label>
              <label>
                <span>{{ text('albumField') }}</span>
                <input v-model="draft.album" type="text" data-catalogue-track-field="album" :disabled="saving" />
              </label>
              <label>
                <span>{{ text('releaseDate') }}</span>
                <input
                  v-model="draft.release_date"
                  type="text"
                  placeholder="YYYY-MM-DD"
                  data-catalogue-track-field="release_date"
                  :disabled="saving"
                  :aria-invalid="Boolean(fieldErrors.release_date) || undefined"
                />
              </label>
              <label>
                <span>{{ text('workGroupField') }}</span>
                <input
                  v-model="draft.work_group_id"
                  type="text"
                  data-catalogue-track-field="work_group_id"
                  :disabled="saving"
                  :aria-invalid="Boolean(fieldErrors.work_group_id) || undefined"
                />
              </label>
              <label>
                <span>{{ text('vocalStatus') }}</span>
                <select v-model="draft.vocal_status" data-catalogue-track-field="vocal_status" :disabled="saving">
                  <option v-for="status in VOCAL_STATUSES" :key="status" :value="status">
                    {{ text('vocal.' + status) }}
                  </option>
                </select>
              </label>
              <label>
                <span>{{ text('metadataConfidence') }}</span>
                <input
                  v-model="draft.metadata_confidence"
                  type="text"
                  inputmode="decimal"
                  data-catalogue-track-field="metadata_confidence"
                  :disabled="saving"
                  :aria-invalid="Boolean(fieldErrors.metadata_confidence) || undefined"
                />
              </label>
            </div>
            <fieldset class="track-browser__flags">
              <legend>{{ text('tabs') }}</legend>
              <label v-for="tab in TABS" :key="tab">
                <input
                  v-model="draft[tab]"
                  type="checkbox"
                  :data-catalogue-track-field="tab"
                  :disabled="saving"
                />
                <span>{{ text(tab) }}</span>
              </label>
              <label>
                <input
                  v-model="draft.needs_classification"
                  type="checkbox"
                  data-catalogue-track-field="needs_classification"
                  :disabled="saving"
                />
                <span>{{ text('needsClassification') }}</span>
              </label>
            </fieldset>
            <label class="track-browser__free-text">
              <span>{{ text('evidence') }}</span>
              <textarea
                v-model="draft.evidence"
                rows="2"
                data-catalogue-track-field="evidence"
                :disabled="saving"
              />
            </label>
            <label class="track-browser__free-text">
              <span>{{ text('notes') }}</span>
              <textarea
                v-model="draft.notes"
                rows="2"
                data-catalogue-track-field="notes"
                :disabled="saving"
              />
            </label>
            <div class="track-browser__toolbar">
              <button type="submit" data-catalogue-track-save :disabled="saving">
                <Save :size="15" aria-hidden="true" />
                <span>{{ saving ? text('saving') : text('save') }}</span>
              </button>
              <button type="button" data-catalogue-track-cancel :disabled="saving" @click="cancelEdit">
                <X :size="15" aria-hidden="true" />
                <span>{{ text('cancel') }}</span>
              </button>
            </div>
          </form>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.track-browser {
  display: grid;
  gap: 1rem;
  min-width: 0;
  max-width: 100%;
  color: var(--colour-text-primary);
}
.track-browser__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: end;
}
.track-browser__search {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1 1 16rem;
  padding: 0 0.75rem;
  min-height: 2.5rem;
  border: 1px solid var(--glass-edge);
  border-radius: 0.5rem;
  background: var(--colour-surface-opaque);
}
.track-browser__search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  min-height: 2.25rem;
}
.track-browser__search input:focus-visible {
  outline: none;
}
.track-browser__field {
  display: grid;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}
.track-browser button,
.track-browser select,
.track-browser input,
.track-browser textarea {
  min-height: 2.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--glass-edge);
  border-radius: 0.5rem;
  background: var(--colour-surface-opaque);
  color: var(--colour-text-primary);
  font: inherit;
  font-size: 0.875rem;
  box-sizing: border-box;
  max-width: 100%;
}
.track-browser textarea {
  min-height: 4rem;
  width: 100%;
}
.track-browser button {
  display: inline-flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.track-browser button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.track-browser__count {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
  white-space: nowrap;
}
.track-browser__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 1rem;
  align-items: start;
  min-width: 0;
}
.track-browser__list-pane,
.track-browser__detail-pane {
  border: 1px solid var(--glass-edge);
  border-radius: 0.75rem;
  background: var(--colour-surface-opaque);
  padding: 0.75rem;
  min-width: 0;
  display: grid;
  gap: 0.75rem;
}
.track-browser__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  max-height: 30rem;
  overflow-y: auto;
}
.track-browser__row {
  width: 100%;
  display: grid;
  gap: 2px;
  text-align: left;
  justify-items: start;
  min-height: 0;
}
.track-browser__row--selected {
  border-color: var(--colour-accent);
  background: rgba(255, 255, 255, 0.08);
}
.track-browser__row-title {
  font-weight: 600;
  font-size: 0.875rem;
}
.track-browser__row-id,
.track-browser__source-status {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}
.track-browser__row-meta {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
  overflow-wrap: anywhere;
}
.track-browser__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}
.track-browser__detail-header {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: 0.75rem;
}
.track-browser__detail-header h3 {
  margin: 0 0 4px;
  font-size: 1rem;
}
.track-browser__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: 0.5rem;
  margin: 0;
}
.track-browser__facts dt {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}
.track-browser__facts dd {
  margin: 2px 0 0;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
.track-browser__sources h4,
.track-browser__editor h4 {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}
.track-browser__sources ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  font-size: 0.8125rem;
}
.track-browser__sources li {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}
.track-browser__editor {
  display: grid;
  gap: 0.75rem;
  border-top: 1px solid var(--glass-edge);
  padding-top: 0.75rem;
}
.track-browser__form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: 0.75rem;
}
.track-browser__form-grid label,
.track-browser__free-text {
  display: grid;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}
.track-browser__flags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  border: 1px solid var(--glass-edge);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
}
.track-browser__flags legend {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
  padding: 0 4px;
}
.track-browser__flags label {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  color: var(--colour-text-primary);
}
.track-browser__flags input[type="checkbox"] {
  min-height: 0;
  width: 1rem;
  height: 1rem;
  padding: 0;
  accent-color: var(--colour-accent);
}
.track-browser__muted {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
}
.track-browser__error,
.track-browser__success {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.track-browser__error {
  color: #f87171;
}
.track-browser__success {
  color: #4ade80;
}
.track-browser__visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
@media (max-width: 900px) {
  .track-browser__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
