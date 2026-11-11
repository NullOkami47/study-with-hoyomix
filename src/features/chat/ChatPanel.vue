<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowDown,
  Ban,
  Coffee,
  Flag,
  Focus,
  Moon,
  Music,
  Pencil,
  Play,
  Plus,
  Send,
  Smile,
  Sparkles,
  Trash2,
} from 'lucide-vue-next'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { useAccountSession } from '../account/session'
import type { Track } from '../catalog/types'
import {
  createChatClient,
  type ChatClient,
  type ChatMessage,
  type ChatPayload,
} from './client'
const props = withDefaults(
  defineProps<{
    client?: ChatClient
    tracks: Track[]
    currentTrack?: Track
    draft?: string
  }>(),
  { client: undefined, currentTrack: undefined, draft: '' },
)
const emit = defineEmits<{
  (event: 'play', track: Track): void
  (event: 'enqueue', track: Track): void
  (event: 'account'): void
  (event: 'update:draft', value: string): void
}>()
const { locale } = usePreferences(),
  session = useAccountSession()
const text = (key: TranslationKey) => translate(locale.value, key)
const chat = props.client ?? createChatClient({ handshakeTimeoutMs: 30000 })
const {
  announcement,
  messages,
  state,
  viewer,
  participants,
  ownerOnline,
  adminOnline,
  nextCursor,
  loadingHistory,
  blockedUserIds,
} = chat
const draft = ref(props.draft),
  pending = ref(false),
  error = ref(''),
  status = ref(''),
  stickersOpen = ref(false),
  showLocation = ref(false),
  editing = ref<string>(),
  savedDraft = ref('')
const list = ref<HTMLElement>(),
  nearBottom = ref(true),
  unseen = ref(false),
  historyMoving = ref(false)
const reportTarget = ref<string>(),
  reportReason = ref(''),
  composer = ref<HTMLTextAreaElement>()
