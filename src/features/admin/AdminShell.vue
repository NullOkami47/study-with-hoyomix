<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed, watchEffect } from 'vue'
import { createAdminRepository, type AdminOverview, type AdminRole, type AdminRepository } from './client'
import ProviderControls from './ProviderControls.vue'
import NoticeManager from './NoticeManager.vue'
import AuditLog from './AuditLog.vue'
import BackgroundManager from './BackgroundManager.vue'
import CatalogueManager from './CatalogueManager.vue'
import ChatModeration from './ChatModeration.vue'
import { chatModerationText } from './chatModerationText'
import AdminStatusChip from './primitives/AdminStatusChip.vue'
import AdminPageHeader from './primitives/AdminPageHeader.vue'
import { readAuthProviders, type AuthProvider } from '../account/authProviders'
import ProviderIcon from '../account/ProviderIcon.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type Locale, type TranslationKey } from '../../i18n'

const { locale, setLocale, visualStyle } = usePreferences()

watchEffect(() => {
  document.documentElement.dataset.theme = visualStyle.value
})

function t(key: string): string {
  return translate(locale.value, key as TranslationKey)
}

const catalogueLabel = computed(() => translate(locale.value, 'admin.catalogue.title'))

type LoadState = 'loading' | 'ready' | 'unauthorized' | 'unavailable' | 'moderator'

const props = withDefaults(defineProps<{
  repository?: AdminRepository
}>(), {
  repository: undefined,
})

const repo = props.repository ?? createAdminRepository()
const state = ref<LoadState>('loading')
const role = ref<AdminRole | null>(null)
const overview = ref<AdminOverview | null>(null)
const errorMessage = ref('')
const availableProviders = ref<AuthProvider[]>([])

const DASH = '\u2014'

const mutatingProvider = ref<string | null>(null)
const checkingHealth = ref(false)

const providers = computed(() => overview.value?.providers ?? [])

type SectionId = 'overview' | 'providers' | 'notices' | 'backgrounds' | 'catalogue' | 'audit' | 'chat'

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; ownerOnly: boolean }> = [
  { id: 'overview', label: 'Overview', ownerOnly: false },
  { id: 'providers', label: 'Providers', ownerOnly: false },
  { id: 'notices', label: 'Notices', ownerOnly: false },
  { id: 'backgrounds', label: 'Backgrounds', ownerOnly: false },
  { id: 'catalogue', label: 'Catalogue', ownerOnly: false },
  { id: 'chat', label: 'Chat moderation', ownerOnly: false },
  { id: 'audit', label: 'Audit log', ownerOnly: true },
]

const activeSection = ref<SectionId>('overview')
const visited = ref<Set<SectionId>>(new Set<SectionId>(['overview']))

const navSections = computed(() => SECTIONS.filter((section) => !section.ownerOnly || role.value))

const liveProviderCount = computed(() => providers.value.filter((p) => p.effectiveEnabled).length)

const providerRatio = computed(() => providers.value.length === 0
  ? DASH
  : `${liveProviderCount.value} / ${providers.value.length}`)

const attention = computed(() => providers.value
  .filter((p) => p.effectiveEnabled && (p.status === 'degraded' || p.status === 'unavailable'))
  .sort((a, b) => (a.status === b.status ? a.priority - b.priority : a.status === 'unavailable' ? -1 : 1)))

const attentionCount = computed(() => providers.value.length === 0 ? DASH : String(attention.value.length))

const systemOperational = computed(() => attention.value.length === 0 && providers.value.length > 0)

function sectionTitle(id: SectionId): string {
  if (id === 'chat') return chatModerationText(locale.value, 'title')
  if (id === 'catalogue') return catalogueLabel.value
  const translated = translate(locale.value, ('admin.nav.' + id) as TranslationKey)
  return translated || id
}

function formatFailureClass(failureClass: string | null): string {
  if (!failureClass) return ''
  if (failureClass === 'http_502_upstream_gateway') return t('admin.overview.errorGateway')
  if (failureClass === 'connection_refused_or_timed_out') return t('admin.overview.errorTimeout')
  if (failureClass === 'http_429_rate_limited') return t('admin.overview.errorRateLimit')
  if (failureClass === 'authentication_failed') return t('admin.overview.errorAuth')
  return failureClass
}

const sectionHooks = (id: SectionId): Record<string, string> => ({ [`data-admin-nav-${id}`]: '' })

