<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { createCatalogFilterState } from '../catalog/filterState'
import { CatalogRepository } from '../catalog/repository'
import { runtimeCatalog } from '../catalog/runtimeCatalog'
import { loadRemoteCatalog } from '../catalog/remoteCatalog'
import ChatAvailability from '../chat/ChatAvailability.vue'
import FloatingChatWindow from '../chat/FloatingChatWindow.vue'
import { getDefaultBackgroundStore } from '../backgrounds/store'
import BackgroundSwitcher from '../backgrounds/BackgroundSwitcher.vue'
import FocusSummary from '../focus/FocusSummary.vue'
import { createAccountFocusRepository } from '../focus/accountRepository'
import { useAccountSession } from '../account/session'
import { automaticSyncStatus } from '../account/automaticSync'
import { createWorkspaceAccountSync } from '../account/workspaceSync'
import { createPomodoroFocusRecorder } from '../focus/pomodoroRecorder'
import { deriveFocusStatistics } from '../focus/statistics'
import StudyCalendar from '../focus/StudyCalendar.vue'
import type { FocusSessionRecord } from '../focus/types'
import LibrarySheet from '../library/LibrarySheet.vue'
import { getDefaultLocalLibraryRepository } from '../library/localRepository'
import PlayerBar from '../player/PlayerBar.vue'
import QueueDrawer from '../player/QueueDrawer.vue'
import { playbackCommands } from '../player/commands'
import { createProviderPreferencesStore } from '../player/providerPreferences'
import { createRuntimeProviderRepository } from '../player/runtimeConfig'
import { createPlaybackStore } from '../player/store'
import { getDefaultPlaybackQualityPreferencesStore } from '../player/qualityPreferences'
import {
  createPomodoroStore,
  PomodoroFocusQueueCapacityError,
} from '../timers/pomodoro/store'
import {
  createPomodoroWorkspaceEffects,
  playPomodoroCompletionSound,
} from '../timers/pomodoro/workspaceEffects'
import { createSleepTimerStore } from '../timers/sleep/store'
import SettingsSheet from '../settings/SettingsSheet.vue'
import { MAX_STUDIO_EDGE, MAX_STUDIO_GLASS_GRAY, usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
import ControlCentre, { type ControlCentreSection } from './ControlCentre.vue'
import FocusBar from './FocusBar.vue'
import { createWorkspaceFullscreen } from './fullscreen'
import { createFocusVisibilityController } from './focusVisibility'
import OverlaySheet from './OverlaySheet.vue'
import SceneBackdrop from './SceneBackdrop.vue'
import StudioGlassCanvas from '../liquid-glass/StudioGlassCanvas.vue'
import { usePwaUpdateStatus } from '../../pwa/updateStatus'
import PwaUpdateNotice from './PwaUpdateNotice.vue'
import NoticeCentre from '../notices/NoticeCentre.vue'
import StudyTipCard from './StudyTipCard.vue'
import { getStudyTip } from './studyTips'

/**
 * The Focus summary is the one sheet left outside the Control Center. It is not a
 * secondary tool the user goes looking for -- it is raised by a Pomodoro session ending,
 * so it interrupts rather than being navigated to, and putting it behind a category would
 * mean the hub opening itself while the user was working.
 */
type WorkspaceSheet = 'focusSummary'
type FocusHistoryStatus = 'storage_error' | 'pending_overflow' | 'overflow_full'

const preferences = usePreferences()
const pwaUpdateStatus = usePwaUpdateStatus()
const { backgroundMode, locale, lowPower, studioBlur, studioGlassGray, studioEdge, visualStyle } = preferences
const text = (key: TranslationKey): string => translate(locale.value, key)
const studyTip = computed(() => getStudyTip(locale.value, Math.floor(Date.now() / 86_400_000)))
const demoCatalogue = import.meta.env.VITE_ENABLE_DEMO_CATALOG === 'true'
const catalogue = shallowRef(runtimeCatalog(demoCatalogue))
const catalogueLoadStatus = ref<'bundled'|'loading'|'published'|'fallback'>('bundled')
const catalogueReplacementEpoch = ref(0)
const filters = createCatalogFilterState(catalogue.value.tracks)
const workspaceRoot = ref<HTMLElement>()
const focusBarBottom = ref(0)
const playerControlsTop = ref(0)
const playerTop = ref(0)
const fullscreen = createWorkspaceFullscreen(workspaceRoot)
const activeSheet = ref<WorkspaceSheet>()
const controlCentreOpen = ref(false)
const queueOpen = ref(false)
const focusPopoverOpen = ref(false)
/**
 * Preserved for the browser session, not the install. Reopening the hub where the user
 * left it is what makes it feel like one place; remembering that across a reload would
 * mean a fresh visit opening on Privacy because that is where the last one ended.
 */
const controlCentreSection = ref<ControlCentreSection>('focus')
/**
 * Chat is closed on each fresh load. Visibility belongs to this page session and changes
 * only through the explicit open and close commands; only its layout is persisted.
 */
const chatOpen = ref(false)
const chatWindow = ref<InstanceType<typeof FloatingChatWindow>>()
// Set for exactly one hub close: the "Focus chat window" command. Not reactive, because
// nothing renders from it -- it only tells the closing hub where focus belongs.
let chatHandoffPending = false
// One modal at a time owns the screen, and every surface underneath reads this.
const modalOpen = computed(() => controlCentreOpen.value || Boolean(activeSheet.value))
const resolvedTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
const focusSessions = ref<FocusSessionRecord[]>([])
const summaryRecord = ref<FocusSessionRecord>()
const focusHistoryStatus = ref<FocusHistoryStatus>()
const accountSession = useAccountSession()
const accountFocus = createAccountFocusRepository(accountSession.userId)
const focusRepository = accountFocus.repository
let focusScopeEpoch = 0
watch(accountSession.userId, () => {
  focusScopeEpoch += 1
  summaryRecord.value = undefined
  if (activeSheet.value === 'focusSummary') activeSheet.value = undefined
}, { flush: 'sync' })
let workspaceDestroyed = false
const unsubscribeFocusSessions = focusRepository.subscribe((sessions) => {
  if (!workspaceDestroyed) focusSessions.value = sessions
})
const initialFocusScope = focusScopeEpoch
void focusRepository.list().then((sessions) => {
  if (!workspaceDestroyed && initialFocusScope === focusScopeEpoch) focusSessions.value = sessions
}).catch(error => {
  if (!workspaceDestroyed && initialFocusScope === focusScopeEpoch) onFocusHistoryError(error)
})
const focusStatistics = computed(() => deriveFocusStatistics(focusSessions.value, {
  now: new Date().toISOString(),
  timeZone: resolvedTimeZone,
}))
// The workspace owns each semantic modal transition, so it names the return-focus target
// for sheets that no user gesture opened and for intentional sheet-to-sheet handoffs.
function liveFocusControl(): HTMLElement | undefined {
  return workspaceRoot.value?.querySelector<HTMLElement>([
    '[data-focus-pomodoro-pause]',
    '[data-focus-pomodoro-resume]',
    '[data-focus-pomodoro-start]',
  ].join(',')) ?? undefined
}

/**
 * The bar's own activation surface is what opened the hub, so it is where focus returns.
 * It is a permanent control rather than a disclosed one, so unlike the tray command it
 * replaces it cannot have been unmounted while the hub was open.
 */
function controlCentreOpener(): HTMLElement | undefined {
  return workspaceRoot.value?.querySelector<HTMLElement>('[data-focus-control-centre]') ?? undefined
}

/**
 * How far down the top bar reaches, measured rather than assumed: it is one row on a
 * desktop and wraps to two on a phone, so a constant would be wrong on one of them. The
 * chat window keeps below this, because the bar sits above the window in the layer order
 * and a header underneath it can neither be grabbed nor closed.
 */
function obstructedTop(): number {
  const bar = workspaceRoot.value?.querySelector<HTMLElement>('.focus-bar')
  if (!bar) return 0
  const rect = bar.getBoundingClientRect()
  return rect.height < 1 ? 0 : rect.bottom
}

// Popovers share the space between the live toolbar and playback controls. Observe
// geometry, not labels or playback state: fonts, locale and viewport all affect it.
function updatePopoverBounds(): void {
  if (workspaceDestroyed) return
  focusBarBottom.value = obstructedTop()
  const controls = workspaceRoot.value?.querySelectorAll<HTMLElement>('.player-bar__controls, .player-bar__progress')
  const tops = [...(controls ?? [])].map(element => element.getBoundingClientRect())
    .filter(rect => rect.height > 0).map(rect => rect.top)
  // The seek slider precedes the transport; both are playback controls.
  playerControlsTop.value = Math.min(window.innerHeight, ...tops)
  const player = workspaceRoot.value?.querySelector<HTMLElement>('[data-workspace-zone="player"]')?.getBoundingClientRect()
  playerTop.value = player && player.height > 0 ? player.top : window.innerHeight
}

/**
 * The full player card is a preferred avoidance region. Subsequent rectangles are hard
 * playback controls: seek/progress, transport, volume and queue.
 */
function playerRegions(): { x: number; y: number; width: number; height: number }[] {
  const zone = workspaceRoot.value?.querySelector<HTMLElement>('[data-workspace-zone="player"]')
  if (!zone) return []
  const zoneRect = zone.getBoundingClientRect()
  if (zoneRect.width < 1 || zoneRect.height < 1) return []
  const toRect = (rect: DOMRect) => ({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  })
  const regions = [toRect(zoneRect)]
  for (const selector of ['.player-bar__progress', '.player-bar__controls']) {
    const rect = zone.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) regions.push(toRect(rect))
  }
  const advancedPopover = workspaceRoot.value?.querySelector<HTMLElement>('[data-advanced-filters]')
  if (advancedPopover) {
    const rect = advancedPopover.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) regions.push(toRect(rect))
  }
  return regions
}

