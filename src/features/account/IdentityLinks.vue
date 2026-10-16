<script setup lang="ts">
import { computed, ref } from 'vue'
import { translate } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import ProviderIcon from './ProviderIcon.vue'
import type { AuthProvider } from './authProviders'

type Provider = AuthProvider

const props = withDefaults(defineProps<{ identities: Provider[]; availableProviders?: Provider[] }>(), {
  availableProviders: () => [],
})
const emit = defineEmits<{ changed: [] }>()
const { locale, visualStyle } = usePreferences()
const busy = ref<Provider | null>(null)
const error = ref('')
const providers = computed(() => (['google', 'github', 'linuxdo'] as const).filter((provider) =>
  props.identities.includes(provider) || props.availableProviders.includes(provider)))

const linked = computed(() => new Set(props.identities))
const providerName = (provider: Provider) => translate(locale.value, `account.provider.${provider}`)
const linkLabel = (provider: Provider) => translate(locale.value, 'account.link').replace('{provider}', providerName(provider))
const unlinkLabel = (provider: Provider) => translate(locale.value, 'account.unlink').replace('{provider}', providerName(provider))
const linkedLabel = (provider: Provider) => translate(locale.value, 'account.linked').replace('{provider}', providerName(provider))

async function unlink(provider: Provider): Promise<void> {
  busy.value = provider
  error.value = ''
  try {
    const response = await fetch(`/api/auth/${provider}/unlink`, { method: 'POST' })
    if (!response.ok) throw new Error('unlink_failed')
    emit('changed')
  } catch {
    error.value = translate(locale.value, 'account.actionFailed')
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div
    class="identity-links"
    :data-visual-style="visualStyle"
    :aria-label="translate(locale, 'account.identities')"
  >
    <div v-for="provider in providers" :key="provider" class="identity-links__row">
      <template v-if="linked.has(provider)">
        <span class="identity-links__status">
          <span class="identity-links__icon" aria-hidden="true">
            <ProviderIcon :provider="provider" />
          </span>
          <span>{{ linkedLabel(provider) }}</span>
        </span>
        <button
          type="button"
          :aria-label="unlinkLabel(provider)"
          :disabled="busy !== null || identities.length <= 1"
          @click="unlink(provider)"
        >
          {{ translate(locale, 'account.unlinkAction') }}
        </button>
      </template>
      <a
        v-else
        :href="`/api/auth/${provider}/start?intent=link`"
        class="auth-button auth-button--link"
        :class="[`auth-button--${provider}`, `auth-button--${visualStyle}`]"
        :data-visual-style="visualStyle"
      >
        <span class="auth-button__icon" aria-hidden="true">
          <ProviderIcon :provider="provider" />
        </span>
        <span class="auth-button__text">{{ linkLabel(provider) }}</span>
        <span class="auth-button__spacer" aria-hidden="true"></span>
      </a>
    </div>
    <p v-if="error" role="status">{{ error }}</p>
  </div>
</template>

<style src="./account-controls.css"></style>

<style scoped>
.identity-links {
  display: grid;
  gap: 0.625rem;
  width: 100%;
  max-width: 24rem;
}

.identity-links__row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.identity-links__status {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--colour-text-primary);
  font-size: 0.9375rem;
}

.identity-links__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  flex-shrink: 0;
}

button {
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-accent-strong);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  cursor: pointer;
}

[data-visual-style="studio"] button,
[data-theme="studio"] button {
  background: rgb(255 255 255 / 7%);
  border: 1px solid rgb(255 255 255 / 16%);
  color: var(--liquid-text-primary);
}

p {
  margin: 0;
  color: var(--colour-text-muted);
}
</style>