function sectionFromHash(hash: string): SectionId | null {
  const match = /^#admin-([a-z]+)$/u.exec(hash)
  const found = match ? SECTIONS.find((section) => section.id === match[1]) : undefined
  if (!found) return null
  return found.ownerOnly && !role.value ? null : found.id
}

function selectSection(id: SectionId, recordHistory = true): void {
  activeSection.value = id
  if (!visited.value.has(id)) visited.value = new Set(visited.value).add(id)
  if (recordHistory && window.location.hash !== `#admin-${id}`) {
    window.history.pushState(null, '', `#admin-${id}`)
  }
}

function onNavClick(event: MouseEvent, id: SectionId): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  selectSection(id)
}

function onHashChange(): void {
  const requested = sectionFromHash(window.location.hash)
  selectSection(requested ?? 'overview', false)
}

async function applyProviderMutation(
  key: string,
  update: { enabled?: boolean; priority?: number; confirmation?: string; reason?: string },
): Promise<void> {
  if (mutatingProvider.value) return
  mutatingProvider.value = key
  try {
    const updated = await repo.updateProvider(key, update)
    if (overview.value) {
      overview.value = {
        ...overview.value,
        providers: overview.value.providers.map((p) => (p.key === key ? updated : p)),
      }
    }
    errorMessage.value = ''
  } catch {
    let refreshed = false
    try {
      overview.value = await repo.getOverview()
      refreshed = true
    } catch {
      // Keep the last server snapshot visible and explain that it may be stale.
    }
    errorMessage.value = refreshed
      ? t('admin.providers.updateFailed') || 'Provider settings could not be saved. The current server state has been reloaded.'
      : t('admin.providers.updateFailedRefresh') || 'Provider settings could not be saved and the current server state could not be refreshed.'
  } finally {
    mutatingProvider.value = null
  }
}

function onToggle(key: string, enabled: boolean, confirmation?: string, reason?: string): void {
  void applyProviderMutation(key, { enabled, confirmation, reason })
}

async function handleProviderOrder(providerIds: string[]): Promise<void> {
  if (mutatingProvider.value) return
  mutatingProvider.value = 'order'
  try {
    const updated = await repo.updateProviderOrder(providerIds)
    if (overview.value) {
      overview.value = {
        ...overview.value,
        providers: updated,
      }
    }
  } catch {
    errorMessage.value = 'Failed to update provider order.'
  } finally {
    mutatingProvider.value = null
  }
}

async function onOwnerFallback(enabled: boolean): Promise<void> {
  if (mutatingProvider.value) return
  mutatingProvider.value = 'chksz'
  try {
    const updated = await repo.updateChkszOwnerFallback(enabled)
    if (overview.value) {
      overview.value = {
        ...overview.value,
        providers: overview.value.providers.map((provider) => provider.key === 'chksz'
          ? { ...provider, ...updated }
          : provider),
      }
    }
  } catch {
    errorMessage.value = 'Failed to update ChKSz Owner fallback.'
  } finally {
    mutatingProvider.value = null
  }
}

async function onCheckHealth(): Promise<void> {
  if (checkingHealth.value) return
  checkingHealth.value = true
  try {
    overview.value = await repo.getOverview()
  } catch {
    errorMessage.value = 'Failed to refresh provider status.'
  } finally {
    checkingHealth.value = false
  }
}

async function load(): Promise<void> {
  state.value = 'loading'
  try {
    const session = await repo.checkSession()
    if (session.status === 'unavailable') {
      state.value = 'unavailable'
      errorMessage.value = 'Admin services are unavailable.'
      return
    }
    if (session.status === 'unauthorised') {
      // A chat moderator has no access to unrelated administration. Only this explicit
      // destination requests the narrower server-authorised moderation surface.
      if (window.location.hash === '#admin-chat') {
        try {
          const response = await fetch('/api/chat/moderation', { credentials: 'same-origin', cache: 'no-store' })
          if (response.ok) {
            const body = await response.json() as { viewer?: { role?: string } }
            if (body.viewer?.role === 'moderator') { state.value = 'moderator'; return }
          }
        } catch { /* Existing sign-in gate remains available when chat cannot be verified. */ }
      }
      availableProviders.value = []
      state.value = 'unauthorized'
      availableProviders.value = await readAuthProviders()
      return
    }
    role.value = session.role
    overview.value = await repo.getOverview()
    state.value = 'ready'
    selectSection(sectionFromHash(window.location.hash) ?? 'overview', false)
  } catch {
    state.value = 'unavailable'
    errorMessage.value = 'Admin services are unavailable.'
  }
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('popstate', onHashChange)
  void load()
})

