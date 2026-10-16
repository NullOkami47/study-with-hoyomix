<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import AccountMenu from '../account/AccountMenu.vue'
import NoticeHistory from '../notices/NoticeHistory.vue'
import { useAccountSession } from '../account/session'
import BackgroundGallery from '../backgrounds/BackgroundGallery.vue'
import type { BackgroundStore } from '../backgrounds/store'
import FocusHistoryControls from '../focus/FocusHistoryControls.vue'
import type { FocusSessionRepository } from '../focus/localRepository'
import { getDefaultRemoteFocusSessionRepository } from '../focus/remoteRepository'
import { createEmptyLocalLibrary, type LibraryExport } from '../library/types'
import type { LocalLibraryRepository } from '../library/localRepository'
import type { PlaybackStore } from '../player/store'
import {
  getDefaultChkszCredentialStore,
  type ChkszCredentialStore,
} from '../player/chkszCredentialStore'
import {
  USER_TOGGLEABLE_PROVIDER_IDS,
  getDefaultProviderPreferencesStore,
  type ProviderPreferencesStore,
  type UserToggleableProviderId,
} from '../player/providerPreferences'
import {
  CHKSZ_QUALITIES,
  LX_QUALITIES,
  getDefaultPlaybackQualityPreferencesStore,
  type ChkszQuality,
  type LxQuality,
  type PlaybackQualityPreferencesStore,
} from '../player/qualityPreferences'
import { getDefaultLxSourceRepository } from '../player/lx/sourceRepository'
import type { LxSourceRepository } from '../player/lx/types'
import {
  isProviderEnabled,
  type PublicProviderState,
  type RuntimeProviderRepository,
} from '../player/runtimeConfig'
import type { FocusBehaviour, PomodoroStore } from '../timers/pomodoro/store'
import type { FullscreenState } from '../workspace/fullscreen'
import LxSourceManager from './LxSourceManager.vue'
import ChkszInfo from './ChkszInfo.vue'
import ThirdPartyAgreement from './ThirdPartyAgreement.vue'
import { acceptAgreement, AGREEMENT_STORAGE_KEY, hasCurrentAgreement, withdrawAgreement } from './thirdPartyAgreement'
import { isChkszApiKey } from '../../shared/chksz'
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from './sections'
import { aboutLinks, privacyLinks } from './disclosureLinks'
import { isLocale, translate, type TranslationKey } from '../../i18n'
import { resolvePwaInstallState, usePwaInstallStatus, type PwaInstallState } from '../../pwa/installStatus'
import { usePwaUpdateStatus } from '../../pwa/updateStatus'
import { MAX_STUDIO_BLUR, MAX_STUDIO_EDGE, MAX_STUDIO_GLASS_GRAY, MIN_STUDIO_BLUR, MIN_STUDIO_EDGE, MIN_STUDIO_GLASS_GRAY, type BackgroundMode, type Preferences, type VisualStyle } from '../../stores/preferences'

const props = withDefaults(defineProps<{
  preferences: Preferences
  pomodoroStore: PomodoroStore
  player: PlaybackStore
  library: LocalLibraryRepository
  focusRepository: FocusSessionRepository
  focusHistoryStatus?: 'storage_error' | 'pending_overflow' | 'overflow_full'
  backgroundStore: BackgroundStore
  chkszCredentials?: ChkszCredentialStore
  providerPreferences?: ProviderPreferencesStore
  qualityPreferences?: PlaybackQualityPreferencesStore
  lxSourceRepository?: LxSourceRepository
  providerRepository?: Pick<RuntimeProviderRepository, 'states'>
  /**
   * The sections to render. Omitted, the sheet renders all of them behind its own index,
   * which is how it stands alone. Given a subset, it renders exactly those and drops the
   * index, because an index over one section is noise -- the Control Center's rail is
   * already the navigation in that case.
   */
  sections?: SettingsSectionId[]
  /** Rendered as the Application section's fullscreen command when supplied. */
  fullscreenState?: FullscreenState
}>(), {
  focusHistoryStatus: undefined,
  chkszCredentials: undefined,
  providerPreferences: undefined,
  qualityPreferences: undefined,
  lxSourceRepository: undefined,
  providerRepository: undefined,
  sections: undefined,
  fullscreenState: undefined,
})
// Vite's analytics injector marks the script in the built HTML. Read the actual
// page rather than assuming every deployment uses the same build configuration.
const analyticsEnabled = typeof document !== 'undefined' && Boolean(document.querySelector('script[data-website-id]'))
const emit = defineEmits<{
  (event: 'open-library'): void
  (event: 'open-calendar'): void
  (event: 'toggle-fullscreen'): void
}>()
const shows = (section: SettingsSectionId): boolean => !props.sections || props.sections.includes(section)
const visibleSections = computed(() => SETTINGS_SECTION_IDS.filter(shows))
const text = (key: TranslationKey): string => translate(props.preferences.locale.value, key)
const librarySnapshot = shallowRef<LibraryExport>(createEmptyLocalLibrary())
const libraryStatus = ref('')
const storageMode = ref(props.library.storageMode())
const pwaInstallStatus = usePwaInstallStatus()
const pwaUpdateStatus = usePwaUpdateStatus()
// History controls describe the workspace-owned lifecycle; mounting Settings
// never starts a second Focus synchronisation client.
const remoteFocusRepository = getDefaultRemoteFocusSessionRepository()
/**
 * Read from the shared session rather than from an event a child emits. Appearance and
 * Pomodoro each gate a sync control on this, and the component that used to answer the
 * question -- the account view -- only mounts in the Account category now, so any category
 * rendered on its own would otherwise be told the user is anonymous.
 */