const stickers = [
  { id: 'tea', icon: Coffee, key: 'chat.stickerTea' },
  { id: 'focus', icon: Focus, key: 'chat.stickerFocus' },
  { id: 'cheer', icon: Sparkles, key: 'chat.stickerCheer' },
  { id: 'rest', icon: Moon, key: 'chat.stickerRest' },
] as const
const draftLength = computed(() => [...draft.value.normalize('NFKC').trim()].length)
const validDraft = computed(() => draftLength.value <= 500)
const canPost = computed(
  () => Boolean(viewer.value) && state.value === 'connected' && !pending.value,
)
const isModerator = computed(() =>
  ['owner', 'admin', 'moderator'].includes(viewer.value?.role ?? ''),
)
const track = (id?: string | null) => props.tracks.find((t) => t.id === id)
const sticker = (id?: string | null) => stickers.find((s) => s.id === id)
function country(value: string | null) {
  if (!value || !/^([A-Z]{2})$/.test(value)) return text('chat.unknownLocation')
  try {
    return (
      new Intl.DisplayNames([locale.value], { type: 'region' }).of(value) ??
      text('chat.unknownLocation')
    )
  } catch {
    return text('chat.unknownLocation')
  }
}
function time(value: string) {
  try {
    return new Intl.DateTimeFormat(
      locale.value === 'en' ? 'en-GB' : locale.value,
      {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      },
    ).format(new Date(value))
  } catch {
    return ''
  }
}
function role(value: string) {
  const key = (
    {
      owner: 'chat.roleOwner',
      admin: 'chat.roleAdmin',
      moderator: 'chat.roleModerator',
    } as Record<string, TranslationKey>
  )[value]
  return key ? text(key) : ''
}
function onScroll() {
  const el = list.value
  if (el) {
    nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64
    if (nearBottom.value) unseen.value = false
  }
}
function latest() {
  const el = list.value
  if (el) el.scrollTop = el.scrollHeight
  nearBottom.value = true
  unseen.value = false
}
watch(draft, (value) => emit('update:draft', value))
watch(
  () => messages.value,
  async () => {
    if (historyMoving.value) return
    const follow = nearBottom.value
    await nextTick()
    if (follow) latest()
    else unseen.value = true
  },
  { deep: true },
)
async function older() {
  const el = list.value
  if (!el) return
  const height = el.scrollHeight,
    top = el.scrollTop
  historyMoving.value = true
  try {
    await chat.loadOlder()
    await nextTick()
    el.scrollTop = top + el.scrollHeight - height
  } catch {
    error.value = text('chat.errorUnavailable')
  } finally {
    historyMoving.value = false
  }
}
function failure(value: unknown) {
  const code = value instanceof Error ? value.message : ''
  error.value = text(
    code === 'rate_limited'
      ? 'chat.errorRate'
      : ['unauthorised', 'unauthorized', 'authentication_required', 'stale_session'].includes(code)
        ? 'chat.errorSession'
        : code === 'banned' || code === 'chat_banned'
          ? 'chat.errorBanned'
          : code === 'edit_limit'
            ? 'chat.errorEditLimit'
            : code === 'edit_window_expired'
              ? 'chat.errorEditExpired'
              : code === 'invalid_text' || code === 'invalid_request'
                ? 'chat.errorInvalid'
                : 'chat.errorUnavailable',
  )
}
async function action(task: () => Promise<unknown>) {
  error.value = ''
  status.value = ''
  try {
    await task()
  } catch (value) {
    failure(value)
  }
}
async function send(payload?: ChatPayload) {
  if (!canPost.value) return
  const value = draft.value
  if (!payload && (!value.trim() || !validDraft.value)) return
  pending.value = true
  error.value = ''
  try {
    if (editing.value) {
      await chat.edit(editing.value, value)
      editing.value = undefined
      draft.value = savedDraft.value
    } else {
      await chat.send(
        payload ?? {
          type: 'text',
          text: value,
          showLocation: showLocation.value,
        },
      )
      if (!payload && draft.value === value) draft.value = ''
    }
    stickersOpen.value = false
    await nextTick()
    latest()
  } catch (value) {
    failure(value)
  } finally {
    pending.value = false
  }
}
function keydown(event: KeyboardEvent) {
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault()
    void send()
  }
}
function editable(message: ChatMessage) {
  return (
    message.userId === viewer.value?.userId &&
    Date.now() - Date.parse(message.createdAt) <= 300000
  )
}
function edit(message: ChatMessage) {
  if (!editing.value) savedDraft.value = draft.value
  editing.value = message.id
  draft.value = message.content
  void nextTick(() => composer.value?.focus())
}
function cancelEdit() {
  editing.value = undefined
  draft.value = savedDraft.value
}
async function report() {
  if (!reportTarget.value || !reportReason.value.trim()) return
  const id = reportTarget.value
  await action(async () => {
    await chat.report(id, reportReason.value)
    reportTarget.value = undefined
    reportReason.value = ''
    status.value = text('chat.reportSent')
  })
}
let accountIdentity = `${session.signedIn.value}:${session.userId.value ?? ''}`
watch(session.revision, () => {
  const identity = `${session.signedIn.value}:${session.userId.value ?? ''}`
  // Periodic verified-session refreshes do not change the transport's account.
  // The Worker separately revalidates revoked sessions and role changes.
  if (identity === accountIdentity) return
  accountIdentity = identity
  chat.restart()
}, { flush: 'sync' })
onMounted(() => {
  chat.start()
  void session.ensure()
})
onBeforeUnmount(() => {
  emit('update:draft', editing.value ? savedDraft.value : draft.value)
  chat.stop()
})
</script>

