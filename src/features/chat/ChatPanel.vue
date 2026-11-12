<script setup lang="ts">
/**
 * The chat log and composer.
 *
 * Message grouping, replies with quotes, the unread "jump to latest" control, automatic
 * history loading and scroll restoration follow the chat room of StudyWithMiku
 * (https://github.com/shshouse/StudyWithMiku, GPL-3.0, by shshouse). They are reimplemented
 * here for this project's Worker protocol, three locales and Liquid Glass styling.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowDown,
  Ban,
  Coffee,
  CornerUpLeft,
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
  X,
} from 'lucide-vue-next'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { safeLocalStorage } from '../../utils/safeStorage'
import { useAccountSession } from '../account/session'
import type { Track } from '../catalog/types'
import {
  CHAT_MESSAGE_LIMIT,
  createChatClient,
  replyTextLimit,
  type ChatClient,
  type ChatMessage,
  type ChatPayload,
} from './client'
import { avatarHue, avatarInitial, groupChatMessages, truncateSummary } from './chatThread'
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
const text = (key: TranslationKey, params?: Record<string, unknown>) => translate(locale.value, key, params)
const chat = props.client ?? createChatClient({ handshakeTimeoutMs: 30000 })
const {
  announcement,
  messages,
  state,
  viewer,
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
  savedDraft = ref(''),
  replyingTo = ref<ChatMessage>(),
  actionsOpen = ref<string>(),
  highlighted = ref<string>()
const list = ref<HTMLElement>(),
  nearBottom = ref(true),
  historyMoving = ref(false),
  lastSeenId = ref<string>(),
  positioned = ref(false)
const reportTarget = ref<string>(),
  reportReason = ref(''),
  composer = ref<HTMLTextAreaElement>()
const stickers = [
  { id: 'tea', icon: Coffee, key: 'chat.stickerTea' },
  { id: 'focus', icon: Focus, key: 'chat.stickerFocus' },
  { id: 'cheer', icon: Sparkles, key: 'chat.stickerCheer' },
  { id: 'rest', icon: Moon, key: 'chat.stickerRest' },
] as const
/** Remembers where the reader was, so reopening chat does not throw them to the bottom. */
const READING_STORAGE_KEY = 'study-with-hoyomix.chat-reading.v1'
const READING_MAX_AGE_MS = 24 * 60 * 60_000
const BOTTOM_THRESHOLD = 64
const HISTORY_TRIGGER = 60

