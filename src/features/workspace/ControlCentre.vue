<script setup lang="ts">
/**
 * The workspace's secondary-function hub: one modal, a category rail, one active panel.
 *
 * It exists so the study scene can stay quiet. Every secondary tool the product has --
 * Pomodoro settings, Library, playback, chat, the calendar, account, appearance,
 * application, About, Privacy -- is reachable from here, which is what lets the main page
 * carry nothing but the top bar, the player and the chat window. It is opened by pressing
 * the top bar itself, so there is no Settings button parked over the artwork either.
 *
 * The panels are not new implementations. Each one mounts the component that already owns
 * that behaviour, so there is exactly one Pomodoro store, one Library repository and one
 * provider-preference store in the application, and this component owns none of them.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CalendarDays, CircleUser, Info, Library, MessageCircle, MoreHorizontal, Music, Palette, ShieldCheck,
  Smartphone, Timer,
} from 'lucide-vue-next'

import ChatAvailability from '../chat/ChatAvailability.vue'
import CompactPlayback from '../player/CompactPlayback.vue'
import StudyCalendar from '../focus/StudyCalendar.vue'
import type { FocusSessionRecord } from '../focus/types'
import LibrarySheet from '../library/LibrarySheet.vue'
import PlaybackDiagnostics from '../player/PlaybackDiagnostics.vue'
import SettingsSheet from '../settings/SettingsSheet.vue'
import type { SettingsSectionId } from '../settings/sections'
import { translate, type TranslationKey } from '../../i18n'
import type { Track } from '../catalog/types'
import type { LocalLibraryRepository } from '../library/localRepository'
import type { FocusSessionRepository } from '../focus/localRepository'
import type { BackgroundStore } from '../backgrounds/store'
import type { PlaybackStore } from '../player/store'
import type { ProviderPreferencesStore } from '../player/providerPreferences'
import type { RuntimeProviderRepository } from '../player/runtimeConfig'
import type { PomodoroStore } from '../timers/pomodoro/store'
import type { Preferences } from '../../stores/preferences'
import OverlaySheet from './OverlaySheet.vue'
import type { FullscreenState } from './fullscreen'

export type ControlCentreSection =
  | 'focus' | 'library' | 'music' | 'chat' | 'calendar'
  | 'account' | 'appearance' | 'application' | 'about' | 'privacy'

const props = withDefaults(defineProps<{
  open: boolean
  section: ControlCentreSection
  preferences: Preferences
  pomodoroStore: PomodoroStore
  player: PlaybackStore
  library: LocalLibraryRepository
  focusRepository: FocusSessionRepository
  focusHistoryStatus?: 'storage_error' | 'pending_overflow' | 'overflow_full'
  backgroundStore: BackgroundStore
  providerPreferences?: ProviderPreferencesStore
  providerRepository?: Pick<RuntimeProviderRepository, 'states'>
  tracks: Track[]
  focusSessions: FocusSessionRecord[]
  timeZone: string
  chatOpen: boolean
  fullscreenState?: FullscreenState
  returnFocusTo?: () => HTMLElement | null | undefined
}>(), {
  focusHistoryStatus: undefined,
  providerPreferences: undefined,
  providerRepository: undefined,
  fullscreenState: 'unavailable',
  returnFocusTo: undefined,
})
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'select', section: ControlCentreSection): void
  (event: 'open-chat'): void
  (event: 'focus-chat'): void
  (event: 'toggle-fullscreen'): void
}>()

const text = (key: TranslationKey): string => translate(props.preferences.locale.value, key)
const panelId = 'control-centre-panel'
const rail = ref<HTMLElement>()
const moreButton = ref<HTMLElement>()
const mobile = ref(false)
const moreOpen = ref(false)
const primaryIds: ControlCentreSection[] = ['focus', 'library', 'music', 'calendar']
const secondaryIds: ControlCentreSection[] = ['chat', 'account', 'appearance', 'application', 'about', 'privacy']
const secondaryActive = computed(() => secondaryIds.includes(props.section))
const mobilePrimary = computed(() => primaryIds.map((id) => sections.find((item) => item.id === id)!))
const mobileSecondary = computed(() => secondaryIds.map((id) => sections.find((item) => item.id === id)!))
const groups = [
  { id: 'study', label: 'controlCentre.group.study', items: ['focus', 'calendar'] },
  { id: 'music', label: 'controlCentre.group.music', items: ['library', 'music'] },
  { id: 'social', label: 'controlCentre.group.social', items: ['chat'] },
  { id: 'settings', label: 'controlCentre.group.settings', items: ['account', 'appearance', 'application'] },
] as const

let desktopQuery: MediaQueryList | undefined
function updateViewport(): void {
  const wasMobile = mobile.value
  mobile.value = !desktopQuery?.matches
  if (wasMobile !== mobile.value && rail.value?.contains(document.activeElement)) {
    void nextTick(() => rail.value?.querySelector<HTMLElement>('[aria-current="true"]')?.focus())
  }
  if (mobile.value && secondaryActive.value) moreOpen.value = true
}
onMounted(() => {
  if (typeof window.matchMedia !== 'function') return
  desktopQuery = window.matchMedia('(min-width: 48rem)')
  updateViewport()
  desktopQuery.addEventListener('change', updateViewport)
})
onBeforeUnmount(() => desktopQuery?.removeEventListener('change', updateViewport))

function toggleMore(): void {
  if (moreOpen.value && rail.value?.contains(document.activeElement) && document.activeElement !== moreButton.value) {
    moreButton.value?.focus()
  }
  moreOpen.value = !moreOpen.value
}
function selectSection(section: ControlCentreSection): void {
  if (primaryIds.includes(section)) moreOpen.value = false
  emit('select', section)
}

/**
 * Every destination names the Settings sections its
 * panel renders, so a category is a view onto the settings model rather than a copy of
 * it: `undefined` means the panel has its own content instead.
 */
