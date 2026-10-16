<script setup lang="ts">
import { translate } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import type { StudyTip } from './studyTips'
defineProps<{ tip: StudyTip }>()
defineEmits<{ (event: 'dismiss'): void }>()
const { locale } = usePreferences()
</script>
<template>
  <article class="study-tip surface-glass" data-study-tip>
    <h3>{{ tip.title }}</h3><p>{{ tip.body }}</p>
    <button data-study-tip-dismiss type="button" @click="$emit('dismiss')">{{ translate(locale, 'studyTips.dismiss') }}</button>
  </article>
</template>
<style scoped>
.study-tip { display: grid; gap: .75rem; padding: 1rem; border-radius: var(--radius-surface); }
.study-tip h3, .study-tip p { margin: 0; }
.study-tip p { color: var(--colour-text-muted); line-height: 1.5; }
.study-tip button { min-height: 2.75rem; padding: .5rem .75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: .5rem; cursor: pointer; }
</style>