const groups = computed(() => groupChatMessages(messages.value))
const byId = computed(() => new Map(messages.value.map((message) => [message.id, message])))
const characterLimit = computed(() => {
  const replyId = editing.value
    ? byId.value.get(editing.value)?.replyToId
    : replyingTo.value?.id
  return replyId ? replyTextLimit(replyId) : CHAT_MESSAGE_LIMIT
})
const draftLength = computed(() => [...draft.value.normalize('NFKC').trim()].length)
const validDraft = computed(() => draftLength.value <= characterLimit.value)
const canPost = computed(
  () => Boolean(viewer.value) && state.value === 'connected' && !pending.value,
)
/** Messages after the last one the reader has seen, excluding their own. */
const unreadCount = computed(() => {
  if (nearBottom.value || !lastSeenId.value) return 0
  const index = messages.value.findIndex((message) => message.id === lastSeenId.value)
  if (index < 0) return 0
  return messages.value
    .slice(index + 1)
    .filter((message) => !message.userId || message.userId !== viewer.value?.userId).length
})
const track = (id?: string | null) => props.tracks.find((t) => t.id === id)
const sticker = (id?: string | null) => stickers.find((s) => s.id === id)
const authorName = (message: ChatMessage) => message.displayName || text('chat.deletedUser')
const own = (message: ChatMessage) => Boolean(message.userId) && message.userId === viewer.value?.userId
const avatarStyle = (message: ChatMessage) => ({
  '--chat-avatar-hue': String(avatarHue(message.userId ?? message.displayName ?? '')),
})
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
function formatPart(value: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat(locale.value === 'en' ? 'en-GB' : locale.value, options).format(new Date(value))
  } catch {
    return ''
  }
}
const datePart = (value: string) => formatPart(value, { month: 'short', day: 'numeric' })
const timePart = (value: string) => formatPart(value, { hour: '2-digit', minute: '2-digit' })
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
function summary(message: ChatMessage) {
  if (message.type === 'sticker') return text('chat.summarySticker')
  if (message.type === 'track') {
    return text('chat.summaryTrack', { title: track(message.trackId)?.title ?? '' }).trim()
  }
  return truncateSummary(message.content)
}
function messageElements(): HTMLElement[] {
  return [...(list.value?.querySelectorAll<HTMLElement>('[data-chat-message]') ?? [])]
}
function indexOf(id?: string) {
  return id ? messages.value.findIndex((message) => message.id === id) : -1
}
/** The seen marker only moves forward, so reading back through history never inflates unread. */
function markSeen(id?: string) {
  if (id && indexOf(id) > indexOf(lastSeenId.value)) lastSeenId.value = id
}
function markVisibleSeen() {
  const el = list.value
  if (!el) return
  const bottom = el.getBoundingClientRect().bottom
  let visible: string | undefined
  for (const item of messageElements()) {
    if (item.getBoundingClientRect().top < bottom) visible = item.dataset.chatMessage
  }
  markSeen(visible)
}
function readingPosition() {
  const el = list.value
  if (!el) return undefined
  const anchor = messageElements().find((item) => item.offsetTop + item.offsetHeight > el.scrollTop)
  return {
    atBottom: nearBottom.value,
    anchorId: anchor?.dataset.chatMessage,
    anchorOffset: anchor ? anchor.offsetTop - el.scrollTop : 0,
    lastSeenId: lastSeenId.value,
    savedAt: Date.now(),
  }
}
function saveReadingPosition() {
  if (!positioned.value) return
  const position = readingPosition()
  if (position) safeLocalStorage.setItem(READING_STORAGE_KEY, JSON.stringify(position))
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveReadingPosition, 300)
}
/** Older pages fetched at most while looking for a remembered position, 50 messages each. */
const RESTORE_HISTORY_PAGES = 6
let restoring = false
async function restoreReadingPosition() {
  if (restoring || positioned.value) return
  restoring = true
  try {
    await restoreFromStorage()
  } finally {
    restoring = false
    positioned.value = true
  }
}
async function restoreFromStorage() {
  const el = list.value
  let saved: { atBottom?: unknown; anchorId?: unknown; anchorOffset?: unknown; lastSeenId?: unknown; savedAt?: unknown } | undefined
  try {
    saved = JSON.parse(safeLocalStorage.getItem(READING_STORAGE_KEY) ?? 'null') ?? undefined
  } catch {
    saved = undefined
  }
  const fresh = saved && typeof saved.savedAt === 'number' && Date.now() - saved.savedAt < READING_MAX_AGE_MS
  const anchorId = fresh && !saved!.atBottom && typeof saved!.anchorId === 'string' ? saved!.anchorId : undefined
  const findAnchor = () => anchorId ? messageElements().find((item) => item.dataset.chatMessage === anchorId) : undefined
  let anchor = findAnchor()
  // The snapshot holds only the latest page. A reader who was further back is brought
  // back by loading older pages until the message is found or history runs out.
  for (let page = 0; anchorId && !anchor && nextCursor.value && page < RESTORE_HISTORY_PAGES; page += 1) {
    historyMoving.value = true
    try {
      await chat.loadOlder()
    } catch {
      break
    } finally {
      historyMoving.value = false
    }
    await nextTick()
    anchor = findAnchor()
  }
  if (el && anchor) {
    el.scrollTop = anchor.offsetTop - (Number(saved!.anchorOffset) || 0)
    onScroll()
    lastSeenId.value = typeof saved!.lastSeenId === 'string' && indexOf(saved!.lastSeenId) >= 0
      ? saved!.lastSeenId
      : anchor.dataset.chatMessage
    markVisibleSeen()
    return
  }
  latest()
}
function onScroll() {
  const el = list.value
  if (!el) return
  const previousTop = lastScrollTop
  lastScrollTop = el.scrollTop
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD
  if (nearBottom.value) markSeen(messages.value.at(-1)?.id)
  else markVisibleSeen()
  scheduleSave()
  // Reaching the top while scrolling upwards loads the previous page, as the button does.
  if (positioned.value && el.scrollTop <= HISTORY_TRIGGER && el.scrollTop < previousTop &&
    nextCursor.value && !loadingHistory.value && !historyMoving.value) void older()
}
let lastScrollTop = Number.POSITIVE_INFINITY
function latest() {
  const el = list.value
  if (el) el.scrollTop = el.scrollHeight
  nearBottom.value = true
  markSeen(messages.value.at(-1)?.id)
}
function smoothLatest() {
  const el = list.value
  if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  latest()
}
watch(draft, (value) => emit('update:draft', value))
// An empty room has no position to restore; later messages then follow the live edge.
watch(state, (value) => {
  if (value === 'connected' && !messages.value.length) positioned.value = true
})
watch(
  () => messages.value,
  async () => {
    if (historyMoving.value) return
    const follow = nearBottom.value
    await nextTick()
    if (!positioned.value) {
      if (messages.value.length) restoreReadingPosition()
      return
    }
    if (follow) latest()
    if (replyingTo.value && !byId.value.has(replyingTo.value.id)) replyingTo.value = undefined
  },
  { deep: true },
)
async function older() {
  const el = list.value
  if (!el) return
  const height = el.scrollHeight,
    top = el.scrollTop
  positioned.value = true
  historyMoving.value = true
  try {
    await chat.loadOlder()
    await nextTick()
    // Keep the message the reader was looking at still: older ones are added above it.
    el.scrollTop = top + el.scrollHeight - height
    lastScrollTop = el.scrollTop
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
              : code === 'reply_not_found' || code === 'invalid_reply'
                ? 'chat.errorReplyMissing'
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
      const reply = payload ? undefined : replyingTo.value?.id
      await chat.send(
        payload ?? {
          type: 'text',
          text: value,
          showLocation: showLocation.value,
          ...(reply ? { replyToId: reply } : {}),
        },
      )
      if (!payload && draft.value === value) draft.value = ''
      if (!payload) replyingTo.value = undefined
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
  if (event.key === 'Escape' && (replyingTo.value || editing.value)) {
    // Leave the reply or edit first; a second Escape reaches the window.
    event.preventDefault()
    event.stopPropagation()
    if (editing.value) cancelEdit()
    else cancelReply()
    return
  }
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
  replyingTo.value = undefined
  editing.value = message.id
  draft.value = message.content
  void nextTick(() => composer.value?.focus())
}
function cancelEdit() {
  editing.value = undefined
  draft.value = savedDraft.value
}
function reply(message: ChatMessage) {
  replyingTo.value = message
  actionsOpen.value = undefined
  stickersOpen.value = false
  void nextTick(() => composer.value?.focus())
}
function cancelReply() {
  replyingTo.value = undefined
  void nextTick(() => composer.value?.focus())
}
let highlightTimer: ReturnType<typeof setTimeout> | undefined
function showOriginal(id: string) {
  const target = messageElements().find((item) => item.dataset.chatMessage === id)
  if (!target) return
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  highlighted.value = id
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlighted.value = undefined }, 1600)
}
/** Touch screens have no hover, so a tap on a message reveals its actions instead. */
function toggleActions(event: MouseEvent, id: string) {
  if ((event.target as Element | null)?.closest('button, a, input, textarea')) return
  actionsOpen.value = actionsOpen.value === id ? undefined : id
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
  if (messages.value.length) void nextTick(restoreReadingPosition)
})
onBeforeUnmount(() => {
  clearTimeout(saveTimer)
  clearTimeout(highlightTimer)
  saveReadingPosition()
  emit('update:draft', editing.value ? savedDraft.value : draft.value)
  chat.stop()
})
</script>

