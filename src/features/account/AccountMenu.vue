<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { translate } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import IdentityLinks from './IdentityLinks.vue'
import DataControls from './DataControls.vue'
import { useAccountSession } from './session'
import ProviderIcon from './ProviderIcon.vue'
import { readAuthProviders, type AuthProvider } from './authProviders'
import type { LocalLibraryRepository } from '../library/localRepository'
import type { FocusSessionRepository } from '../focus/localRepository'
import type { VolumeControls } from './accountPreferences'

type Provider = AuthProvider
interface AuthenticatedUser {
  id: string
  displayName: string
  avatarUrl: string | null
  role: 'user' | 'moderator' | 'admin' | 'owner'
}

const props = withDefaults(defineProps<{
  embedded?: boolean
  localRepository?: LocalLibraryRepository
  focusRepository?: FocusSessionRepository
  player?: VolumeControls
}>(), {
  embedded: false,
  localRepository: undefined,
  focusRepository: undefined,
})
const emit = defineEmits<{ (event: 'signed-in', value: boolean): void }>()

const { locale, visualStyle } = usePreferences()
const user = ref<AuthenticatedUser | null>(null)
const identities = ref<Provider[]>([])
const unavailable = ref(false)
const busy = ref(false)
const session = useAccountSession()
const availableProviders = ref<Provider[]>([])

async function refreshProviders(): Promise<void> {
  availableProviders.value = []
  availableProviders.value = await readAuthProviders()
}

/**
 * One statement of the session's state, to both audiences: the parent that asked for the
 * event, and the shared store that surfaces in other categories read. They are announced
 * together so a background gallery in Appearance can never disagree with the account view
 * a user just signed out of.
 */
function announce(value: boolean): void {
  session.publish(value, value ? user.value?.id ?? null : null)
  emit('signed-in', value)
}

async function refresh(): Promise<void> {
  const revision = session.revision.value
  try {
    const response = await fetch('/api/session', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (response.status === 401) {
      if (revision !== session.revision.value) return
      user.value = null
      identities.value = []
      unavailable.value = false
      announce(false)
      return
    }
    if (!response.ok) throw new Error('session_failed')
    const body = await response.json() as { user?: AuthenticatedUser; identities?: Provider[] }
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'user') ||
      (body.user !== null && (typeof body.user?.id !== 'string' || !body.user.id))) throw new Error('session_invalid_response')
    // A concurrent workspace verification of the same identity is harmless;
    // a logout or different account must not be undone by this older request.
    if (revision !== session.revision.value && body.user?.id !== session.userId.value) return
    user.value = body.user ?? null
    identities.value = Array.isArray(body.identities) ? body.identities : []
    unavailable.value = false
    announce(Boolean(user.value))
  } catch {
    user.value = null
    identities.value = []
    unavailable.value = true
    // A failed observation cannot revoke a previously verified identity or
    // move subsequent Focus runs into the anonymous repository.
    if (!session.signedIn.value) announce(false)
    else emit('signed-in', true)
  }
}

async function logout(path: '/api/logout' | '/api/logout-all'): Promise<void> {
  busy.value = true
  try {
    const response = await fetch(path, { method: 'POST' })
    if (!response.ok && response.status !== 204) throw new Error('logout_failed')
    user.value = null
    identities.value = []
    unavailable.value = false
    announce(false)
  } catch {
    unavailable.value = true
    // A failed account mutation cannot prove that the remote Focus endpoint is usable.
    // Fail the explicit sync affordance closed while preserving the visible account so
    // the user can retry the logout action.
    announce(false)
  } finally {
    busy.value = false
  }
}

function onDeleted(): void {
  // Remote deletion and its D1 cascade are already authoritative when DataControls emits.
  // Remove the local authenticated presentation before the follow-up session request settles.
  user.value = null
  identities.value = []
  unavailable.value = false
  announce(false)
  void refresh()
}

onMounted(() => {
  void refresh()
  void refreshProviders()
})
</script>

