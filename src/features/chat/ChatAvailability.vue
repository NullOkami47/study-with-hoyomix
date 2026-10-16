<script setup lang="ts">
/**
 * The chat body: what the product can honestly say about chat today. It is content
 * only. The surrounding window owns the title, the close control and the glass, so this
 * component carries no chrome of its own -- and the collapse control it used to own is
 * gone, because a window that can be closed does not also need to be folded.
 *
 * When community chat lands, this is the component it replaces.
 */
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'

const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
</script>

<template>
  <div class="chat-availability" data-chat-availability>
    <p>{{ text('chat.comingLater') }}</p>
  </div>
</template>

<style scoped>
.chat-availability { display: grid; gap: 0.5rem; color: var(--colour-text-primary); }
.chat-availability p { margin: 0; font-size: 0.875rem; line-height: 1.5; }
</style>