const sections: {
  id: ControlCentreSection
  label: TranslationKey
  icon: typeof Timer
  settings?: SettingsSectionId[]
}[] = [
  { id: 'focus', label: 'controlCentre.section.focus', icon: Timer, settings: ['pomodoro'] },
  { id: 'library', label: 'controlCentre.section.library', icon: Library, settings: ['library'] },
  { id: 'music', label: 'controlCentre.section.music', icon: Music, settings: ['playback'] },
  { id: 'calendar', label: 'controlCentre.section.calendar', icon: CalendarDays },
  { id: 'chat', label: 'controlCentre.section.chat', icon: MessageCircle },
  { id: 'account', label: 'controlCentre.section.account', icon: CircleUser, settings: ['account'] },
  { id: 'appearance', label: 'controlCentre.section.appearance', icon: Palette, settings: ['appearance', 'language'] },
  { id: 'application', label: 'controlCentre.section.application', icon: Smartphone, settings: ['application'] },
  { id: 'about', label: 'controlCentre.section.about', icon: Info, settings: ['about'] },
  { id: 'privacy', label: 'controlCentre.section.privacy', icon: ShieldCheck, settings: ['privacy'] },
]

const groupedSections = groups.map((group) => ({
  ...group,
  items: group.items.map((id) => sections.find((item) => item.id === id)!),
}))
const footerSections = secondaryIds.slice(-2).map((id) => sections.find((item) => item.id === id)!)

const activeSettingsSections = computed(
  () => sections.find(({ id }) => id === props.section)?.settings,
)

/**
 * Moving between categories starts the new panel at its top rather than inheriting how far
 * the last one was scrolled, and rescues focus when the category was switched from inside
 * the panel.
 *
 * That second part matters more than it looks. Some panels carry a command that changes
 * category -- Focus offers "open calendar" -- and activating one unmounts the very button
 * that was activated. Focus then falls to the document body, outside the hub, where the
 * sheet's own key handling no longer sees Escape: the keyboard user is left in a modal they
 * cannot close. Focus is only taken when it has actually been lost, so a press on a rail
 * item leaves focus on that rail item, where the user expects to keep arrowing from.
 *
 * Post-flush, because the question being asked is about the DOM after the switch.
 */
watch(() => props.section, () => {
  if (mobile.value && secondaryActive.value) moreOpen.value = true
  const panel = rail.value?.parentElement?.querySelector<HTMLElement>('[data-control-centre-panel]')
  if (!panel) return
  panel.scrollTop = 0
  const active = document.activeElement
  const hub = panel.closest('[data-overlay-sheet]')
  if (!active || !hub?.contains(active)) panel.focus()
}, { flush: 'post' })
</script>