onBeforeUnmount(() => {
  delete document.documentElement.dataset.theme
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('popstate', onHashChange)
})
</script>

<template>
  <div class="admin-shell" data-admin-shell>
    <template v-if="state === 'loading'">
      <div class="admin-shell__loading-gate">
        <div class="admin-shell__spinner" aria-hidden="true" />
        <p class="admin-shell__status" role="status">{{ t('admin.shell.loading') || 'Loading admin console...' }}</p>
      </div>
    </template>

    <main v-else-if="state === 'moderator'" class="admin-shell__moderation-only">
      <a href="/">{{ chatModerationText(locale, 'back') }}</a>
      <ChatModeration />
    </main>

    <template v-else-if="state === 'unauthorized'">
      <div class="admin-shell__gate" data-admin-unauthorized :data-visual-style="visualStyle">
        <h1>{{ t('admin.shell.gate.unauthorized.title') || 'Admin access required' }}</h1>
        <p>{{ t('admin.shell.gate.unauthorized.desc') || 'You need an admin or owner account to view this page.' }}</p>
        <div class="admin-shell__gate-actions">
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
            <span class="auth-button__text">{{ t('account.signInGoogle') || 'Sign in with Google' }}</span>
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
            <span class="auth-button__text">{{ t('account.signInGithub') || 'Sign in with GitHub' }}</span>
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
            <span class="auth-button__text">{{ t('account.signInLinuxdo') || 'Sign in with LINUX DO' }}</span>
            <span class="auth-button__spacer" aria-hidden="true"></span>
          </a>
        </div>
      </div>
    </template>

    <template v-else-if="state === 'unavailable'">
      <div class="admin-shell__gate" data-admin-unavailable>
        <h1>{{ t('admin.shell.gate.unavailable.title') || 'Admin unavailable' }}</h1>
        <p role="alert">{{ errorMessage || t('admin.shell.gate.unavailable.desc') || 'Admin services are unavailable.' }}</p>
        <button type="button" @click="load">{{ t('admin.shell.gate.unavailable.retry') || 'Retry' }}</button>
      </div>
    </template>

    <template v-else>
      <aside class="admin-shell__sidebar" data-admin-sidebar>
        <div class="admin-shell__brand">
          <h1 class="admin-shell__title">{{ t('admin.shell.title') || 'Admin console' }}</h1>
          <div class="admin-shell__health-indicator">
            <AdminStatusChip
              :variant="systemOperational ? 'success' : attention.length > 0 ? 'danger' : 'neutral'"
              size="sm"
              :pulse="systemOperational || attention.length > 0"
            >
              {{ systemOperational ? (t('admin.shell.systemStatus.healthy') || 'Operational') : (t('admin.shell.systemStatus.attention') || 'Attention') }}
            </AdminStatusChip>
          </div>
        </div>

        <nav aria-label="Admin sections">
          <a
            v-for="section in navSections"
            :key="section.id"
            v-bind="sectionHooks(section.id)"
            :href="`#admin-${section.id}`"
            :aria-controls="`admin-${section.id}`"
            :aria-current="activeSection === section.id ? 'page' : undefined"
            :class="{ 'admin-shell__nav-link--active': activeSection === section.id }"
            class="admin-shell__nav-link"
            @click="onNavClick($event, section.id)"
          >
            <span class="admin-shell__nav-label">{{ sectionTitle(section.id) }}</span>
            <span v-if="section.id === 'overview' && attention.length > 0" class="admin-shell__nav-badge">
              {{ attention.length }}
            </span>
          </a>
        </nav>
      </aside>

      <main id="admin-content" class="admin-shell__main" tabindex="-1">
        <!-- Top Operations Bar -->
        <header class="admin-shell__topbar" data-admin-topbar>
          <div class="admin-shell__topbar-left">
            <a href="/" class="admin-shell__back-link" data-admin-back-to-player>
              <span aria-hidden="true">&larr;</span>
              <span>{{ t('admin.shell.backToPlayer') || 'Return to player' }}</span>
            </a>
          </div>
          <div class="admin-shell__topbar-right">
            <div class="admin-shell__locale-picker">
              <label for="admin-locale-select" class="admin-shell__sr-only">Locale</label>
              <select
                id="admin-locale-select"
                class="admin-shell__locale-select"
                :value="locale"
                @change="setLocale(($event.target as HTMLSelectElement).value as Locale)"
              >
                <option value="en">English</option>
                <option value="zh-Hant">繁體中文</option>
                <option value="zh-Hans">简体中文</option>
              </select>
            </div>
            <div class="admin-shell__user-badge">
              <AdminStatusChip
                :variant="role === 'owner' ? 'warning' : 'info'"
                size="sm"
                data-admin-role-badge
              >
                {{ role === 'owner' ? (t('admin.shell.role.owner') || 'Owner') : (t('admin.shell.role.admin') || 'Admin') }}
              </AdminStatusChip>
            </div>
          </div>
        </header>

        <div
          v-if="errorMessage"
          class="admin-shell__alert-banner"
          data-admin-error-banner
          role="alert"
        >
          <span>{{ errorMessage }}</span>
          <button
            type="button"
            class="admin-shell__alert-dismiss"
            data-admin-error-dismiss
            :aria-label="t('admin.shell.dismissError') || 'Dismiss error'"
            @click="errorMessage = ''"
          >
            &times;
          </button>
        </div>

        <section
          v-show="activeSection === 'overview'"
          id="admin-overview"
          class="admin-shell__section"
          data-admin-section="overview"
        >
          <AdminPageHeader
            :title="t('admin.overview.title') || 'Overview'"
            :subtitle="t('admin.overview.subtitle') || 'System health, active incidents, and operational metrics.'"
          />

          <!-- Status Banner -->
          <div
            v-if="attention.length === 0 && providers.length > 0"
            class="admin-shell__status-banner admin-shell__status-banner--healthy"
          >
            <span class="admin-shell__status-banner-icon" aria-hidden="true">✓</span>
            <span class="admin-shell__status-banner-text">
              {{ t('admin.overview.allHealthy') || 'Every live provider last reported healthy.' }}
            </span>
          </div>

          <div class="admin-shell__cards">
            <div class="admin-shell__card" data-admin-card="providers">
              <span class="admin-shell__card-label">{{ t('admin.overview.liveProviders') || 'Providers live' }}</span>
              <span class="admin-shell__card-value">{{ providerRatio }}</span>
            </div>
            <div
              class="admin-shell__card"
              :class="{ 'admin-shell__card--alert': attention.length > 0 }"
              data-admin-card="attention"
            >
              <span class="admin-shell__card-label">{{ t('admin.overview.attention') || 'Need attention' }}</span>
              <span class="admin-shell__card-value">{{ attentionCount }}</span>
            </div>
            <div class="admin-shell__card" data-admin-card="notices">
              <span class="admin-shell__card-label">{{ t('admin.overview.activeNotices') || 'Active notices' }}</span>
              <span class="admin-shell__card-value">{{ overview?.activeNoticeCount ?? DASH }}</span>
            </div>
            <div class="admin-shell__card" data-admin-card="role">
              <span class="admin-shell__card-label">{{ t('admin.overview.yourRole') || 'Your role' }}</span>
              <span class="admin-shell__card-value">{{ role ?? DASH }}</span>
            </div>
          </div>

          <div v-if="attention.length > 0" class="admin-shell__attention">
            <div class="admin-shell__attention-header">
              <span class="admin-shell__attention-icon" aria-hidden="true">⚠️</span>
              <h3>{{ t('admin.overview.attentionTitle') || 'Live providers reporting trouble' }}</h3>
            </div>
            <ul class="admin-shell__attention-list">
              <li
                v-for="provider in attention"
                :key="provider.key"
                class="admin-shell__attention-row"
                :data-admin-attention-item="provider.key"
              >
                <div class="admin-shell__attention-meta">
                  <span class="admin-shell__attention-key">{{ provider.key }}</span>
                  <AdminStatusChip variant="danger" size="sm">
                    <span class="admin-shell__attention-status">{{ provider.status }}</span>
                  </AdminStatusChip>
                </div>
                <div v-if="provider.failureClass" class="admin-shell__attention-cause-wrapper">
                  <span class="admin-shell__attention-cause">
                    {{ provider.failureClass }} &mdash; {{ formatFailureClass(provider.failureClass) }}
                  </span>
                </div>
              </li>
            </ul>
            <a
              href="#admin-providers"
              class="admin-shell__attention-link"
              data-admin-attention-link
              @click="onNavClick($event, 'providers')"
            >{{ t('admin.overview.openProviders') || 'Open Providers' }} &rarr;</a>
          </div>

          <p
            v-else-if="providers.length > 0"
            class="admin-shell__attention-clear"
            data-admin-attention-clear
          >{{ t('admin.overview.allHealthy') || 'Every live provider last reported healthy.' }}</p>
        </section>

        <section
          v-show="activeSection === 'providers'"
          id="admin-providers"
          class="admin-shell__section"
          data-admin-section="providers"
        >
          <div v-if="visited.has('providers')" class="admin-shell__providers">
            <ProviderControls
              :providers="providers"
              :mutating="mutatingProvider"
              @toggle="onToggle"
              @order="handleProviderOrder"
              @owner-fallback="onOwnerFallback"
              @check-health="onCheckHealth"
            />
          </div>
        </section>

        <section
          v-show="activeSection === 'notices'"
          id="admin-notices"
          class="admin-shell__section"
          data-admin-section="notices"
        >
          <NoticeManager v-if="visited.has('notices')" :repository="repo" />
        </section>

        <section
          v-show="activeSection === 'backgrounds'"
          id="admin-backgrounds"
          class="admin-shell__section"
          data-admin-section="backgrounds"
        >
          <BackgroundManager v-if="visited.has('backgrounds')" :repository="repo" />
        </section>

        <section v-show="activeSection === 'catalogue'" id="admin-catalogue" class="admin-shell__section" data-admin-section="catalogue">
          <CatalogueManager v-if="visited.has('catalogue')" :repository="repo" />
        </section>

        <section v-show="activeSection === 'chat'" id="admin-chat" class="admin-shell__section" data-admin-section="chat">
          <ChatModeration v-if="visited.has('chat')" />
        </section>

        <section
          v-if="role"
          v-show="activeSection === 'audit'"
          id="admin-audit"
          class="admin-shell__section"
          data-admin-section="audit"
        >
          <AuditLog v-if="visited.has('audit')" :repository="repo" :role="role" />
        </section>
      </main>
    </template>
  </div>