<template>
  <div class="chat-panel" data-chat-panel :data-chat-connection="state">
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{
      announcement
    }}</span>
    <p v-if="state === 'connecting'" class="chat-panel__status" data-chat-connecting role="status">{{ text('chat.connecting') }}</p>
    <p v-if="state === 'disconnected'" class="chat-panel__status" role="alert">{{ text('chat.disconnected') }}</p>
    <div class="chat-panel__log">
      <div
        ref="list"
        class="chat-panel__messages"
        data-chat-log
        :aria-label="text('chat.messages')"
        @scroll.passive="onScroll"
      >
        <div class="chat-panel__history">
          <button
            v-if="nextCursor"
            type="button"
            data-chat-history
            :disabled="loadingHistory"
            @click="older"
          >
            {{ text(loadingHistory ? 'chat.loadingHistory' : 'chat.loadOlder') }}
          </button>
          <span v-else-if="messages.length" data-chat-history-end>{{ text('chat.historyEnd') }}</span>
        </div>
        <p v-if="!messages.length" class="chat-panel__empty">
          {{ text('chat.empty') }}
        </p>
        <section
          v-for="group in groups"
          :key="group.key"
          class="chat-group"
          :class="{ 'chat-group--own': own(group.messages[0]!) }"
          data-chat-group
        >
          <div
            class="chat-group__avatar"
            :style="avatarStyle(group.messages[0]!)"
            data-chat-avatar
            aria-hidden="true"
          >{{ avatarInitial(authorName(group.messages[0]!)) }}</div>
          <div class="chat-group__body">
            <div class="chat-group__meta">
              <strong class="chat-group__name">{{ authorName(group.messages[0]!) }}</strong
              ><span v-if="role(group.messages[0]!.role)" class="chat-group__role">{{
                role(group.messages[0]!.role)
              }}</span
              ><span v-if="group.messages[0]!.location" class="chat-group__location">{{ country(group.messages[0]!.location) }}</span
              ><time class="chat-group__time" :datetime="group.messages[0]!.createdAt"
                ><span class="chat-group__date">{{ datePart(group.messages[0]!.createdAt) }} </span>{{ timePart(group.messages[0]!.createdAt) }}</time>
            </div>
            <article
              v-for="message in group.messages"
              :key="message.id"
              class="chat-message"
              :class="{
                'chat-message--own': own(message),
                'chat-message--actions-open': actionsOpen === message.id,
                'chat-message--highlighted': highlighted === message.id,
              }"
              :data-chat-message="message.id"
              @click="toggleActions($event, message.id)"
            >
              <button
                v-if="message.replyToId && byId.get(message.replyToId)"
                type="button"
                class="chat-message__quote"
                :data-chat-quote="message.replyToId"
                :aria-label="text('chat.jumpToOriginal', { name: authorName(byId.get(message.replyToId)!) })"
                @click="showOriginal(message.replyToId)"
              >
                <strong>{{ authorName(byId.get(message.replyToId)!) }}</strong>
                <span>{{ summary(byId.get(message.replyToId)!) }}</span>
              </button>
              <p
                v-else-if="message.replyToId"
                class="chat-message__quote chat-message__quote--missing"
                :data-chat-quote="message.replyToId"
              >{{ text('chat.replyUnavailable') }}</p>
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
              <p v-else class="chat-message__content">{{ message.content }}<span v-if="message.updatedAt" class="chat-message__edited"> · {{ text('chat.edited') }}</span></p>
              <div v-if="viewer" class="chat-message__actions" role="group" :aria-label="text('chat.messageActions')">
                <button
                  type="button"
                  :data-chat-reply="message.id"
                  :aria-label="text('chat.replyTo', { name: authorName(message) })"
                  :disabled="!canPost || Boolean(editing)"
                  @click="reply(message)"
                >
                  <CornerUpLeft :size="14" aria-hidden="true" />
                </button>
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
            </article>
          </div>
        </section>
      </div>
      <Transition name="chat-jump">
        <button
          v-if="!nearBottom"
          type="button"
          class="chat-panel__jump"
          data-chat-jump-latest
          :data-chat-unread="unreadCount || undefined"
          :aria-label="unreadCount ? text('chat.newMessages', { count: Math.min(unreadCount, 99) }) : text('chat.jumpLatest')"
          @click="smoothLatest"
        >
          <span v-if="unreadCount" class="chat-panel__badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
          <ArrowDown v-else :size="16" aria-hidden="true" />
        </button>
      </Transition>
    </div>
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
      <div v-else-if="replyingTo" class="chat-panel__replying" data-chat-replying>
        <CornerUpLeft :size="14" aria-hidden="true" />
        <span class="chat-panel__replying-text"
          ><strong>{{ text('chat.replyingTo', { name: authorName(replyingTo) }) }}</strong
          >{{ summary(replyingTo) }}</span
        >
        <button
          type="button"
          data-chat-cancel-reply
          :aria-label="text('chat.cancelReply')"
          @click="cancelReply"
        >
          <X :size="14" aria-hidden="true" />
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
      <p id="chat-composer-validation" data-chat-validation class="chat-panel__validation" :role="!validDraft ? 'alert' : undefined">{{ characterLimit === CHAT_MESSAGE_LIMIT ? text('chat.characterCount', { count: draftLength }) : text('chat.characterLimit', { count: draftLength, limit: characterLimit }) }}<span v-if="!validDraft"> {{ text('chat.errorInvalid') }}</span></p>
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
    <div v-else-if="state !== 'connecting' || !session.signedIn.value" class="chat-panel__signin">
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
  gap: 0.375rem;
  color: var(--colour-text-primary);
  font-size: 0.9375rem;
  line-height: 1.55;
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
    transform var(--motion-duration),
    opacity var(--motion-duration);
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
.chat-panel__log {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 3rem;
}
.chat-panel__messages {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
  scrollbar-gutter: stable;
  padding-inline-end: 0.25rem;
}
.chat-panel__history {
  display: flex;
  justify-content: center;
  padding-block: 0.25rem;
  color: var(--colour-text-muted);
  font-size: 0.75rem;
}
.chat-panel__history button {
  border: 0;
  font-size: 0.8125rem;
}
.chat-panel__empty {
  color: var(--colour-text-muted);
  text-align: center;
  padding-block: 1rem;
}
.chat-group {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding-block: 0.375rem;
}
.chat-group--own {
  flex-direction: row-reverse;
}
.chat-group__avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 2rem;
  height: 2rem;
  margin-block-start: 0.125rem;
  color: #fff;
  /* A tinted glass disc rather than a flat chip, so it sits inside the Liquid Glass surface. */
  background:
    radial-gradient(circle at 30% 25%, rgb(255 255 255 / 30%), transparent 60%),
    hsl(var(--chat-avatar-hue) 62% 48% / 72%);
  border: 1px solid hsl(var(--chat-avatar-hue) 80% 78% / 45%);
  border-radius: 50%;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 25%), 0 2px 8px rgb(0 0 0 / 22%);
  font-size: 0.875rem;
  font-weight: 600;
  text-shadow: 0 1px 2px rgb(0 0 0 / 35%);
}
.chat-group__body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  flex: 1;
  min-width: 0;
  gap: 0.25rem;
  container-type: inline-size;
}
.chat-group--own .chat-group__body {
  align-items: flex-end;
}
.chat-group__meta {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  max-width: 100%;
  overflow: hidden;
  font-size: 0.8125rem;
  white-space: nowrap;
  color: var(--colour-text-muted);
}
.chat-group--own .chat-group__meta {
  flex-direction: row-reverse;
}
.chat-group__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--colour-text-primary);
  font-size: 0.9375rem;
}
.chat-group__role {
  flex: none;
  border: var(--glass-border);
  border-radius: var(--radius-control);
  padding-inline: 0.25rem;
}
.chat-group__location,
.chat-group__time {
  flex: none;
}
/* Narrow windows drop the least useful metadata first: the date, then the region. */
@container (max-width: 16rem) {
  .chat-group__date { display: none; }
}
@container (max-width: 12rem) {
  .chat-group__location { display: none; }
}
.chat-message {
  position: relative;
  max-width: min(100%, 34rem);
  padding: 0.4375rem 0.6875rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.25rem 1rem 1rem 1rem;
  transition: box-shadow var(--motion-duration), background var(--motion-duration);
}
.chat-message + .chat-message {
  border-start-start-radius: 0.25rem;
}
.chat-message--own {
  background: color-mix(in srgb, var(--colour-accent) 22%, var(--colour-surface-opaque));
  border-radius: 1rem 0.25rem 1rem 1rem;
}
.chat-message--highlighted {
  box-shadow: 0 0 0 2px var(--colour-accent);
}
.chat-panel .chat-message__quote {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  width: 100%;
  min-height: 0;
  margin-block-end: 0.25rem;
  padding: 0.25rem 0.5rem;
  text-align: start;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--colour-text-muted);
  background: rgb(255 255 255 / 6%);
  border: 0;
  border-inline-start: 3px solid var(--colour-accent);
  border-radius: 0.375rem;
  overflow-wrap: anywhere;
}
.chat-message__quote strong {
  color: var(--colour-text-primary);
  font-weight: 600;
}
.chat-message__quote--missing {
  margin: 0 0 0.25rem;
  font-style: italic;
}
.chat-message__content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
}
.chat-message__edited {
  color: var(--colour-text-muted);
  font-size: 0.75rem;
}
.chat-message__actions {
  position: absolute;
  inset-block-start: -1.25rem;
  inset-inline-end: 0.25rem;
  z-index: 1;
  display: flex;
  gap: 0.125rem;
  padding: 0.125rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 999px;
  backdrop-filter: blur(12px);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-duration);
}
.chat-message--own .chat-message__actions {
  inset-inline: 0.25rem auto;
}
.chat-message__actions button {
  min-width: 2.25rem;
  min-height: 2.25rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
}
/* Pointer devices reveal actions on hover; keyboard users reach them through focus. */
@media (hover: hover) {
  .chat-message:hover .chat-message__actions,
  .chat-message:focus-within .chat-message__actions {
    opacity: 1;
    pointer-events: auto;
  }
}
/*
 * Touch screens reveal them with a tap on the message, with full-size targets. Until then they
 * are visually clipped but stay in the focus order, so an external keyboard or switch control
 * reaches them, and focus reveals the row exactly as a tap does.
 */