<template>
  <OverlaySheet
    :open="open"
    :title="text('controlCentre.title')"
    name="control-centre"
    variant="centre"
    modal
    :return-focus-to="returnFocusTo"
    @close="emit('close')"
  >
    <div class="control-centre">
      <nav ref="rail" class="control-centre__rail" data-control-centre-rail :aria-label="text('controlCentre.navLabel')">
        <div v-if="!mobile" class="control-centre__desktop" data-control-centre-desktop>
          <div class="control-centre__groups">
            <section v-for="group in groupedSections" :key="group.id" class="control-centre__group" :data-control-centre-group="group.id">
              <h3 class="control-centre__group-label">{{ text(group.label) }}</h3>
              <button v-for="item in group.items" :key="item.id" type="button"
                :data-control-centre-nav="item.id" :aria-current="item.id === section ? 'true' : undefined"
                :aria-controls="panelId" @click="selectSection(item.id)">
                <component :is="item.icon" :size="18" aria-hidden="true" />
                <span>{{ text(item.label) }}</span>
              </button>
            </section>
          </div>
          <div class="control-centre__footer" data-control-centre-footer>
            <button v-for="item in footerSections" :key="item.id" type="button"
              :data-control-centre-nav="item.id" :aria-current="item.id === section ? 'true' : undefined"
              :aria-controls="panelId" @click="selectSection(item.id)">
              <component :is="item.icon" :size="18" aria-hidden="true" />
              <span>{{ text(item.label) }}</span>
            </button>
          </div>
        </div>
        <div v-else class="control-centre__mobile" data-control-centre-mobile>
          <div class="control-centre__mobile-primary" data-control-centre-mobile-primary>
            <button v-for="item in mobilePrimary" :key="item.id" type="button"
              :data-control-centre-nav="item.id" :aria-current="item.id === section ? 'true' : undefined"
              :aria-controls="panelId" @click="selectSection(item.id)">
              <component :is="item.icon" :size="18" aria-hidden="true" />
              <span>{{ text(item.label) }}</span>
            </button>
            <button ref="moreButton" type="button" data-control-centre-more
              :aria-current="secondaryActive ? 'true' : undefined"
              :aria-expanded="moreOpen ? 'true' : 'false'"
              :aria-controls="moreOpen ? 'control-centre-more-menu' : undefined" @click="toggleMore">
              <MoreHorizontal :size="18" aria-hidden="true" />
              <span>{{ text('controlCentre.more') }}</span>
            </button>
          </div>
          <div v-if="moreOpen" id="control-centre-more-menu" class="control-centre__mobile-secondary"
            data-control-centre-mobile-secondary role="group" :aria-label="text('controlCentre.more')">
            <button v-for="item in mobileSecondary" :key="item.id" type="button"
              :data-control-centre-nav="item.id" :aria-current="item.id === section ? 'true' : undefined"
              :aria-controls="panelId" @click="selectSection(item.id)">
              <component :is="item.icon" :size="18" aria-hidden="true" />
              <span>{{ text(item.label) }}</span>
            </button>
          </div>
        </div>
      </nav>

      <!--
        tabindex="0", not "-1". The panel is the hub's scroll container, and a category whose
        content is pure prose -- Privacy and About are both longer than the panel -- contains
        no focusable descendant to scroll it by. At tabindex="-1" that made the panel
        programmatically focusable but not keyboard-reachable, so a keyboard-only user could
        open Privacy and never read past the fold: axe reports it as
        scrollable-region-focusable (WCAG 2.1.1). A real tab stop is the fix the rule asks
        for, and it also keeps the focus rescue below working, because the element it focuses
        is now one the user could have reached themselves.
      -->
      <div
        :id="panelId"
        class="control-centre__panel"
        data-control-centre-panel
        role="region"
        :aria-label="text(sections.find((item) => item.id === section)!.label)"
        tabindex="0"
      >
        <!--
          Library and the calendar are rendered here rather than opened as a second modal
          on top of this one. A hub whose categories launch further modals is not a hub.
        -->
        <LibrarySheet
          v-if="section === 'library'"
          :tracks="tracks"
          :player="player"
          :library="library"
        />
        <StudyCalendar
          v-else-if="section === 'calendar'"
          :sessions="focusSessions"
          :time-zone="timeZone"
        />
        <div v-else-if="section === 'chat'" class="control-centre__chat" data-control-centre-chat>
          <ChatAvailability />
          <!--
            The recovery path for a closed chat window, and the only one: the main page
            deliberately carries no permanent "open chat" button. There is one chat
            surface in the product, so this offers an action on the floating window
            rather than mounting a second live chat inside the hub.
          -->
          <p v-if="chatOpen" data-chat-window-state role="status">{{ text('chat.windowOpen') }}</p>
          <div class="control-centre__chat-actions">
            <button v-if="!chatOpen" type="button" data-control-centre-open-chat @click="emit('open-chat')">
              {{ text('chat.openFloating') }}
            </button>
            <button v-else type="button" data-control-centre-focus-chat @click="emit('focus-chat')">
              {{ text('chat.focusWindow') }}
            </button>
          </div>
        </div>

        <!--
          The study tip sits with the toggle that governs it, in Application, rather than
          in a "more" drawer of its own. The workspace supplies it because the workspace
          owns which tip the day resolves to.
        -->
        <slot v-if="section === 'application'" name="application" />

        <CompactPlayback v-if="section === 'music'" :store="player" />
        <SettingsSheet
          v-if="activeSettingsSections"
          :preferences="preferences"
          :pomodoro-store="pomodoroStore"
          :player="player"
          :library="library"
          :focus-repository="focusRepository"
          :focus-history-status="focusHistoryStatus"
          :background-store="backgroundStore"
          :provider-preferences="providerPreferences"
          :provider-repository="providerRepository"
          :sections="activeSettingsSections"
          :fullscreen-state="fullscreenState"
          @open-calendar="emit('select', 'calendar')"
          @open-library="emit('select', 'library')"
          @toggle-fullscreen="emit('toggle-fullscreen')"
        />
        <PlaybackDiagnostics v-if="section === 'music'" :player="player" />
      </div>
    </div>
  </OverlaySheet>