</template>

<style src="../account/account-controls.css"></style>

<style scoped>
.admin-shell__moderation-only { grid-column: 1 / -1; padding: 1rem; width: 100%; max-width: 64rem; box-sizing: border-box; margin-inline: auto; }
.admin-shell__moderation-only > a { display: inline-flex; align-items: center; min-height: 2.75rem; color: var(--colour-accent-strong); }
.admin-shell__gate {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 2rem 1rem;
  text-align: center;
  box-sizing: border-box;
}

.admin-shell__gate-actions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  max-width: 22rem;
  margin-top: 1.5rem;
}

.admin-shell {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 16rem minmax(0, 1fr);
  gap: 0;
  max-width: 100vw;
  overflow-x: hidden;
  background: var(--colour-background);
  color: var(--colour-text-primary);
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

.admin-shell__sidebar {
  position: sticky;
  top: 0;
  align-self: start;
  height: 100dvh;
  padding: 1.25rem 0.875rem;
  background: var(--colour-surface-opaque);
  border-right: 1px solid var(--glass-edge);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.admin-shell__brand {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--glass-edge);
}

.admin-shell__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.2;
}

.admin-shell__sidebar nav {
  display: grid;
  gap: 0.375rem;
}

.admin-shell__sidebar nav a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 0.75rem;
  color: var(--colour-accent-strong);
  border-radius: 0.5rem;
  text-decoration: none;
  font-weight: 500;
  font-size: 0.875rem;
  transition: all 0.15s ease;
}

