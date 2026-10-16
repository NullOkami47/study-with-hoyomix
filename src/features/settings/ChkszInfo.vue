<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { Info } from 'lucide-vue-next'
import type { Locale } from '../../i18n'
import { agreementCopy } from './thirdPartyAgreement'
const props = defineProps<{ locale: Locale }>()
const copy = computed(() => agreementCopy[props.locale])
const open = ref(false)
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const panel = ref<HTMLElement>()
const id = useId()
async function toggle(): Promise<void> {
  open.value = !open.value
  if (open.value) { await nextTick(); panel.value?.focus() }
}
function close(restore = false): void {
  open.value = false
  if (restore) trigger.value?.focus()
}
function keydown(event: KeyboardEvent): void {
  if (open.value && event.key === 'Escape') {
    event.stopPropagation()
    event.preventDefault()
    close(true)
  }
}
function outside(event: Event): void {
  if (open.value && event.target instanceof Node && !root.value?.contains(event.target)) close()
}
onMounted(() => {
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('focusin', outside)
})
</script>
<template>
  <span ref="root" class="chksz-info">
    <button ref="trigger" type="button" data-settings-chksz-info :aria-label="copy.info" :aria-expanded="open" :aria-controls="open ? id : undefined" aria-haspopup="dialog" @click="toggle"><Info :size="16" aria-hidden="true" /></button>
    <span v-if="open" :id="id" ref="panel" class="chksz-info__panel liquid-popover" role="dialog" :aria-label="copy.info" tabindex="-1" data-settings-chksz-info-panel>
      <strong>{{ copy.info }}</strong>
      <span>{{ copy.infoIntro }}</span>
      <a href="https://api.chksz.com/" target="_blank" rel="noopener noreferrer">api.chksz.com</a>
      <span>{{ copy.infoPrivacy }}</span>
      <button type="button" @click="close(true)">{{ copy.close }}</button>
    </span>
  </span>
</template>
<style scoped>
.chksz-info { position: relative; display: inline-flex; vertical-align: middle; }
.chksz-info > button { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; }
.chksz-info__panel { position: fixed; z-index: 5; inset-inline: 2rem; top: 20vh; display: grid; gap: var(--liquid-space); max-width: 36rem; margin-inline: auto; max-height: 60vh; overflow: auto; padding: calc(var(--liquid-space) * 2); color: var(--liquid-text-primary); font-weight: normal; font-size: 0.875rem; line-height: 1.6; }
.chksz-info__panel a { color: inherit; text-decoration: underline; }
</style>