</template>

<style scoped>
.control-centre {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  height: 100%;
}

.control-centre__rail {
  position: relative;
  min-width: 0;
  min-height: 0;
  max-block-size: 45dvh;
  overflow-y: auto;
  padding: 0.5rem;
  border-block-end: var(--glass-border);
  background: var(--glass-tint);
  box-shadow: var(--glass-highlight), var(--glass-shade);
  isolation: isolate;
}
.control-centre__rail::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  content: '';
  background: linear-gradient(135deg, var(--glass-edge), transparent 48%);
  opacity: 0.16;
}
.control-centre__rail button {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 2.75rem;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem 0.625rem;
  color: var(--colour-text-primary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
  font: inherit;
  isolation: isolate;
  text-align: start;
  transition: filter var(--motion-duration) ease;
}
.control-centre__rail button::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  content: '';
  opacity: 0;
  transition: opacity var(--motion-duration) ease;
}
.control-centre__rail button:hover { filter: var(--control-hover-filter); }
.control-centre__rail button svg { flex: 0 0 auto; color: var(--colour-text-muted); }
.control-centre__rail button span { min-width: 0; overflow-wrap: anywhere; }
.control-centre__rail button[aria-current="true"] {
  font-weight: 650;
  border-color: var(--glass-edge);
  box-shadow: var(--glass-highlight), var(--glass-shade);
}
.control-centre__rail button[aria-current="true"]::before {
  opacity: 1;
  background: var(--colour-surface-glass);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.2);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.2);
}
.control-centre__rail button[aria-current="true"] svg { color: var(--colour-accent-strong); }
.control-centre__mobile-primary {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.125rem;
}
.control-centre__mobile-primary button {
  flex-direction: column;
  justify-content: center;
  gap: 0.125rem;
  padding-inline: 0.125rem;
  text-align: center;
  font-size: 0.75rem;
  line-height: 1.2;
}
.control-centre__mobile-primary button span { overflow-wrap: anywhere; }
.control-centre__mobile-secondary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.125rem;
  padding-block-start: 0.375rem;
  margin-block-start: 0.375rem;
  border-block-start: var(--glass-border);
}
.control-centre__panel {
  min-height: 0;
  padding: 0.875rem;
  overflow: auto;
  overscroll-behavior: contain;
}
.control-centre__chat { display: grid; gap: 0.625rem; align-content: start; }
.control-centre__chat p { margin: 0; color: var(--colour-text-muted); font-size: 0.875rem; }
.control-centre__chat-actions { display: flex; flex-wrap: wrap; gap: 0.4375rem; }
.control-centre__chat-actions button {
  min-height: 2.75rem;
  padding: 0.4375rem 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-control);
  cursor: pointer;
  font: inherit;
  transition: filter var(--motion-duration) ease;
}
.control-centre__chat-actions button:hover,
.control-centre__chat-actions button:focus-visible { filter: var(--control-hover-filter); }

@media (min-width: 48rem) {
  .control-centre {
    grid-template-columns: minmax(11rem, 14rem) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .control-centre__rail {
    padding: 0.875rem;
    max-block-size: none;
    overflow-y: auto;
    border-block-end: 0;
    border-inline-end: var(--glass-border);
  }
  .control-centre__desktop { display: flex; flex-direction: column; min-height: 100%; }
  .control-centre__groups { display: grid; gap: 0.625rem; }
  .control-centre__group { display: grid; gap: 0.125rem; }
  .control-centre__group-label {
    margin: 0 0 0.125rem;
    padding-inline: 0.625rem;
    color: var(--colour-text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .control-centre__footer {
    display: grid;
    gap: 0.125rem;
    margin-block-start: auto;
    padding-block-start: 0.625rem;
    border-block-start: var(--glass-border);
  }
  .control-centre__rail button { width: 100%; }
  .control-centre__panel { padding: 1.25rem; }
}
@media (prefers-reduced-motion: reduce) {
  .control-centre__rail button,
  .control-centre__rail button::before { transition-duration: 0ms; }
}
@media (forced-colors: active) {
  .control-centre__rail button[aria-current="true"] { border-color: Highlight; outline: 2px solid Highlight; }
}
</style>