@media (hover: none) {
  .chat-message__actions {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .chat-message--actions-open .chat-message__actions,
  .chat-message:focus-within .chat-message__actions {
    width: auto;
    height: auto;
    overflow: visible;
    clip-path: none;
    white-space: normal;
    position: static;
    display: flex;
    justify-content: flex-end;
    margin-block-start: 0.25rem;
    opacity: 1;
    pointer-events: auto;
    background: transparent;
    border: 0;
    backdrop-filter: none;
  }
  .chat-message--actions-open .chat-message__actions button,
  .chat-message:focus-within .chat-message__actions button {
    min-width: 2.75rem;
    min-height: 2.75rem;
  }
}
.chat-message__sticker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
  color: var(--colour-accent);
}
.chat-track {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
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
.chat-panel .chat-panel__jump {
  position: absolute;
  inset-block-end: 0.5rem;
  inset-inline-end: 0.75rem;
  z-index: 2;
  width: 2.75rem;
  height: 2.75rem;
  padding: 0;
  border-radius: 50%;
  background: var(--colour-surface-opaque);
  backdrop-filter: blur(14px);
  box-shadow: 0 6px 18px rgb(0 0 0 / 30%);
}
.chat-panel__badge {
  display: grid;
  place-items: center;
  min-width: 1.5rem;
  height: 1.5rem;
  padding-inline: 0.3rem;
  color: #fff;
  background: var(--colour-accent);
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
}
.chat-jump-enter-active,
.chat-jump-leave-active {
  transition: opacity var(--motion-duration), transform var(--motion-duration);
}
.chat-jump-enter-from,
.chat-jump-leave-to {
  opacity: 0;
  transform: translateY(0.5rem);
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
  font-size: 1rem;
  line-height: 1.45;
  padding: 0.625rem;
}
.chat-panel__replying {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-block-end: 0.375rem;
  padding-inline-start: 0.5rem;
  color: var(--colour-text-muted);
  border-inline-start: 3px solid var(--colour-accent);
  font-size: 0.8125rem;
}
.chat-panel__replying-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-panel__replying-text strong {
  margin-inline-end: 0.375rem;
  color: var(--colour-text-primary);
}
.chat-panel__replying button {
  flex: none;
  border: 0;
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
  .chat-panel__log { min-height: 0; }
  .chat-panel textarea {
    max-height: 2.75rem;
  }
  .chat-panel {
    gap: 0.25rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat-jump-enter-active,
  .chat-jump-leave-active { transition-duration: 0ms; }
}
</style>