const session = useAccountSession()
const signedIn = session.signedIn
let unsubscribe = (): void => undefined

const pwaStatusKey = computed<TranslationKey>(() => {
  const keys: Record<PwaInstallState, TranslationKey> = {
    runningStandalone: 'settings.application.pwaInstalled',
    installedThisSession: 'settings.application.pwaInstalledThisSession',
    promptAvailable: 'settings.application.pwaPromptAvailable',
    unknown: 'settings.application.pwaNotInstalled',
  }
  return keys[resolvePwaInstallState({
    runningStandalone: pwaInstallStatus.runningStandalone.value,
    installedThisSession: pwaInstallStatus.installedThisSession.value,
    installPromptAvailable: pwaInstallStatus.installPromptAvailable.value,
  })]
})
const currentSource = computed(() => props.player.activeProviderId.value || text('player.automatic'))
const chkszCredentials = props.chkszCredentials ?? getDefaultChkszCredentialStore()
const chkszKey = ref(chkszCredentials.key() ?? '')
const chkszRemember = ref(chkszCredentials.remember())
const chkszStatus = ref('')
const agreementAccepted = ref(hasCurrentAgreement())
const agreementPending = ref(false)
const lxConsentRevision = ref(0)
let pendingConsent: ((accepted: boolean) => void) | undefined
let consentOpener: HTMLElement | undefined
function requestConsent(): Promise<boolean> {
  if (hasCurrentAgreement()) return Promise.resolve(true)
  if (pendingConsent) return Promise.resolve(false)
  consentOpener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  agreementPending.value = true
  return new Promise((resolve) => { pendingConsent = resolve })
}
function resolveConsent(accepted: boolean): void {
  if (accepted) {
    try { acceptAgreement() } catch { accepted = false }
  }
  agreementAccepted.value = accepted && hasCurrentAgreement()
  agreementPending.value = false
  pendingConsent?.(accepted)
  pendingConsent = undefined
  const opener = consentOpener
  consentOpener = undefined
  if (opener) void nextTick(() => { if (opener.isConnected) opener.focus() })
}
async function revokeSourceConsent(): Promise<void> {
  resolveConsent(false)
  // Persist a refusal first, so later failed local storage operations cannot enable requests.
  try { withdrawAgreement() } catch { /* this tab still clears the active credentials */ }
  clearChkszCredential()
  try {
    for (const source of await lxSourceRepository.list()) {
      if (!source.builtIn && source.enabled) await lxSourceRepository.setEnabled(source.id, false)
    }
  } catch {
    // The refusal receipt already blocks custom runtime resolution; keep the failure generic.
    chkszStatus.value = text('library.actionFailed')
  }
  lxConsentRevision.value += 1
  agreementAccepted.value = false
}

// One shared preference store is created by the workspace so playback and
// Settings always agree; the fallback keeps this component usable in isolation.
const providerPreferences = props.providerPreferences ?? getDefaultProviderPreferencesStore()
const providerStates = ref<readonly PublicProviderState[]>([])
const disabledProviderIds = ref<ReadonlySet<string>>(providerPreferences.disabledProviderIds())
let unsubscribeProviderPreferences = (): void => undefined

// Quality is a local, per-device preference. The selectors are the only writers, but the
// store is still subscribed so a second surface cannot leave these showing a stale tier.
const qualityPreferences = props.qualityPreferences ?? getDefaultPlaybackQualityPreferencesStore()
const chkszQuality = ref<ChkszQuality>(qualityPreferences.chkszQuality())
const lxQuality = ref<LxQuality>(qualityPreferences.lxQuality())
let unsubscribeQualityPreferences = (): void => undefined

const CHKSZ_QUALITY_LABEL_KEYS: Record<ChkszQuality, TranslationKey> = {
  standard: 'settings.playback.chkszQualityStandard',
  exhigh: 'settings.playback.chkszQualityExhigh',
  lossless: 'settings.playback.chkszQualityLossless',
  hires: 'settings.playback.chkszQualityHires',
  jyeffect: 'settings.playback.chkszQualityJyeffect',
  sky: 'settings.playback.chkszQualitySky',
  jymaster: 'settings.playback.chkszQualityJymaster',
}

const LX_QUALITY_LABEL_KEYS: Record<LxQuality, TranslationKey> = {
  standard: 'settings.playback.qualityStandard',
  high: 'settings.playback.qualityHigh',
  lossless: 'settings.playback.qualityLossless',
  hires: 'settings.playback.qualityHires',
}

const asChkszQuality = (value: string): ChkszQuality | undefined =>
  (CHKSZ_QUALITIES as readonly string[]).includes(value) ? value as ChkszQuality : undefined

const asLxQuality = (value: string): LxQuality | undefined =>
  (LX_QUALITIES as readonly string[]).includes(value) ? value as LxQuality : undefined

function onChkszQualityChange(event: Event): void {
  const quality = asChkszQuality((event.target as HTMLSelectElement).value)
  if (quality) qualityPreferences.setChkszQuality(quality)
  chkszQuality.value = qualityPreferences.chkszQuality()
}

function onLxQualityChange(event: Event): void {
  const quality = asLxQuality((event.target as HTMLSelectElement).value)
  if (quality) qualityPreferences.setLxQuality(quality)
  lxQuality.value = qualityPreferences.lxQuality()
}

const lxSourceRepository = props.lxSourceRepository ?? getDefaultLxSourceRepository()

interface AutomaticSourceRow {
  id: UserToggleableProviderId
  label: TranslationKey
  allowed: boolean
  available: boolean
  adminDisabled: boolean
}