<template>
  <section class="account-menu" :aria-label="translate(locale, 'account.label')">
    <template v-if="user">
      <component :is="props.embedded ? 'div' : 'details'" :data-account-embedded="props.embedded ? '' : undefined">
        <summary v-if="!props.embedded">{{ user.displayName }}</summary>
        <div :class="['account-menu__panel', { 'account-menu__panel--embedded': props.embedded }, 'surface-glass']">
          <h3 v-if="props.embedded">{{ user.displayName }}</h3>
          <p class="account-menu__role">{{ translate(locale, 'account.role') }}: {{ user.role }}</p>
          <IdentityLinks :identities="identities" :available-providers="availableProviders" @changed="refresh" />
          <DataControls
            :local-repository="props.localRepository"
            :focus-repository="props.focusRepository"
            :player="props.player"
            @deleted="onDeleted"
          />
          <div class="account-menu__actions">
            <button type="button" :disabled="busy" @click="logout('/api/logout')">
              {{ translate(locale, 'account.logout') }}
            </button>
            <button type="button" :disabled="busy" @click="logout('/api/logout-all')">
              {{ translate(locale, 'account.logoutAll') }}
            </button>
          </div>
        </div>
      </component>
    </template>
    <div
      v-else
      class="account-menu__signed-out"
      :class="{ 'account-menu__signed-out--embedded': props.embedded }"
      :data-account-embedded="props.embedded ? '' : undefined"
      :data-visual-style="visualStyle"
    >
      <a
        v-if="availableProviders.includes('google')"
        href="/api/auth/google/start"
        class="auth-button auth-button--google"
        :class="`auth-button--${visualStyle}`"
        :data-visual-style="visualStyle"
      >
        <span class="auth-button__icon" aria-hidden="true">
          <ProviderIcon provider="google" />
        </span>
        <span class="auth-button__text">{{ translate(locale, 'account.signInGoogle') }}</span>
        <span class="auth-button__spacer" aria-hidden="true"></span>
      </a>
      <a
        v-if="availableProviders.includes('github')"
        href="/api/auth/github/start"
        class="auth-button auth-button--github"
        :class="`auth-button--${visualStyle}`"
        :data-visual-style="visualStyle"
      >
        <span class="auth-button__icon" aria-hidden="true">
          <ProviderIcon provider="github" />
        </span>
        <span class="auth-button__text">{{ translate(locale, 'account.signInGithub') }}</span>
        <span class="auth-button__spacer" aria-hidden="true"></span>
      </a>
      <a
        v-if="availableProviders.includes('linuxdo')"
        href="/api/auth/linuxdo/start"
        class="auth-button auth-button--linuxdo"
        :class="`auth-button--${visualStyle}`"
        :data-visual-style="visualStyle"
      >
        <span class="auth-button__icon" aria-hidden="true">
          <ProviderIcon provider="linuxdo" />
        </span>
        <span class="auth-button__text">{{ translate(locale, 'account.signInLinuxdo') }}</span>
        <span class="auth-button__spacer" aria-hidden="true"></span>
      </a>
    </div>
    <p v-if="unavailable" class="account-menu__status" role="status">
      {{ translate(locale, 'account.unavailable') }}
    </p>
  </section>
</template>

<style src="./account-controls.css"></style>

<style scoped>
.account-menu {
  position: relative;
  display: grid;
  gap: 0.25rem;
}

.account-menu__signed-out {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
}

.account-menu__signed-out--embedded {
  max-width: 24rem;
  margin-block: 0.25rem 0.5rem;
}

.account-menu__signed-out:not(.account-menu__signed-out--embedded) {
  flex-direction: row;
  flex-wrap: wrap;
  width: auto;
  gap: 0.5rem;
}

.account-menu__signed-out:not(.account-menu__signed-out--embedded) .auth-button {
  min-width: 12rem;
  width: auto;
}

.account-menu__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

:is(a:not(.auth-button), button, summary) {
  min-height: 2.75rem;
  color: var(--colour-accent-strong);
}

a:not(.auth-button) {
  display: inline-flex;
  align-items: center;
}

summary {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.account-menu__panel {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: 1003;
  display: grid;
  width: min(20rem, calc(100vw - 2rem));
  gap: 0.75rem;
  padding: 1rem;
  background: var(--colour-surface-opaque);
  border-radius: var(--radius-surface);
  box-shadow: var(--glass-shadow);
}

.account-menu__panel--embedded {
  position: static;
  width: auto;
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
}

.account-menu__panel h3 {
  margin: 0;
  font-size: 1rem;
}

.account-menu__role,
.account-menu__status {
  margin: 0;
  color: var(--colour-text-muted);
  font-size: 0.875rem;
}

button {
  padding: 0.5rem 0.75rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  cursor: pointer;
}
</style>