<template>
  <div class="chat-panel" data-chat-panel>
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{
      announcement
    }}</span>
    <div class="chat-panel__presence" data-chat-presence>
      <a v-if="isModerator" href="/admin#admin-chat">{{
        text('chat.moderation')
      }}</a>
      <span role="status" :data-chat-connection="state"
        ><i
          :class="{ 'is-connected': state === 'connected' }"
          aria-hidden="true"
        />{{
          text(
            state === 'connected'
              ? 'chat.connected'
              : state === 'connecting'
                ? 'chat.connecting'
                : 'chat.disconnected',
          )
        }}</span
      >
      <span>{{ participants }} {{ text('chat.participants') }}</span>
      <span v-if="ownerOnline">{{ text('chat.ownerOnline') }}</span
      ><span v-else-if="adminOnline">{{ text('chat.adminOnline') }}</span>
    </div>
    <div
      ref="list"
      class="chat-panel__messages"
      data-chat-log
      :aria-label="text('chat.messages')"
      @scroll.passive="onScroll"
    >
      <button
        v-if="nextCursor"
        type="button"
        data-chat-history
        :disabled="loadingHistory"
        @click="older"
      >
        {{ text(loadingHistory ? 'chat.loadingHistory' : 'chat.loadOlder') }}
      </button>
      <p v-if="!messages.length" class="chat-panel__empty">
        {{ text('chat.empty') }}
      </p>
      <article
        v-for="message in messages"
        :key="message.id"
        class="chat-message"
        :class="{ 'chat-message--own': message.userId === viewer?.userId }"
        :data-chat-message="message.id"
      >
        <div class="chat-message__avatar" aria-hidden="true">
          {{ (message.displayName || text('chat.deletedUser')).slice(0, 1) }}
        </div>
        <div class="chat-message__body">
          <div class="chat-message__meta">
            <strong>{{
              message.displayName || text('chat.deletedUser')
            }}</strong
            ><span v-if="role(message.role)" class="chat-message__role">{{
              role(message.role)
            }}</span
            ><span v-if="message.location">{{ country(message.location) }}</span
            ><time :datetime="message.createdAt">{{
              time(message.createdAt)
            }}</time
            ><span v-if="message.updatedAt">{{ text('chat.edited') }}</span>
          </div>
          <div v-if="message.type === 'sticker'" class="chat-message__sticker">
            <component
              :is="sticker(message.stickerId)?.icon ?? Smile"
              :size="32"
              aria-hidden="true"
            /><span>{{
              sticker(message.stickerId)
                ? text(sticker(message.stickerId)!.key)
                : text('chat.stickerUnknown')
            }}</span>
          </div>
          <div v-else-if="message.type === 'track'" class="chat-track">
            <Music :size="22" aria-hidden="true" />
            <div>
              <strong>{{
                track(message.trackId)?.title ?? text('chat.trackUnavailable')
              }}</strong>
              <p v-if="track(message.trackId)">
                {{
                  track(message.trackId)
                    ?.games.map((game) =>
                      text(('game.' + game) as TranslationKey),
                    )
                    .join(' · ')
                }}<span v-if="track(message.trackId)?.album">
                  · {{ track(message.trackId)?.album }}</span
                >
              </p>
            </div>
            <div v-if="track(message.trackId)" class="chat-track__actions">
              <button
                type="button"
                :aria-label="text('chat.playTrack')"
                @click="emit('play', track(message.trackId)!)"
              >
                <Play :size="16" aria-hidden="true" />{{
                  text('chat.playTrack')
                }}</button
              ><button
                type="button"
                :aria-label="text('chat.queueTrack')"
                @click="emit('enqueue', track(message.trackId)!)"
              >
                <Plus :size="16" aria-hidden="true" />{{
                  text('chat.queueTrack')
                }}
              </button>
            </div>
          </div>
          <p v-else class="chat-message__content">{{ message.content }}</p>
          <div v-if="viewer" class="chat-message__actions">
            <button
              v-if="editable(message) && message.type === 'text'"
              type="button"
              :data-chat-edit="message.id"
              :aria-label="text('chat.edit')"
              @click="edit(message)"
            >
              <Pencil :size="14" aria-hidden="true" />
            </button>
            <button
              v-if="editable(message)"
              type="button"
              :data-chat-delete="message.id"
              :aria-label="text('chat.delete')"
              @click="action(() => chat.remove(message.id))"
            >
              <Trash2 :size="14" aria-hidden="true" />
            </button>
            <template v-if="message.userId && message.userId !== viewer.userId"
              ><button
                type="button"
                :aria-label="text('chat.report')"
                @click="reportTarget = message.id"
              >
                <Flag :size="14" aria-hidden="true" /></button
              ><button
                type="button"
                :aria-label="text('chat.block')"
                @click="action(() => chat.block(message.userId!))"
              >
                <Ban :size="14" aria-hidden="true" /></button
            ></template>
          </div>
        </div>
      </article>
    </div>
    <button
      v-if="unseen || !nearBottom"
      type="button"
      class="chat-panel__jump"
      data-chat-jump-latest
      @click="latest"
    >
      <ArrowDown :size="14" aria-hidden="true" />{{ text('chat.jumpLatest') }}
    </button>
    <p v-if="error" class="chat-panel__status" role="alert">{{ error }}</p>
    <p v-if="status" class="chat-panel__status" role="status">{{ status }}</p>
    <form
      v-if="reportTarget"
      class="chat-panel__report"
      @submit.prevent="report"
    >
      <label
        >{{ text('chat.reportReason')
        }}<input v-model="reportReason" maxlength="500" required /></label
      ><button type="submit">{{ text('chat.report') }}</button
      ><button type="button" @click="reportTarget = undefined">
        {{ text('chat.cancel') }}
      </button>
    </form>
    <details v-if="blockedUserIds.length" class="chat-panel__blocks">
      <summary>
        {{ text('chat.blockedUsers') }} ({{ blockedUserIds.length }})
      </summary>
      <button
        v-for="(id, index) in blockedUserIds"
        :key="id"
        type="button"
        @click="action(() => chat.block(id, false))"
      >
        {{ text('chat.unblock') }} {{ index + 1 }}
      </button>
    </details>
    <form v-if="viewer" class="chat-panel__composer" @submit.prevent="send()">
      <div v-if="editing" class="chat-panel__editing">
        {{ text('chat.editing')
        }}<button type="button" data-chat-cancel-edit @click="cancelEdit">
          {{ text('chat.cancel') }}
        </button>
      </div>
      <label class="sr-only" for="chat-composer">{{
        text('chat.messageLabel')
      }}</label
      ><textarea
        id="chat-composer"
        ref="composer"
        v-model="draft"
        data-chat-composer
        rows="2"
        :placeholder="text('chat.placeholder')"
        :disabled="pending"
        :aria-invalid="!validDraft || undefined"
        aria-describedby="chat-composer-validation"
        @keydown="keydown"
      />
      <p id="chat-composer-validation" data-chat-validation class="chat-panel__validation" :role="!validDraft ? 'alert' : undefined">{{ translate(locale, 'chat.characterCount', { count: draftLength }) }}<span v-if="!validDraft"> {{ text('chat.errorInvalid') }}</span></p>
      <div v-if="stickersOpen" class="chat-panel__stickers">
        <button
          v-for="item in stickers"
          :key="item.id"
          type="button"
          :data-chat-sticker="item.id"
          :disabled="!canPost"
          @click="
            send({
              type: 'sticker',
              text: '',
              stickerId: item.id,
              showLocation,
            })
          "
        >
          <component :is="item.icon" :size="24" aria-hidden="true" />{{
            text(item.key)
          }}
        </button>
      </div>
      <div class="chat-panel__tools">
        <button
          type="button"
          data-chat-stickers
          :aria-label="text('chat.stickers')"
          :aria-expanded="stickersOpen"
          :disabled="!canPost || Boolean(editing)"
          @click="stickersOpen = !stickersOpen"
        >
          <Smile :size="18" aria-hidden="true" /></button
        ><button
          type="button"
          data-chat-share-track
          :aria-label="text('chat.shareTrack')"
          :disabled="!canPost || !currentTrack || Boolean(editing)"
          @click="
            send({
              type: 'track',
              text: '',
              trackId: currentTrack!.id,
              showLocation,
            })
          "
        >
          <Music :size="18" aria-hidden="true" /></button
        ><label class="chat-panel__location"
          ><input v-model="showLocation" type="checkbox" />{{
            text('chat.showLocation')
          }}</label
        ><button
          type="submit"
          data-chat-send
          :aria-label="text(editing ? 'chat.save' : 'chat.send')"
          :disabled="!canPost || !draft.trim() || !validDraft"
        >
          <Send :size="18" aria-hidden="true" /><span class="sr-only">{{
            text(editing ? 'chat.save' : 'chat.send')
          }}</span>
        </button>
      </div>
    </form>
    <div v-else class="chat-panel__signin">
      <p>{{ text('chat.signInRequired') }}</p>
      <button type="button" @click="emit('account')">
        {{ text('chat.signIn') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: 0.5rem;
  color: var(--colour-text-primary);
  font-size: 0.8125rem;
  line-height: 1.5;
}
.chat-panel button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-width: 2.75rem;
  min-height: 2.75rem;
  padding: 0.375rem 0.625rem;
  color: var(--colour-text-primary);
  background: transparent;
  border: var(--glass-border);
  border-radius: var(--radius-control);
  font: inherit;
  cursor: pointer;
  transition:
    filter var(--motion-duration),
    transform var(--motion-duration);
}
.chat-panel button:hover:not(:disabled) {
  background: var(--colour-surface-opaque);
  filter: var(--control-hover-filter);
}
.chat-panel button:active:not(:disabled) {
  transform: scale(0.96);
}
.chat-panel button:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-panel :is(button, input, textarea, summary):focus-visible {
  outline: 2px solid var(--colour-focus);
  box-shadow: var(--focus-ring);
  outline-offset: 2px;
}
.chat-panel__presence {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem 0.75rem;
  color: var(--colour-text-muted);
  font-size: 0.75rem;
}
.chat-panel__presence a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  color: var(--colour-accent);
}
.chat-panel__presence > span:first-child {
  display: inline-flex;
  gap: 0.375rem;
  align-items: center;
}
.chat-panel__presence i {
  display: inline-block;
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  background: var(--colour-text-muted);
}
.chat-panel__presence .is-connected {
  background: var(--colour-accent);
}
.chat-panel__messages {
  flex: 1 1 auto;
  min-height: 3rem;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
  scrollbar-gutter: stable;
  padding-inline-end: 0.25rem;
}
.chat-panel__empty {
  color: var(--colour-text-muted);
  text-align: center;
  padding-block: 1rem;
}
.chat-message {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding-block: 0.5rem;
  border-block-end: 1px solid var(--liquid-separator);
}
.chat-message__avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 1.75rem;
  height: 1.75rem;
  border: var(--glass-border);
  border-radius: var(--radius-control);
  background: var(--colour-surface-opaque);
  font-weight: 600;
}
.chat-message--own .chat-message__avatar {
  color: var(--colour-accent);
}
.chat-message__body {
  flex: 1;
  min-width: 0;
}
.chat-message__meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
  font-size: 0.6875rem;
  color: var(--colour-text-muted);
}
.chat-message__meta strong {
  color: var(--colour-text-primary);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
.chat-message__role {
  border: var(--glass-border);
  border-radius: var(--radius-control);
  padding-inline: 0.25rem;
}
.chat-message__content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0.25rem 0;
}
.chat-message__actions {
  display: flex;
  justify-content: flex-end;
}
.chat-message__actions button {
  border: 0;
}
.chat-message__sticker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  color: var(--colour-accent);
}
.chat-track {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-control);
  padding: 0.625rem;
  margin-block: 0.375rem;
}
.chat-track > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.chat-track p {
  color: var(--colour-text-muted);
  font-size: 0.75rem;
  margin: 0.25rem 0;
}
.chat-track__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.chat-panel__composer {
  flex: none;
  border-block-start: var(--glass-border);
  padding-block-start: 0.5rem;
}
.chat-panel__validation { margin: 0; color: var(--colour-text-muted); font-size: .75rem; line-height: 1.5; overflow-wrap: anywhere; }
.chat-panel textarea,
.chat-panel__report input {
  box-sizing: border-box;
  width: 100%;
  max-height: 6rem;
  min-height: 2.75rem;
  resize: vertical;
  font: inherit;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-control);
  padding: 0.5rem;
}
.chat-panel__tools {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.chat-panel__tools > button {
  border: 0;
  flex: none;
}
.chat-panel__tools > button:last-child {
  margin-inline-start: auto;
}
.chat-panel__location {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 2.75rem;
  font-size: 0.6875rem;
  color: var(--colour-text-muted);
}
.chat-panel__location input {
  margin: 0;
}
.chat-panel__stickers {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.chat-panel__stickers button {
  flex: 1;
  flex-direction: column;
  font-size: 0.6875rem;
}
.chat-panel__status {
  margin: 0;
  color: var(--colour-text-muted);
  overflow-wrap: anywhere;
}
.chat-panel__signin {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  border-block-start: var(--glass-border);
  padding-block-start: 0.5rem;
}
.chat-panel__signin p {
  flex: 1;
  margin: 0;
  color: var(--colour-text-muted);
}
.chat-panel__report {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.chat-panel__report label {
  width: 100%;
}
.chat-panel__editing {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--colour-text-muted);
}
.chat-panel__blocks {
  max-height: 6rem;
  overflow: auto;
  color: var(--colour-text-muted);
}
.chat-panel__blocks summary {
  min-height: 2.75rem;
  cursor: pointer;
}
.chat-panel__jump {
  align-self: center;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-height: 450px) {
  .chat-panel__messages { min-height: 0; }
  .chat-panel textarea {
    max-height: 2.75rem;
  }
  .chat-panel__presence {
    font-size: 0.6875rem;
  }
  .chat-panel {
    gap: 0.25rem;
  }
}
</style>