const focusRecorder = createPomodoroFocusRecorder({
  repository: accountFocus.timerRepository,
  onError: onFocusHistoryError,
  onSummary(record) {
    if (workspaceDestroyed || !accountFocus.ownsCurrentRun(record.id)) return
    summaryRecord.value = record
    // A phase ending interrupts, so it replaces the hub rather than stacking on top of
    // it: one modal owns the screen at a time, and the summary is the newer truth.
    controlCentreOpen.value = false
    activeSheet.value = 'focusSummary'
  },
})
const pomodoroEffects = createPomodoroWorkspaceEffects({
  playback: playbackCommands,
  playCompletionSound: playPomodoroCompletionSound,
})
const pomodoroStore = createPomodoroStore({
  onControl: pomodoroEffects.onControl,
  onFocusRunStarted: run => accountFocus.claimRun(run.id),
  onFocusSessionError: onFocusHistoryError,
  onFocusSessionFinalized: focusRecorder.onFinalized,
  onPhaseExpired: pomodoroEffects.onPhaseExpired,
})
const focusVisibility = createFocusVisibilityController({ document, pomodoroStore })
// One provider-preference store is created before the runtime repository so that
// playback and Settings share the same exclusion state and revision.
const providerPreferences = createProviderPreferencesStore()
const providerRepository = createRuntimeProviderRepository({ providerPreferences })
void providerRepository.prefetch()
const player = createPlaybackStore({ loadRegistry: providerRepository.load })
const unsubscribeProviderPreferences = providerPreferences.subscribe(() => player.invalidatePreload())
// A quality change makes any prepared next track wrong: it was resolved at the previous tier, so
// promoting it would play the old quality. Invalidating drops the preparation, and the player
// re-arms it — at the new tier — once the active track is inside its preload lead window.
const unsubscribeQualityPreferences = getDefaultPlaybackQualityPreferencesStore()
  .subscribe(() => player.invalidatePreload())
