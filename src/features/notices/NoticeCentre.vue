<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, nextTick } from 'vue'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import {
  getDefaultNoticeCentreStore,
  resolveNoticeText,
  type NoticeCentreStore,
  type NoticeSeverity,
  type VisibleNotice,
} from './noticeCentre'

const props = defineProps<{ store?: NoticeCentreStore }>()

const store = props.store ?? getDefaultNoticeCentreStore()
const { locale } = usePreferences()
const notices = shallowRef<readonly VisibleNotice[]>(store.visibleNotices())

/** Notice elements by revision, so focus never depends on selector escaping. */
const items = new Map<string, HTMLElement>()

const registerItem = (revisionId: string, element: unknown): void => {
  if (element instanceof HTMLElement) items.set(revisionId, element)
  else items.delete(revisionId)
}

const text = (key: TranslationKey) => translate(locale.value, key)

const SEVERITY_LABEL: Record<NoticeSeverity, TranslationKey> = {
  info: 'notices.severity.info',
  warning: 'notices.severity.warning',
  critical: 'notices.severity.critical',
}

const noticeText = (notice: VisibleNotice): string =>
  resolveNoticeText(notice.content, locale.value) ?? ''

/**
 * A critical notice interrupts with `alert`; lower severities announce
 * politely as a status so ambient notices never talk over the player.
 */
const noticeRole = (severity: NoticeSeverity): 'alert' | 'status' =>
  severity === 'critical' ? 'alert' : 'status'

const sync = (): void => {
  notices.value = store.visibleNotices()
}

/**
 * Dismissing removes the focused element, so focus moves to the notice that
 * takes its place. When none remains the region unmounts and focus falls back
 * to the document rather than being trapped on a detached node.
 */
const dismiss = async (notice: VisibleNotice): Promise<void> => {
  const index = notices.value.findIndex((entry) => entry.revisionId === notice.revisionId)
  store.dismiss(notice.revisionId)
  items.delete(notice.revisionId)
  await nextTick()
  const next = notices.value[index] ?? notices.value[index - 1]
  if (!next) return
  items.get(next.revisionId)?.focus()
}

const onKeydown = (event: KeyboardEvent, notice: VisibleNotice): void => {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  void dismiss(notice)
}

let unsubscribe: (() => void) | undefined

onMounted(() => {
  unsubscribe = store.subscribe(sync)
  void store.refresh().then(sync)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = undefined
})
</script>

<template>
  <section
    v-if="notices.length > 0"
    class="notice-centre"
    data-notice-centre
    role="region"
    aria-live="polite"
    :aria-label="text('notices.region')"
  >
    <article
      v-for="notice in notices"
      :key="notice.revisionId"
      :ref="(element) => registerItem(notice.revisionId, element)"
      class="notice-centre__item surface-glass"
      :data-notice="notice.id"
      :data-notice-severity="notice.severity"
      :role="noticeRole(notice.severity)"
      tabindex="-1"
      @keydown="onKeydown($event, notice)"
    >
      <p class="notice-centre__severity" data-notice-severity-label>
        {{ text(SEVERITY_LABEL[notice.severity]) }}
      </p>
      <p class="notice-centre__body">{{ noticeText(notice) }}</p>
      <button
        class="notice-centre__dismiss"
        :data-notice-dismiss="notice.revisionId"
        type="button"
        :aria-label="text('notices.dismiss')"
        @click="void dismiss(notice)"
      >
        {{ text('notices.dismissShort') }}
      </button>
    </article>
  </section>
</template>

<style scoped>
.notice-centre { position: fixed; top: 1rem; left: 50%; z-index: 1003; display: grid; width: min(32rem, calc(100vw - 2rem)); gap: .5rem; transform: translateX(-50%); }
.notice-centre__item { display: grid; gap: .375rem; padding: .875rem 1rem; border-radius: var(--radius-surface); }
.notice-centre__item[data-notice-severity='critical'] { border: 1px solid color-mix(in srgb, #f87171 60%, transparent); }
.notice-centre__item[data-notice-severity='warning'] { border: 1px solid color-mix(in srgb, #fbbf24 55%, transparent); }
.notice-centre__item:focus-visible { outline: 2px solid var(--colour-text-primary); outline-offset: 2px; }
.notice-centre__severity { margin: 0; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--colour-text-muted); }
.notice-centre__body { margin: 0; color: var(--colour-text-primary); line-height: 1.5; }
.notice-centre__dismiss { justify-self: end; min-height: 2.75rem; padding: .5rem .75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: .5rem; cursor: pointer; transition: filter var(--motion-duration) ease; }
.notice-centre__dismiss:hover { filter: var(--control-hover-filter); }
</style>