.admin-shell__sidebar nav a:hover {
  background: rgb(255 255 255 / 8%);
}

.admin-shell__nav-link--active {
  background: rgb(255 255 255 / 12%);
  box-shadow: inset 3px 0 0 var(--colour-accent-strong);
  font-weight: 600 !important;
}

.admin-shell__nav-badge {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 9999px;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.admin-shell__main {
  height: 100dvh;
  padding: 1.25rem 1.625rem;
  outline: none;
  min-width: 0;
  overflow-y: auto;
  box-sizing: border-box;
}

.admin-shell__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 1rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--glass-edge);
  gap: 16px;
}

.admin-shell__topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.admin-shell__alert-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
  padding: 0.75rem 1rem;
  color: #ef4444;
  background: rgb(239 68 68 / 10%);
  border: 1px solid rgb(239 68 68 / 30%);
  border-radius: var(--radius-surface);
  font-size: 0.875rem;
  font-weight: 500;
}

.admin-shell__alert-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  color: inherit;
  background: transparent;
  border: none;
  border-radius: 0.25rem;
  font-size: 1.125rem;
  cursor: pointer;
  line-height: 1;
}

.admin-shell__alert-dismiss:hover {
  background: rgb(239 68 68 / 15%);
}

.admin-shell__back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--colour-text-muted);
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--glass-edge);
  transition: all 0.15s ease;
}