const library = getDefaultLocalLibraryRepository()
const backgroundStore = getDefaultBackgroundStore()
const accountSync = createWorkspaceAccountSync({ preferences, player, backgrounds: backgroundStore, focus: accountFocus })
const sleepTimer = createSleepTimerStore({ player: playbackCommands })
let recordedPlaybackGeneration = -1

const filterStateSnapshot = computed(() => JSON.stringify({
  games: filters.games.value,
  mode: filters.mode.value,
  relationIds: filters.relationIds.value,
}))
const queueRepository = computed(() => new CatalogRepository(catalogue.value.tracks))
const structuralQueueTracks = computed(() => queueRepository.value.query({
  games: [...filters.games.value],
  tabs: filters.mode.value ? [filters.mode.value] : [],
  relationIds: [...filters.relationIds.value],
}))

watch([filterStateSnapshot, catalogueReplacementEpoch], ([snapshot, epoch], previous) => {
  if (previous[0] !== undefined && snapshot !== previous[0]) {
    player.reconcileUpcomingQueue(structuralQueueTracks.value)
  } else if (previous[1] !== undefined && epoch !== previous[1]) {
    player.replaceQueueSource(structuralQueueTracks.value)
  } else {
    player.reconcileUpcomingQueue(structuralQueueTracks.value)
  }
}, { immediate: true })

