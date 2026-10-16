<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import {
  getDefaultNoticeCentreStore, resolveNoticeText,
  type NoticeCentreStore, type NoticeSeverity, type VisibleNotice,
} from './noticeCentre'

const props = defineProps<{ store?: NoticeCentreStore }>()
const store = props.store ?? getDefaultNoticeCentreStore()
const { locale } = usePreferences()
const text = (key: TranslationKey) => translate(locale.value, key)
const notices = shallowRef<readonly VisibleNotice[]>([])
const severityKeys: Record<NoticeSeverity, TranslationKey> = {
  info: 'notices.severity.info',
  warning: 'notices.severity.warning',
  critical: 'notices.severity.critical',
}
const sync = () => { notices.value = store.allNotices() }
let unsubscribe: (() => void) | undefined
onMounted(() => {
  // Revalidate current publication and viewer eligibility before reopening history.
  // This clears cached notices and in-flight responses while retaining dismissals.
  store.invalidateSession()
  unsubscribe = store.subscribe(sync)
  void store.refresh().then(sync)
})
onBeforeUnmount(() => { unsubscribe?.() })
</script>

<template>
  <section class="notice-history" data-settings-notice-history aria-labelledby="settings-notices-heading">
    <h4 id="settings-notices-heading">{{ text('settings.application.noticesTitle') }}</h4>
    <p>{{ text('settings.application.noticesDescription') }}</p>
    <p v-if="notices.length === 0" data-settings-notices-empty>{{ text('settings.application.noticesEmpty') }}</p>
    <div v-else class="notice-history__list">
      <article v-for="notice in notices" :key="notice.revisionId" class="notice-history__item surface-glass"
        :data-settings-notice="notice.id" :data-severity="notice.severity">
        <strong>{{ text(severityKeys[notice.severity]) }}</strong>
        <p>{{ resolveNoticeText(notice.content, locale) }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.notice-history { display: grid; gap: .75rem; border-top: var(--glass-border); padding-top: .75rem; }
.notice-history h4, .notice-history p { margin: 0; }
.notice-history > p { color: var(--colour-text-muted); font-size: .875rem; }
.notice-history__list { display: grid; gap: .5rem; }
.notice-history__item { display: grid; gap: .375rem; padding: .75rem; border: var(--glass-border); border-radius: var(--radius-surface); }
.notice-history__item[data-severity='critical'] { border-color: color-mix(in srgb, #f87171 55%, transparent); }
.notice-history__item[data-severity='warning'] { border-color: color-mix(in srgb, #fbbf24 50%, transparent); }
.notice-history__item strong { font-size: .8rem; }
.notice-history__item p { color: var(--colour-text-primary); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
</style>