/**
 * LX Music is not ready for the public release, so its controls are gated on the
 * authoritative server state rather than on any local preference: the Admin must
 * report `lx` as both available and enabled. Everything LX-specific -- the source
 * toggle, the quality selector and the source manager -- reads this one value, so
 * they can never disagree, and a configuration that cannot be loaded (an empty
 * state list) fails closed to "hidden".
 */
const lxEnabled = computed(() => isProviderEnabled(providerStates.value, 'lx'))

const automaticSources = computed<AutomaticSourceRow[]>(() =>
  USER_TOGGLEABLE_PROVIDER_IDS
    // A disabled provider is removed outright, not rendered as a disabled
    // placeholder, and LX is the only provider whose absence is gated this way.
    // ChKSz and Jellyfin keep their truthful unavailable / admin-disabled rows.
    .filter((id) => id !== 'lx' || lxEnabled.value)
    .map((id) => {
      const state = providerStates.value.find((value) => value.id === id)
      const available = state?.available === true
      return {
        id,
        label: `settings.playback.source.${id}` as TranslationKey,
        allowed: !disabledProviderIds.value.has(id),
        available,
        adminDisabled: available && state?.enabled !== true,
      }
    }))

/**
 * Re-reads the authoritative provider state. `forceRefresh` bypasses the runtime
 * repository's short cache so a control an Admin has just turned off cannot
 * reappear from a stale response when Settings is reopened or the tab regains
 * focus. A failed read clears the list, which hides LX rather than reviving it.
 */
async function refreshProviderStates(forceRefresh = false): Promise<void> {
  if (!props.providerRepository) return
  try {
    providerStates.value = await props.providerRepository.states(
      forceRefresh ? { forceRefresh: true } : undefined,
    )
  } catch {
    providerStates.value = []
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void refreshProviderStates(true)
}
function onConsentStorage(event: StorageEvent): void {
  if (event.key !== AGREEMENT_STORAGE_KEY && event.key !== null) return
  agreementAccepted.value = hasCurrentAgreement()
  if (event.key === AGREEMENT_STORAGE_KEY && event.newValue === 'withdrawn') clearChkszCredential()
}

async function onAutomaticSourceChange(id: UserToggleableProviderId, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const enabling = input.checked
  if (enabling) {
    const configured = id === 'chksz' ? chkszCredentials.key() !== null
      : id === 'lx' && (await lxSourceRepository.list()).some((source) => !source.builtIn && source.enabled)
    if (configured && !await requestConsent()) {
      input.checked = !providerPreferences.isDisabled(id)
      return
    }
  }
  providerPreferences.setDisabled(id, !enabling)
}

/**
 * Provider preferences follow the session wherever the answer came from -- the shared
 * store's own request, or a sign-out published by the account view. Keyed on the revision
 * rather than on the boolean, so a sign-out that lands on an already-false flag is still
 * carried through instead of being swallowed as "no change".
 */
watch(session.revision, () => {
  void (async (): Promise<void> => {
    try {
      await providerPreferences.setSignedIn(session.signedIn.value, session.userId.value ?? undefined)
    } catch {
      // Remote synchronisation is advisory; local preferences remain in force.
    }
  })()
})

function onLocaleChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (isLocale(value)) props.preferences.setLocale(value)
}

function onBackgroundChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'ambient' || value === 'still') props.preferences.setBackgroundMode(value as BackgroundMode)
}

function onVisualStyleChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'cinematic' || value === 'studio') props.preferences.setVisualStyle(value as VisualStyle)
}

function onStudioBlur(event: Event): void {
  props.preferences.setStudioBlur(numberValue(event))
}

function onStudioGlassGray(event: Event): void {
  props.preferences.setStudioGlassGray(numberValue(event))
}

function onStudioEdge(event: Event): void {
  props.preferences.setStudioEdge(numberValue(event))
}

function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

function onVolume(event: Event): void {
  props.player.setVolume(numberValue(event))
}

async function saveChkszCredential(): Promise<void> {
  if (isChkszApiKey(chkszKey.value) && !await requestConsent()) return
  try {
    chkszCredentials.setKey(chkszKey.value, chkszRemember.value)
    chkszStatus.value = text(chkszRemember.value
      ? 'settings.playback.chkszSavedDevice'
      : 'settings.playback.chkszSavedSession')
  } catch (error) {
    if (error instanceof Error && error.message === 'unsupported_chksz_characters') {
      chkszStatus.value = text('settings.playback.chkszUnsupportedCharacters')
    } else if (error instanceof Error && error.message === 'invalid_chksz_api_key_prefix') {
      chkszStatus.value = text('settings.playback.chkszMissingPrefix')
    } else {
      chkszStatus.value = text('settings.playback.chkszInvalid')
    }
  }
}

function clearChkszCredential(): void {
  chkszCredentials.clear()
  chkszKey.value = ''
  chkszRemember.value = false
  chkszStatus.value = text('settings.playback.chkszCleared')
}

async function refreshLibrary(): Promise<void> {
  try {
    librarySnapshot.value = await props.library.exportLocalLibrary()
    storageMode.value = props.library.storageMode()
  } catch {
    libraryStatus.value = text('library.actionFailed')
  }
}

async function setHistory(event: Event): Promise<void> {
  libraryStatus.value = ''
  try {
    await props.library.setHistoryEnabled((event.target as HTMLInputElement).checked)
    await refreshLibrary()
  } catch {
    libraryStatus.value = text('library.actionFailed')
  }
}

async function clearHistory(): Promise<void> {
  libraryStatus.value = ''
  try {
    await props.library.clearHistory()
    await refreshLibrary()
  } catch {
    libraryStatus.value = text('library.actionFailed')
  }
}