function onFocusHistoryError(error: unknown): void {
  if (workspaceDestroyed || focusHistoryStatus.value === 'overflow_full') return
  focusHistoryStatus.value = error instanceof PomodoroFocusQueueCapacityError
    ? error.code
    : 'storage_error'
}

watch(
  [player.status, player.currentTrack, player.playbackGeneration],
  ([status, track, generation]) => {
    if (status !== 'playing' || !track || generation === recordedPlaybackGeneration) return
    recordedPlaybackGeneration = generation
    void library.recordRecent(track.id)
  },
)

// Choosing a Library track returns to the listening scene. Playback's shared
// transport remains in the hub, including when it changes track or source.
watch(
  player.playbackGeneration,
  () => {
    if (controlCentreOpen.value && controlCentreSection.value === 'library'
      && player.playbackIntent.value === 'playing') {
      controlCentreOpen.value = false
    }
  },
  { flush: 'sync' },
)

/**
 * Every route into the secondary UI lands here, which is what keeps one hub rather than
 * several competing full-screen surfaces: the bar opens it on the remembered category,
 * and a specific request -- the player's Library command, Settings' calendar link --
 * opens the same hub on the category that answers it.
 */
function openControlCentre(section?: ControlCentreSection): void {
  if (section) controlCentreSection.value = section
  controlCentreOpen.value = true
}

function onToggleAdvanced(): void {
  void nextTick(() => {
    updatePopoverBounds()
    chatWindow.value?.renegotiate()
  })
}

function openChatWindow(): void {
  chatOpen.value = true
  controlCentreOpen.value = false
}

/**
 * The hub closes and focus lands on the chat window. The move is expressed as a
 * return-focus target rather than performed here, because the sheet is the one authority
 * over focus on close: a second call racing its restoration would sometimes win and
 * sometimes not, which is exactly the kind of focus behaviour a keyboard user cannot
 * learn.
 */
function focusChatWindow(): void {
  chatHandoffPending = true
  controlCentreOpen.value = false
  chatWindow.value?.reconcile()
}

/**
 * Resolved by the hub as it closes, after the closing patch, so it names a live element.
 * A pending chat handoff is spent here; every other close returns focus to the bar's
 * activation surface, which is the control the user would reach for next and is always
 * present, so focus is never left on a removed element.
 */
function controlCentreReturnTarget(): HTMLElement | undefined {
  if (!chatHandoffPending) return controlCentreOpener()
  chatHandoffPending = false
  return chatWindow.value?.windowElement() ?? controlCentreOpener()
}

/** Closing the window hands focus to the bar, where the recovery path starts. */
function closeChatWindow(): void {
  chatOpen.value = false
  void nextTick(() => controlCentreOpener()?.focus())
}

function onWorkspaceShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (event.key.toLowerCase() !== 'f' || event.defaultPrevented
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (modalOpen.value || fullscreen.state.value === 'unavailable') return
  if (target?.matches('input, textarea, select, button, a, [contenteditable], [contenteditable="true"]')) return
  event.preventDefault()
  void fullscreen.toggle()
}

/**
 * The player is a compact bar until media plays and much taller once an official embed
 * appears inside it. The chat window derives its first-visit placement from the player's
 * measured region, so that region changing is the moment the derivation is stale -- on a
 * narrow viewport, where the player spans the full width, an embed otherwise grows
 * straight into the window and ends up covered by it.
 *
 * Observed rather than watched off the playback state: the size is the thing that
 * matters, and it moves for reasons beyond which transport is active. The window itself
 * decides whether to act, and declines once the user has placed it.
 */
let boundsObserver: ResizeObserver | undefined