.admin-shell__back-link:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.08);
}

.admin-shell__locale-select {
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-edge);
  color: var(--colour-text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
}

.admin-shell__status-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 1.25rem;
  font-size: 0.875rem;
  font-weight: 500;
}

.admin-shell__status-banner--healthy {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.25);
  color: #4ade80;
}

.admin-shell__status-banner-icon {
  font-size: 1.125rem;
  font-weight: bold;
}

.admin-shell__cards {
  display: flex;
  flex-wrap: wrap;
  gap: 0.875rem;
}

.admin-shell__card {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 9rem;
  flex: 1 1 12rem;
  padding: 0.875rem 1rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.admin-shell__card--alert {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.05);
}

.admin-shell__card-label {
  color: var(--colour-text-muted);
  font-size: 0.875rem;
}

.admin-shell__card-value {
  font-size: 1.625rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.admin-shell__attention {
  margin-top: 1.25rem;
  padding: 1rem;
  background: var(--colour-surface-opaque);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: var(--radius-surface);
}

.admin-shell__attention-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 0.875rem;
}

.admin-shell__attention h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: #f87171;
}

.admin-shell__attention-list {
  display: grid;
  gap: 0.625rem;
  margin: 0 0 1rem;
  padding: 0;
  list-style: none;
}

.admin-shell__attention-row {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.625rem 0.875rem;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.admin-shell__attention-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.admin-shell__attention-key {
  font-weight: 600;
  font-size: 0.9375rem;
}

.admin-shell__attention-cause {
  font-size: 0.8125rem;
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.08);
  padding: 2px 8px;
  border-radius: 4px;
}

.admin-shell__attention-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--colour-accent-strong);
  font-weight: 600;
  text-decoration: none;
  font-size: 0.875rem;
}

.admin-shell__attention-link:hover {
  text-decoration: underline;
}

.admin-shell__attention-clear {
  margin: 1.5rem 0 0;
  color: var(--colour-text-muted);
  font-size: 0.875rem;
}

.admin-shell__loading-gate {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 16px;
}

.admin-shell__spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: #38bdf8;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.admin-shell__status {
  color: var(--colour-text-muted);
  font-size: 0.9375rem;
}

.admin-shell__gate {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
  padding: 3rem 2rem;
  max-width: 30rem;
}

.admin-shell__gate h1 {
  margin: 0;
  font-size: 1.5rem;
}

.admin-shell__gate p {
  margin: 0;
  color: var(--colour-text-muted);
}

.admin-shell__gate a:not(.auth-button),
.admin-shell__gate button:not(.auth-button) {
  padding: 0.625rem 1rem;
  color: var(--colour-accent-strong);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  text-decoration: none;
  cursor: pointer;
}

.admin-shell__gate-actions {
  display: flex;
  gap: 12px;
}

.admin-shell__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .admin-shell {
    grid-template-columns: minmax(0, 1fr);
    max-width: 100vw;
  }

  .admin-shell__sidebar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: auto;
    padding: 0.75rem 1rem;
    border-right: none;
    border-bottom: 1px solid var(--glass-edge);
    overflow-x: hidden;
    overflow-y: hidden;
    min-width: 0;
    max-width: 100vw;
    box-sizing: border-box;
    gap: 0.75rem;
  }

  .admin-shell__brand {
    padding-bottom: 0;
    border-bottom: none;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .admin-shell__sidebar nav {
    display: flex;
    gap: 0.375rem;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .admin-shell__sidebar nav a {
    padding: 0.5rem 0.75rem;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .admin-shell__nav-link--active {
    box-shadow: inset 0 -3px 0 var(--colour-accent-strong);
  }

  .admin-shell__main {
    min-width: 0;
    max-width: 100vw;
    box-sizing: border-box;
    padding: 1rem 0.75rem;
  }

  .admin-shell__topbar {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
}

.admin-shell__providers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 36rem), 1fr));
  align-items: start;
  gap: 1rem;
}
</style>