async function exportLibrary(): Promise<void> {
  let url: string | undefined
  try {
    const exported = await props.library.exportLocalLibrary()
    url = URL.createObjectURL(new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'study-with-hoyomix-library.json'
    anchor.click()
    libraryStatus.value = text('library.exportReady')
  } catch {
    libraryStatus.value = text('library.actionFailed')
  } finally {
    const exportUrl = url
    if (exportUrl) setTimeout(() => URL.revokeObjectURL(exportUrl), 0)
  }
}


onMounted(() => {
  unsubscribe = props.library.subscribe((library) => {
    librarySnapshot.value = library
    storageMode.value = props.library.storageMode()
  })
  unsubscribeProviderPreferences = providerPreferences.subscribe(() => {
    disabledProviderIds.value = providerPreferences.disabledProviderIds()
  })
  unsubscribeQualityPreferences = qualityPreferences.subscribe(() => {
    chkszQuality.value = qualityPreferences.chkszQuality()
    lxQuality.value = qualityPreferences.lxQuality()
  })
  // Reopening Settings remounts this sheet, and the forced read means the answer is the
  // server's, not the last cached one. The visibility listener covers the same session
  // staying open across an Admin change.
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('storage', onConsentStorage)
  void refreshLibrary()
  void refreshProviderStates(true)
  // Resolved here rather than by whichever category happens to be open. Memoised in the
  // store, so opening four categories in turn asks once.
  void session.ensure()
})

onBeforeUnmount(() => {
  resolveConsent(false)
  unsubscribe()
  unsubscribeProviderPreferences()
  unsubscribeQualityPreferences()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('storage', onConsentStorage)
})
</script>

<template>
  <div class="settings-sheet" data-settings-sheet :data-settings-scoped="props.sections ? 'true' : 'false'">
    <nav v-if="!props.sections" class="settings-sheet__index" data-settings-index :aria-label="text('settings.index')">
      <a v-for="section in visibleSections" :key="section" :href="`#settings-${section}`">
        {{ text(`settings.section.${section}` as TranslationKey) }}
      </a>
    </nav>

    <div class="settings-sheet__grid">
      <section v-if="shows('language')" id="settings-language" class="settings-sheet__section surface-glass" data-settings-section="language">
        <h3>{{ text('settings.section.language') }}</h3>
        <label>
          <span>{{ text('preferences.language') }}</span>
          <select data-settings-locale :value="preferences.locale.value" @change="onLocaleChange">
            <option value="zh-Hant">{{ text('locale.zh-Hant') }}</option>
            <option value="zh-Hans">{{ text('locale.zh-Hans') }}</option>
            <option value="en">{{ text('locale.en') }}</option>
          </select>
        </label>
        <div>
          <h4>{{ text('settings.accessibility.shortcuts') }}</h4>
          <ul class="settings-sheet__shortcuts">
            <li><kbd>Space</kbd> {{ text('settings.shortcut.playPause') }}</li>
            <li><kbd>←</kbd> / <kbd>→</kbd> {{ text('settings.shortcut.previousNext') }}</li>
            <li><kbd>Esc</kbd> {{ text('settings.shortcut.close') }}</li>
          </ul>
        </div>
      </section>

      <section v-if="shows('appearance')" id="settings-appearance" class="settings-sheet__section surface-glass" data-settings-section="appearance">
        <h3>{{ text('settings.section.appearance') }}</h3>
        <label>
          <span>{{ text('settings.appearance.background') }}</span>
          <select data-settings-background :value="preferences.backgroundMode.value" @change="onBackgroundChange">
            <option value="ambient">{{ text('settings.appearance.ambient') }}</option>
            <option value="still">{{ text('settings.appearance.still') }}</option>
          </select>
        </label>
        <label>
          <span>{{ text('settings.appearance.visualStyle') }}</span>
          <select data-settings-visual-style :value="preferences.visualStyle.value" @change="onVisualStyleChange">
            <option value="cinematic">{{ text('settings.appearance.cinematic') }}</option>
            <option value="studio">{{ text('settings.appearance.studio') }}</option>
          </select>
        </label>
        <template v-if="preferences.visualStyle.value === 'studio'">
        <label class="settings-sheet__range">
          <span class="settings-sheet__range-label">
            <span>{{ text('settings.appearance.studioBlur') }}</span>
            <output for="settings-studio-blur" data-settings-studio-blur-output>{{ preferences.studioBlur.value }} px</output>
          </span>
          <input
            id="settings-studio-blur"
            data-settings-studio-blur
            type="range"
            :min="MIN_STUDIO_BLUR"
            :max="MAX_STUDIO_BLUR"
            step="1"
            :value="preferences.studioBlur.value"
            :disabled="preferences.visualStyle.value !== 'studio'"
            aria-describedby="settings-studio-blur-help"
            @input="onStudioBlur"
          />
          <small id="settings-studio-blur-help">{{ text('settings.appearance.studioBlurHelp') }}</small>
        </label>
        <label class="settings-sheet__range">
          <span class="settings-sheet__range-label">
            <span>{{ text('settings.appearance.studioGlassGray') }}</span>
            <output for="settings-studio-glass-gray" data-settings-studio-glass-gray-output>{{ preferences.studioGlassGray.value }}%</output>
          </span>
          <input
            id="settings-studio-glass-gray"
            data-settings-studio-glass-gray
            type="range"
            :min="MIN_STUDIO_GLASS_GRAY"
            :max="MAX_STUDIO_GLASS_GRAY"
            step="1"
            :value="preferences.studioGlassGray.value"
            :disabled="preferences.visualStyle.value !== 'studio'"
            aria-describedby="settings-studio-glass-gray-help"
            @input="onStudioGlassGray"
          />
          <small id="settings-studio-glass-gray-help">{{ text('settings.appearance.studioGlassGrayHelp') }}</small>
        </label>
        <label class="settings-sheet__range">
          <span class="settings-sheet__range-label">
            <span>{{ text('settings.appearance.studioEdge') }}</span>
            <output for="settings-studio-edge" data-settings-studio-edge-output>{{ preferences.studioEdge.value }}%</output>
          </span>
          <input
            id="settings-studio-edge"
            data-settings-studio-edge
            type="range"
            :min="MIN_STUDIO_EDGE"
            :max="MAX_STUDIO_EDGE"
            step="1"
            :value="preferences.studioEdge.value"
            :disabled="preferences.visualStyle.value !== 'studio'"
            aria-describedby="settings-studio-edge-help"
            @input="onStudioEdge"
          />
          <small id="settings-studio-edge-help">{{ text('settings.appearance.studioEdgeHelp') }}</small>
        </label>
        </template>
        <BackgroundGallery
          :store="backgroundStore"
          :locale="preferences.locale.value"
          :signed-in="signedIn"
        />
      </section>

      <section v-if="shows('pomodoro')" id="settings-pomodoro" class="settings-sheet__section surface-glass" data-settings-section="pomodoro">
        <h3>{{ text('settings.section.pomodoro') }}</h3>
        <p v-if="pomodoroStore.status.value === 'running'">{{ text('settings.pomodoro.pauseToEdit') }}</p>
        <div class="settings-sheet__fields">
          <label><span>{{ text('pomodoro.focusMinutes') }}</span><input data-settings-focus type="number" min="1" max="120" :disabled="pomodoroStore.status.value === 'running'" :value="pomodoroStore.focusMinutes.value" @change="pomodoroStore.setFocusMinutes(numberValue($event))" /></label>
          <label><span>{{ text('settings.pomodoro.shortBreak') }}</span><input data-settings-short-break type="number" min="1" max="60" :disabled="pomodoroStore.status.value === 'running'" :value="pomodoroStore.breakMinutes.value" @change="pomodoroStore.setBreakMinutes(numberValue($event))" /></label>
          <label><span>{{ text('settings.pomodoro.longBreak') }}</span><input data-settings-long-break type="number" min="1" max="120" :disabled="pomodoroStore.status.value === 'running'" :value="pomodoroStore.longBreakMinutes.value" @change="pomodoroStore.setLongBreakMinutes(numberValue($event))" /></label>
          <label><span>{{ text('pomodoro.cycles') }}</span><input data-settings-cycles type="number" min="1" max="12" :disabled="pomodoroStore.status.value === 'running'" :value="pomodoroStore.cycleCount.value" @change="pomodoroStore.setCycleCount(numberValue($event))" /></label>
        </div>
        <label class="settings-sheet__toggle">
          <input
            data-settings-pause-music
            type="checkbox"
            :checked="pomodoroStore.pauseMusicDuringBreak.value"
            @change="pomodoroStore.setPauseMusicDuringBreak(($event.target as HTMLInputElement).checked)"
          />
          <span>{{ text('settings.pomodoro.pauseMusic') }}</span>
        </label>
        <label>
          <span>{{ text('settings.pomodoro.focusBehaviour') }}</span>
          <select data-settings-focus-behaviour :value="pomodoroStore.focusBehaviour.value" @change="pomodoroStore.setFocusBehaviour(($event.target as HTMLSelectElement).value as FocusBehaviour)">
            <option value="continue">{{ text('settings.pomodoro.focusBehaviourContinue') }}</option>
            <option value="pauseWhenHidden">{{ text('settings.pomodoro.focusBehaviourPauseWhenHidden') }}</option>
          </select>
        </label>
        <FocusHistoryControls
          :repository="focusRepository"
          :history-status="focusHistoryStatus"
          :remote-repository="remoteFocusRepository"
          :signed-in="signedIn"
          @open-calendar="emit('open-calendar')"
        />
      </section>


      <section v-if="shows('playback')" id="settings-playback" class="settings-sheet__section surface-glass" data-settings-section="playback">
        <h3>{{ text('settings.section.playback') }}</h3>
        <ThirdPartyAgreement :locale="preferences.locale.value" :pending="agreementPending" :accepted="agreementAccepted" @accept="resolveConsent(true)" @cancel="resolveConsent(false)" @withdraw="revokeSourceConsent" />
        <label>
          <span>{{ text('player.volume') }}</span>
          <input data-settings-volume type="range" min="0" max="1" step="0.05" :value="player.volume.value" @input="onVolume" />
        </label>
        <fieldset class="settings-sheet__sources" data-settings-automatic-sources>
          <legend>{{ text('settings.playback.automaticSources') }}</legend>
          <p data-settings-provider-order>{{ text('settings.playback.providerOrder') }}</p>
          <p data-settings-provider-limits>{{ text('settings.playback.automaticSourcesHelp') }}</p>
          <p data-settings-automatic-sources-scope>
            {{ text(signedIn
              ? 'settings.playback.automaticSourcesSignedIn'
              : 'settings.playback.automaticSourcesAnonymous') }}
          </p>
          <label
            v-for="source in automaticSources"
            :key="source.id"
            class="settings-sheet__toggle"
            :data-settings-source="source.id"
          >
            <input
              type="checkbox"
              :checked="source.allowed"
              :disabled="!source.available"
              :aria-describedby="source.available && !source.adminDisabled ? undefined : `settings-source-${source.id}-state`"
              @change="onAutomaticSourceChange(source.id, $event)"
            />
            <span>{{ text(source.label) }}</span>
            <small
              v-if="!source.available"
              :id="`settings-source-${source.id}-state`"
              data-settings-source-state="unavailable"
            >{{ text('settings.playback.sourceUnavailable') }}</small>
            <small
              v-else-if="source.adminDisabled"
              :id="`settings-source-${source.id}-state`"
              data-settings-source-state="admin-disabled"
            >{{ text('settings.playback.sourceAdminDisabled') }}</small>
          </label>
        </fieldset>
        <form class="settings-sheet__credential" data-settings-chksz @submit.prevent="saveChkszCredential">
          <h4>{{ text('settings.playback.chkszTitle') }} <ChkszInfo :locale="preferences.locale.value" /></h4>
          <p>{{ text('settings.playback.chkszExplanation') }}</p>
          <p data-settings-chksz-devtools-notice>{{ text('settings.playback.chkszDevtoolsNotice') }}</p>
          <label>
            <span>{{ text('settings.playback.chkszKey') }}</span>
            <input
              v-model="chkszKey"
              data-settings-chksz-key
              type="password"
              autocomplete="off"
              maxlength="512"
            />
          </label>
          <label class="settings-sheet__toggle">
            <input v-model="chkszRemember" data-settings-chksz-remember type="checkbox" />
            <span>{{ text('settings.playback.chkszRemember') }}</span>
          </label>
          <label>
            <span>{{ text('settings.playback.chkszQuality') }}</span>
            <select data-settings-chksz-quality :value="chkszQuality" @change="onChkszQualityChange">
              <option v-for="quality in CHKSZ_QUALITIES" :key="quality" :value="quality">
                {{ text(CHKSZ_QUALITY_LABEL_KEYS[quality]) }}
              </option>
            </select>
          </label>
          <div class="settings-sheet__actions">
            <button data-settings-chksz-save type="submit">{{ text('settings.playback.chkszSave') }}</button>
            <button data-settings-chksz-clear type="button" @click="clearChkszCredential">
              {{ text('settings.playback.chkszClear') }}
            </button>
          </div>
          <p v-if="chkszStatus" data-settings-chksz-status role="status" aria-live="polite">{{ chkszStatus }}</p>
        </form>
        <!--
          Rendered only while the Admin reports LX as available and enabled. The whole
          block goes, headings and explanation included, so a disabled provider leaves no
          empty section or disabled placeholder behind. Nothing here is cleared on hide:
          the stored quality and the imported sources survive for a later re-enable.
        -->
        <div v-if="lxEnabled" class="settings-sheet__credential" data-settings-lx>
          <h4>{{ text('settings.playback.lxTitle') }}</h4>
          <label>
            <span>{{ text('settings.playback.lxQuality') }}</span>
            <select data-settings-lx-quality :value="lxQuality" @change="onLxQualityChange">
              <option v-for="quality in LX_QUALITIES" :key="quality" :value="quality">
                {{ text(LX_QUALITY_LABEL_KEYS[quality]) }}
              </option>
            </select>
          </label>
          <LxSourceManager
            :key="lxConsentRevision"
            :locale="preferences.locale.value"
            :repository="lxSourceRepository"
            :request-consent="requestConsent"
          />
        </div>
        <dl class="settings-sheet__facts">
          <div><dt>{{ text('settings.playback.queue') }}</dt><dd>{{ text('settings.playback.queueDeterministic').replace('{count}', String(player.queue.value.length)) }}</dd></div>
          <div><dt>{{ text('settings.playback.providers') }}</dt><dd>{{ player.enabledProviderIds.value.join(', ') || text('player.statusNoSource') }}</dd></div>
          <div><dt>{{ text('settings.playback.currentSource') }}</dt><dd>{{ currentSource }}</dd></div>
        </dl>
        <button type="button" @click="emit('open-library')">{{ text('player.queueSourceDetails') }}</button>
      </section>

      <section v-if="shows('library')" id="settings-library" class="settings-sheet__section surface-glass" data-settings-section="library">
        <h3>{{ text('settings.section.library') }}</h3>
        <button data-settings-open-library type="button" @click="emit('open-library')">{{ text('workspace.openLibrary') }}</button>
        <label class="settings-sheet__toggle">
          <input data-settings-history type="checkbox" :checked="librarySnapshot.preferences.historyEnabled" @change="setHistory" />
          <span>{{ text('library.historyOptIn') }}</span>
        </label>
        <p>{{ librarySnapshot.recentHistory.length }} {{ text('library.historyCount') }}</p>
        <div class="settings-sheet__actions">
          <button type="button" @click="clearHistory">{{ text('library.clearHistory') }}</button>
          <button type="button" @click="exportLibrary">{{ text('library.export') }}</button>
        </div>
        <p>{{ text(storageMode === 'memory' ? 'library.memoryOnlyNotice' : 'settings.library.persistent') }}</p>
        <p role="status" aria-live="polite">{{ libraryStatus }}</p>
      </section>

      <section v-if="shows('account')" id="settings-account" class="settings-sheet__section surface-glass" data-settings-section="account" data-account-section>
        <h3>{{ text('settings.section.account') }}</h3>
        <AccountMenu
          embedded
          :local-repository="library"
          :focus-repository="focusRepository"
          :player="player"
        />
      </section>

      <section v-if="shows('application')" id="settings-application" class="settings-sheet__section surface-glass" data-settings-section="application">
        <h3>{{ text('settings.section.application') }}</h3>
        <div class="settings-sheet__status-row"><strong>{{ text('settings.application.pwa') }}</strong><span>{{ text(pwaStatusKey) }}</span></div>
        <p data-settings-pwa-update-state>{{ text(`pwa.update.state.${pwaUpdateStatus.state.value}` as TranslationKey) }}</p>
        <label class="settings-sheet__toggle">
          <input data-settings-study-tips type="checkbox" :checked="preferences.studyTipsEnabled.value" @change="preferences.setStudyTipsEnabled(($event.target as HTMLInputElement).checked)" />
          <span>{{ text('studyTips.setting') }}</span>
        </label>
        <!--
          Fullscreen is a workspace command, not a preference, so it is only rendered when
          a workspace supplies its live state. The F shortcut remains the fast path; this
          is the discoverable one, and it replaces the rail that used to carry it.
        -->
        <div v-if="props.fullscreenState" class="settings-sheet__actions">
          <button
            type="button"
            data-settings-fullscreen
            :aria-pressed="props.fullscreenState === 'active' ? 'true' : 'false'"
            :aria-disabled="props.fullscreenState === 'unavailable' ? 'true' : undefined"
            :disabled="props.fullscreenState === 'unavailable'"
            @click="emit('toggle-fullscreen')"
          >
            {{ text(
              props.fullscreenState === 'active' ? 'workspace.fullscreenExit'
              : props.fullscreenState === 'error' ? 'workspace.fullscreenFailed'
              : props.fullscreenState === 'unavailable' ? 'workspace.fullscreenUnavailable'
              : 'workspace.fullscreenEnter',
            ) }}
          </button>
        </div>
        <NoticeHistory />
      </section>

      <!-- Accuracy evidence: the original development notes -->
      <section v-if="shows('about')" id="settings-about" class="settings-sheet__section settings-sheet__disclosure surface-glass" data-settings-section="about" aria-labelledby="settings-about-title">
        <h3 id="settings-about-title">{{ text('settings.section.about') }}</h3>
        <p data-about-identity>{{ text('settings.about.identity') }}</p>
        <p class="settings-sheet__notice" data-about-unofficial>{{ text('settings.about.unofficial') }}</p>

        <h4>{{ text('settings.about.licenceHeading') }}</h4>
        <p data-about-licence>{{ text('settings.about.licence') }}</p>

        <h4>{{ text('settings.about.lineageHeading') }}</h4>
        <p data-about-lineage>{{ text('settings.about.lineage') }}</p>
        <p data-about-liquid-glass>{{ text('settings.about.liquidGlass') }}</p>
        <p>{{ text('settings.about.lineageDocs') }}</p>

        <h4>{{ text('settings.about.provenanceHeading') }}</h4>
        <p>{{ text('settings.about.provenance') }}</p>
        <p class="settings-sheet__notice" data-about-provenance-open>{{ text('settings.about.provenanceOpen') }}</p>
        <ul class="settings-sheet__links" data-about-links>
          <li v-for="link in aboutLinks" :key="link.href">
            <a :href="link.href" target="_blank" rel="noopener noreferrer">
              {{ text(link.label) }}<span class="sr-only"> ({{ text('settings.links.newTab') }})</span>
            </a>
          </li>
        </ul>
      </section>

      <section v-if="shows('privacy')" id="settings-privacy" class="settings-sheet__section settings-sheet__disclosure surface-glass" data-settings-section="privacy" aria-labelledby="settings-privacy-title">
        <h3 id="settings-privacy-title">{{ text('settings.section.privacy') }}</h3>
        <p data-privacy-summary>{{ text('settings.privacy.summary') }}</p>

        <h4>{{ text('settings.privacy.deviceHeading') }}</h4>
        <p data-privacy-device>{{ text('settings.privacy.device') }}</p>

        <h4>{{ text('settings.privacy.accountHeading') }}</h4>
        <p data-privacy-account>{{ text('settings.privacy.account') }}</p>
        <p data-privacy-session>{{ text('settings.privacy.session') }}</p>

        <h4>{{ text('settings.privacy.syncHeading') }}</h4>
        <p data-privacy-sync>{{ text('settings.privacy.sync') }}</p>
        <p data-privacy-focus>{{ text('settings.privacy.focus') }}</p>
        <p data-privacy-history>{{ text('settings.privacy.history') }}</p>
        <p data-privacy-backgrounds>{{ text('settings.privacy.backgrounds') }}</p>
        <p data-privacy-provider-sync>{{ text('settings.privacy.providerSync') }}</p>

        <h4>{{ text('settings.privacy.providerHeading') }}</h4>
        <p data-privacy-provider-key>{{ text('settings.privacy.providerKey') }}</p>
        <p data-privacy-operator-keys>{{ text('settings.privacy.operatorKeys') }}</p>
        <p data-privacy-media-urls>{{ text('settings.privacy.mediaUrls') }}</p>

        <h4>{{ text('settings.privacy.controlsHeading') }}</h4>
        <p data-privacy-export>{{ text('settings.privacy.export') }}</p>
        <p data-privacy-deletion>{{ text('settings.privacy.deletion') }}</p>

        <h4>{{ text('settings.privacy.analyticsHeading') }}</h4>
        <p data-privacy-analytics-state :data-analytics-enabled="analyticsEnabled ? 'true' : 'false'">{{ text(analyticsEnabled ? 'settings.privacy.analyticsEnabled' : 'settings.privacy.analyticsDisabled') }}</p>
        <p data-privacy-analytics>{{ text('settings.privacy.analytics') }}</p>
        <p>{{ text('settings.privacy.policiesHeading') }}</p>
        <ul class="settings-sheet__links" data-privacy-links>
          <li v-for="link in privacyLinks" :key="link.href">
            <a :href="link.href" target="_blank" rel="noopener noreferrer">
              {{ text(link.label) }}<span class="sr-only"> ({{ text('settings.links.newTab') }})</span>
            </a>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-sheet { display: grid; gap: 1rem; min-width: 0; padding: 1rem; color: var(--colour-text-primary); }
.settings-sheet__index { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.settings-sheet__index a { display: inline-flex; min-height: 2.75rem; align-items: center; padding: 0.5rem 0.75rem; color: var(--colour-accent-strong); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; font-size: 0.875rem; font-weight: 650; text-underline-offset: 0.25em; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
.settings-sheet__index a:hover { filter: var(--control-hover-filter); }
.settings-sheet__index a:active { transform: scale(0.96); filter: var(--control-active-filter); }
.settings-sheet__grid { display: grid; gap: 1rem; min-width: 0; }
.settings-sheet__section { display: grid; gap: 0.75rem; min-width: 0; padding: 1rem; scroll-margin-top: 1rem; border-radius: var(--radius-surface); }
.settings-sheet h3, .settings-sheet h4, .settings-sheet p, .settings-sheet ul, .settings-sheet dl, .settings-sheet dd { margin: 0; }
.settings-sheet h3 { font-size: 1rem; }
.settings-sheet__disclosure { overflow-wrap: anywhere; }
.settings-sheet__disclosure h4 { color: var(--colour-text-primary); margin-block-start: 0.5rem; }
.settings-sheet__links { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
.settings-sheet__links li { min-width: 0; max-width: 100%; }
.settings-sheet__links a { display: inline-flex; align-items: center; min-height: 2.75rem; color: var(--colour-accent-strong); font-size: 0.875rem; line-height: 1.5; text-underline-offset: 0.25em; }
.settings-sheet__links .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.settings-sheet h4, .settings-sheet p, .settings-sheet dt, .settings-sheet dd, .settings-sheet label { color: var(--colour-text-muted); font-size: 0.875rem; line-height: 1.5; }
.settings-sheet label, .settings-sheet__fields { display: grid; gap: 0.5rem; }
.settings-sheet__fields { grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); }
.settings-sheet select, .settings-sheet input, .settings-sheet button { min-height: 2.75rem; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; font: inherit; min-width: 0; max-width: 100%; }
.settings-sheet select { width: 100%; text-overflow: ellipsis; }
.settings-sheet select, .settings-sheet button, .settings-sheet input[type="range"], .settings-sheet input[type="checkbox"] { cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
.settings-sheet select:hover, .settings-sheet button:hover:not(:disabled), .settings-sheet input:hover { filter: var(--control-hover-filter); }
.settings-sheet select:active, .settings-sheet button:active:not(:disabled) { transform: scale(0.96); filter: var(--control-active-filter); }
.settings-sheet button:disabled, .settings-sheet input:disabled { cursor: not-allowed; opacity: 0.55; }
.settings-sheet input[type="range"] {
  /* The shared input rule pads and borders every field. On a range that padding
     becomes dead travel: the thumb stops short of both ends, and the bordered box
     is what reads as the bar. A range has to be the track itself. */
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-height: 2.75rem;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  accent-color: var(--colour-accent);
  overflow: visible;
}
.settings-sheet input[type="range"]:active { transform: none; }

.settings-sheet__range-label { display: flex; gap: 1rem; align-items: baseline; justify-content: space-between; }
.settings-sheet__range-label output { color: var(--colour-text-primary); font-variant-numeric: tabular-nums; font-weight: 700; }
.settings-sheet__range small { color: var(--colour-text-muted); line-height: 1.5; }
.settings-sheet .settings-sheet__toggle { display: flex; min-height: 2.75rem; gap: 0.75rem; align-items: center; }
.settings-sheet .settings-sheet__toggle input { width: 1.25rem; min-height: 1.25rem; padding: 0; accent-color: var(--colour-accent); }
.settings-sheet__status-row, .settings-sheet__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; justify-content: space-between; }
.settings-sheet__status-row span, .settings-sheet__notice { color: var(--colour-accent-strong); }
.settings-sheet__shortcuts { display: grid; gap: 0.5rem; padding-inline-start: 1.25rem; color: var(--colour-text-muted); font-size: 0.875rem; }
kbd { padding: 0.25rem 0.5rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.25rem; font-family: "Courier New", monospace; }
.settings-sheet__facts { display: grid; gap: 0.5rem; }
.settings-sheet__facts div { display: grid; gap: 0.25rem; }
.settings-sheet__facts dt { font-weight: 700; }
.settings-sheet__facts dd { overflow-wrap: anywhere; }
.settings-sheet__credential { display: grid; gap: 0.75rem; min-width: 0; padding-block: 0.5rem; }
.settings-sheet__sources { display: grid; gap: 0.5rem; min-width: 0; margin: 0; padding: 0.75rem; border: var(--glass-border); border-radius: 0.5rem; }
.settings-sheet__sources legend { padding-inline: 0.25rem; color: var(--colour-text-primary); font-size: 0.875rem; font-weight: 700; }
.settings-sheet__sources small { color: var(--colour-accent-strong); font-size: 0.75rem; }
.settings-sheet__sources .settings-sheet__toggle { flex-wrap: wrap; }
@media (min-width: 48rem) { .settings-sheet__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/*
 * Inside the Control Center the sheet is one category's panel, not the whole of Settings,
 * so it drops the two-column grid and the padding the standalone sheet needs: the hub's
 * panel already supplies the inset, and a lone section in a 1fr column of two would sit
 * in half the width with nothing beside it.
 */
.settings-sheet[data-settings-scoped="true"] { padding: 0; }
@media (min-width: 48rem) {
  .settings-sheet[data-settings-scoped="true"] .settings-sheet__grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