onMounted(() => {
  if (!demoCatalogue) {
    catalogueLoadStatus.value = 'loading'
    void loadRemoteCatalog().then(remote => {
      if (workspaceDestroyed) return
      catalogue.value = { ...catalogue.value, tracks: remote.tracks }
      filters.replaceTracks(remote.tracks)
      // Refresh Track objects even when the effective filtered IDs are unchanged.
      catalogueReplacementEpoch.value += 1
      catalogueLoadStatus.value = 'published'
    }).catch(() => { if (!workspaceDestroyed) catalogueLoadStatus.value = 'fallback' })
  }
  document.addEventListener('keydown', onWorkspaceShortcut)
  updatePopoverBounds()
  window.addEventListener('resize', updatePopoverBounds)
  if (typeof ResizeObserver === 'undefined') return
  // Both surfaces bound the window's derived placement: the player from below and the bar
  // from above. The bar wraps to a second row on a narrow viewport, which moves the ceiling.
  const bounds = [
    workspaceRoot.value?.querySelector<HTMLElement>('[data-workspace-zone="player"]'),
    workspaceRoot.value?.querySelector<HTMLElement>('.focus-bar'),
    workspaceRoot.value?.querySelector<HTMLElement>('.player-bar__controls'),
    workspaceRoot.value,
  ].filter((element): element is HTMLElement => Boolean(element))
  if (bounds.length === 0) return
  boundsObserver = new ResizeObserver(() => {
    if (workspaceDestroyed) return
    updatePopoverBounds()
    chatWindow.value?.renegotiate()
  })
  for (const element of bounds) boundsObserver.observe(element)
})

onBeforeUnmount(() => {
  workspaceDestroyed = true
  accountSync.destroy()
  accountFocus.destroy()
  boundsObserver?.disconnect()
  window.removeEventListener('resize', updatePopoverBounds)
  unsubscribeFocusSessions()
  unsubscribeProviderPreferences()
  unsubscribeQualityPreferences()
  player.dispose()
  pomodoroStore.destroy()
  focusVisibility.destroy()
  focusRecorder.destroy()
  pomodoroEffects.destroy()
  sleepTimer.destroy()
  fullscreen.destroy()
  document.removeEventListener('keydown', onWorkspaceShortcut)
})
</script>

<template>
  <main
    ref="workspaceRoot"
    :data-catalogue-status="catalogueLoadStatus"
    id="app-content"
    class="study-workspace"
    data-workspace="cinematic"
    :data-active-official-player="!modalOpen && player.playable.value?.kind === 'youtube' ? 'true' : 'false'"
    tabindex="-1"
    :style="{
      '--studio-glass-blur': studioBlur + 'px',
      '--studio-glass-gray-strength': String(studioGlassGray / MAX_STUDIO_GLASS_GRAY),
      '--studio-edge-strength': String(studioEdge / MAX_STUDIO_EDGE),
      '--workspace-focus-bottom': `${focusBarBottom}px`,
      '--workspace-player-controls-top': `${playerControlsTop}px`,
      '--workspace-player-top': `${playerTop}px`,
    }"
  >
    <SceneBackdrop
      :mode="backgroundMode"
      :low-power="lowPower"
      :store="backgroundStore"
    />
    <StudioGlassCanvas v-if="visualStyle === 'studio'" :low-power="lowPower" :blur-radius="studioBlur" :glass-gray="studioGlassGray" :edge="studioEdge" />
    <PwaUpdateNotice :status="pwaUpdateStatus" />
    <NoticeCentre />
    <BackgroundSwitcher
      class="study-workspace__background-switcher"
      :store="backgroundStore"
      :locale="locale"
      :inert="modalOpen || focusPopoverOpen"
      :class="{ 'study-workspace__background-switcher--disclosed': focusPopoverOpen }"
    />

    <div class="study-workspace__zone" data-workspace-zone="focus">
      <FocusBar
        :state="filters"
        :tracks="catalogue.tracks"
        :pomodoro-store="pomodoroStore"
        :sleep-timer-store="sleepTimer"
        :modal-open="modalOpen"
        @open-control-centre="openControlCentre()"
        @toggle-advanced="onToggleAdvanced"
        @toggle-popover="focusPopoverOpen = $event"
      />
      <p v-if="automaticSyncStatus === 'failed'" class="study-workspace__sync-notice liquid-popover" role="status" aria-live="polite" data-account-sync-warning>{{ text('account.preferenceSync.failed') }}</p>
      <slot name="focus" />
    </div>
    <div class="study-workspace__zone" data-workspace-zone="player">
      <PlayerBar
        :store="player"
        compact
        :queue-open="queueOpen"
        :media-suspended="modalOpen"
        @toggle-queue="queueOpen = !queueOpen"
      />
      <slot name="player" />
    </div>
    <!--
      When explicitly opened, the fixed chat stays mounted and inert behind an open hub.
      Keeping it mounted preserves its adjusted layout while the user moves between panels.
    -->
    <FloatingChatWindow
      v-if="chatOpen"
      ref="chatWindow"
      :inert="modalOpen"
      :reserved="playerRegions"
      :obstructed-top="obstructedTop"
      constrain-to-available-space
      @close="closeChatWindow"
    >
      <ChatAvailability />
    </FloatingChatWindow>
    <!-- Queue is rendered after chat at the same workspace layer so opening it gives
         the standalone queue ownership of overlapping pointer targets without making it modal. -->
    <QueueDrawer
      v-if="queueOpen"
      :inert="modalOpen || undefined"
      :aria-hidden="modalOpen ? 'true' : undefined"
      :store="player"
      @close="queueOpen = false"
    />
    <slot name="chat" />
    <OverlaySheet
      :open="activeSheet === 'focusSummary'"
      :title="text('focus.summary.title')"
      name="focus-summary"
      modal
      :return-focus-to="liveFocusControl"
      @close="activeSheet = undefined"
    >
      <FocusSummary
        v-if="summaryRecord"
        :record="summaryRecord"
        :statistics="focusStatistics"
      />
    </OverlaySheet>
    <ControlCentre
      :open="controlCentreOpen"
      :section="controlCentreSection"
      :preferences="preferences"
      :pomodoro-store="pomodoroStore"
      :player="player"
      :library="library"
      :focus-repository="focusRepository"
      :focus-history-status="focusHistoryStatus"
      :background-store="backgroundStore"
      :provider-preferences="providerPreferences"
      :provider-repository="providerRepository"
      :tracks="catalogue.tracks"
      :focus-sessions="focusSessions"
      :time-zone="resolvedTimeZone"
      :chat-open="chatOpen"
      :fullscreen-state="fullscreen.state.value"
      :return-focus-to="controlCentreReturnTarget"
      @close="controlCentreOpen = false"
      @select="controlCentreSection = $event"
      @open-chat="openChatWindow"
      @focus-chat="focusChatWindow"
      @toggle-fullscreen="void fullscreen.toggle()"
    >
      <template #application>
        <StudyTipCard
          v-if="preferences.studyTipsEnabled.value && preferences.dismissedStudyTipId.value !== studyTip.id"
          :tip="studyTip"
          @dismiss="preferences.dismissStudyTip(studyTip.id)"
        />
        <p v-else class="study-workspace__pending" role="status">{{ text('studyTips.hidden') }}</p>
      </template>
    </ControlCentre>
  </main>
</template>

<style scoped>
.study-workspace {
  position: relative;
  width: 100%;
  min-height: 100dvh;
  overflow: hidden;
  isolation: isolate;
}

.study-workspace__zone {
  position: absolute;
  z-index: var(--layer-workspace-zone);
  pointer-events: none;
}

.study-workspace__zone > :deep(*) {
  pointer-events: auto;
}

[data-workspace-zone="focus"] {
  container: focus-zone / inline-size;
  top: max(var(--workspace-edge-inset), env(safe-area-inset-top));
  right: max(var(--workspace-focus-inline-inset), env(safe-area-inset-right));
  left: max(var(--workspace-focus-inline-inset), env(safe-area-inset-left));
  z-index: var(--layer-workspace-focus-bar);
}

[data-workspace-zone="player"] {
  right: auto;
  bottom: var(--workspace-edge-inset);
  left: var(--workspace-edge-inset);
  width: min(var(--workspace-player-inline-size), calc(100% - (2 * var(--workspace-edge-inset))));
}

.study-workspace__sync-notice { margin: .5rem 0 0; padding: .75rem; color: var(--colour-text-muted); font-size: .875rem; line-height: 1.5; pointer-events: none; }
.study-workspace__pending { margin: 0; padding: 1rem; color: var(--colour-text-muted); line-height: 1.5; }
.study-workspace__background-switcher--disclosed { visibility: hidden; }
.study-workspace__background-switcher {
  position: absolute;
  top: calc(var(--workspace-focus-bottom) + 0.75rem);
  right: max(var(--workspace-edge-inset), env(safe-area-inset-right));
  z-index: var(--layer-workspace-zone);
}

@media (max-width: 47.99rem) {
  [data-workspace-zone="focus"] {
    top: max(var(--workspace-edge-inset), env(safe-area-inset-top));
    right: max(var(--workspace-edge-inset), env(safe-area-inset-right));
    left: max(var(--workspace-edge-inset), env(safe-area-inset-left));
  }

  [data-workspace-zone="player"] {
    right: var(--workspace-edge-inset);
    bottom: var(--workspace-edge-inset);
    left: var(--workspace-edge-inset);
  }
}

</style>
