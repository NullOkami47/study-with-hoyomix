<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-vue-next'

import AdvancedFilters from '../catalog/AdvancedFilters.vue'
import { relationLabel } from '../catalog/filterLabels'
import { CANONICAL_GAME_IDS, type CatalogFilterState } from '../catalog/filterState'
import type { GameId, Track } from '../catalog/types'
import type { PomodoroPhase, PomodoroStore } from '../timers/pomodoro/store'
import SleepTimer from '../timers/sleep/SleepTimer.vue'
import type { SleepTimerStore } from '../timers/sleep/store'
import { systemTimerClock, type TimerClock } from '../timers/clock'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { usePresence } from './usePresence'

interface FocusClock extends TimerClock { formatLocalTime?: (now: number) => string }

const props = withDefaults(defineProps<{
  clock?: FocusClock
  pomodoroStore: PomodoroStore
  sleepTimerStore: SleepTimerStore
  state: CatalogFilterState
  tracks: Track[]
  /** True while the Control Center owns the screen above the bar. The modal is then the
   * topmost layer and owns Escape and outside clicks, so the bar's own popover stands
   * down rather than competing for either. */
  modalOpen?: boolean
}>(), { clock: undefined, modalOpen: false })
const emit = defineEmits<{
  (event: 'open-control-centre'): void
  (event: 'toggle-advanced', open: boolean): void
  (event: 'toggle-popover', open: boolean): void
}>()
const { locale } = usePreferences()
const presence = usePresence()
const text = (key: TranslationKey): string => translate(locale.value, key)
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const phaseTrigger = ref<HTMLButtonElement>()
const sleepTrigger = ref<HTMLButtonElement>()
const hitArea = ref<HTMLButtonElement>()
const advancedOpen = ref(false)
watch(advancedOpen, (open) => emit('toggle-advanced', open))
const phaseMenuOpen = ref(false)
// Presentation only: neither timer owns or cancels the other timer's session.
const sleepSelected = ref(false)
const sleepOpen = ref(false)
watch(() => advancedOpen.value || phaseMenuOpen.value || sleepOpen.value, open => emit('toggle-popover', open))
const sleepPanelId = 'cinematic-sleep-timer'
const advancedId = 'cinematic-advanced-filters'
const phaseMenuId = 'cinematic-phase-menu'
const gameKey: Record<GameId, TranslationKey> = { genshin: 'game.genshin', hsr: 'game.hsr', zzz: 'game.zzz' }
const filterItems = computed(() => {
  const items = props.state.games.value.length === CANONICAL_GAME_IDS.length
    ? [text('catalog.allGames')]
    : props.state.games.value.map((game) => text(gameKey[game]))
  if (props.state.mode.value) items.push(text(`tab.${props.state.mode.value}` as TranslationKey))
  items.push(...props.state.relationIds.value.map((id) => relationLabel(id, locale.value)))
  if (props.state.search.value.trim()) items.push(text('catalog.searchActive'))
  return items
})
const fullFilterSummary = computed(() => filterItems.value.join(' · '))
const filterSummary = computed(() => {
  const visible = filterItems.value.slice(0, 2)
  const overflow = filterItems.value.length - visible.length
  if (overflow) visible.push(translate(locale.value, 'catalog.moreFilters', { count: overflow }))
  return visible.join(' · ')
})
const filtersActive = computed(() => props.state.games.value.length !== CANONICAL_GAME_IDS.length
  || props.state.mode.value !== null || props.state.relationIds.value.length > 0 || Boolean(props.state.search.value.trim()))
const onlineLabel = computed(() => presence.count.value === null ? text('workspace.onlineUnavailable') : text('workspace.onlineCount').replace('{count}', String(presence.count.value)))
const filterTriggerLabel = computed(() => `${text('catalog.filters')}: ${fullFilterSummary.value}`)
const clock = computed<FocusClock>(() => props.clock ?? systemTimerClock)
const localTime = ref(formatLocalTime())
const phaseText = computed(() => sleepSelected.value ? text('timer.sleep') : text(`pomodoro.phase.${props.pomodoroStore.phase.value}` as TranslationKey))
const phaseChangeLabel = computed(() => sleepSelected.value ? text('timer.sleep') : text('pomodoro.changePhase').replace('{phase}', phaseText.value))
let timer: ReturnType<typeof setInterval> | undefined

function formatLocalTime(): string {
  const now = clock.value.now()
  if (clock.value.formatLocalTime) return clock.value.formatLocalTime(now)
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
}

function closeAdvanced(returnFocus = false): void {
  if (!advancedOpen.value) return
  advancedOpen.value = false
  if (returnFocus) trigger.value?.focus()
}

function closePhaseMenu(returnFocus = false): void {
  if (!phaseMenuOpen.value) return
  phaseMenuOpen.value = false
  if (returnFocus) phaseTrigger.value?.focus()
}

function closeSleep(returnFocus = false): void {
  if (!sleepOpen.value) return
  sleepOpen.value = false
  if (returnFocus) sleepTrigger.value?.focus()
}

function togglePhaseMenu(): void {
  if (props.modalOpen) return
  closeAdvanced()
  closeSleep()
  phaseMenuOpen.value = !phaseMenuOpen.value
}

function toggleSleep(): void {
  if (props.modalOpen) return
  closeAdvanced()
  closePhaseMenu()
  sleepOpen.value = !sleepOpen.value
}

function selectSleep(): void {
  sleepSelected.value = true
  closePhaseMenu(true)
  sleepOpen.value = true
}

/**
 * The chevron's whole contract: toggle Advanced Filters, and nothing else. It never
 * opens the Control Center, so no propagation from it can reach the bar's own
 * activation surface -- see `onBarClick`, which is what makes that guarantee.
 */
function toggleAdvanced(): void {
  if (props.modalOpen) return
  closePhaseMenu()
  closeSleep()
  if (advancedOpen.value) {
    closeAdvanced(true)
    return
  }
  advancedOpen.value = true
}

/**
 * Every non-interactive part of the bar activates the Control Center: the padding, the
 * gaps between groups, the timer readout's own background, the presence dot.
 *
 * The test is for the nearest interactive ancestor, not for the bar itself, which is
 * what keeps the two contracts from ever both firing. A press on the game row changes
 * the game selection and stops; a press on the chevron opens Advanced Filters and stops;
 * a press on the bar surface between them opens the Control Center. The bar is a section
 * with a sibling hit-area button behind the toolbar rather than a button wrapping it,
 * so none of this nests one interactive element inside another.
 */
function onBarClick(event: MouseEvent): void {
  if (props.modalOpen) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"]')) return
  // A press inside a disclosed popover is that popover's business even where it lands on
  // the popover's own padding.
  if (target.closest('[data-advanced-filters], [data-phase-menu], [data-sleep-panel]')) return
  emit('open-control-centre')
}

function selectPhase(phase: PomodoroPhase): void {
  if (phase !== props.pomodoroStore.phase.value) props.pomodoroStore.selectPhase(phase)
  sleepSelected.value = false
  closeSleep()
  closePhaseMenu(true)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || props.modalOpen) return
  if (phaseMenuOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    closePhaseMenu(true)
  } else if (sleepOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    closeSleep(true)
  } else if (advancedOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    closeAdvanced(true)
  }
}

function onPointerDown(event: PointerEvent): void {
  if (props.modalOpen) return
  if (!(event.target instanceof Node)) return
  if (root.value?.contains(event.target)) return
  if (advancedOpen.value) closeAdvanced()
  closePhaseMenu()
  closeSleep()
}

// The Control Center is the topmost layer once it opens, so the bar's popover stands
// down instead of remaining behind it where a press could still reach it. Focus is not
// pulled back to the chevron here: the modal has already taken it, and the modal is
// what returns it on close.
watch(() => props.modalOpen, (modalOpen) => {
  if (modalOpen) {
    advancedOpen.value = false
    phaseMenuOpen.value = false
    sleepOpen.value = false
  }
})

onMounted(() => {
  timer = setInterval(() => { localTime.value = formatLocalTime() }, 60_000)
  document.addEventListener('pointerdown', onPointerDown)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('pointerdown', onPointerDown)
})
</script>

<template>
  <section
    ref="root"
    class="focus-bar liquid-shell"
    :aria-label="text('workspace.focusBar')"
    @keydown="onKeydown"
    @click="onBarClick"
  >
    <!--
      The bar's activation surface. It is a real button with a real accessible name, so
      the whole-bar action is reachable by keyboard and announced, and it is a sibling
      behind the toolbar rather than a wrapper around it, so no interactive control is
      ever nested inside another. Enter and Space come free with the element.
    -->
    <button
      ref="hitArea"
      type="button"
      class="focus-bar__hit-area"
      data-focus-control-centre
      :aria-label="text('workspace.openSettings')"
      :aria-expanded="props.modalOpen"
      aria-haspopup="dialog"
      @click="!props.modalOpen && emit('open-control-centre')"
    />
    <div class="focus-bar__toolbar" data-focus-toolbar>
      <div class="focus-bar__presence" :class="{ 'focus-bar__presence--connected': presence.count.value !== null }" aria-live="polite" :aria-label="text('workspace.online')">
        <span class="focus-bar__presence-dot" aria-hidden="true" />
        <output data-focus-online :aria-label="onlineLabel" :title="onlineLabel" :data-count="presence.count.value ?? '—'">
          <span class="focus-bar__presence-label">{{ onlineLabel }}</span>
        </output>
        <span v-if="presence.ownerOnline.value" class="focus-bar__owner" data-focus-owner :title="text('workspace.ownerOnline')"><span class="focus-bar__owner-dot" aria-hidden="true" /><span class="focus-bar__owner-label">{{ text('workspace.ownerOnline') }}</span></span>
      </div>

      <section class="focus-bar__timer" :aria-label="sleepSelected ? text('timer.sleep') : text('pomodoro.title')">
        <output v-if="!sleepSelected" data-focus-pomodoro-readout aria-live="polite">{{ pomodoroStore.formattedTime.value }}</output>
        <button v-else ref="sleepTrigger" type="button" data-sleep-trigger :aria-label="text('timer.sleep')" :aria-controls="sleepPanelId" :aria-expanded="sleepOpen" @click="toggleSleep">
          <output data-focus-sleep-readout aria-live="polite">{{ sleepTimerStore.formattedTime.value }}</output>
        </button>
        <button
          ref="phaseTrigger"
          type="button"
          class="focus-bar__phase"
          data-phase-trigger
          :aria-label="phaseChangeLabel"
          :aria-controls="phaseMenuId"
          :aria-expanded="phaseMenuOpen"
          @click="togglePhaseMenu"
        >
          <span data-focus-pomodoro-phase>{{ phaseText }}</span>
          <ChevronDown :size="12" aria-hidden="true" />
        </button>
        <template v-if="!sleepSelected">
          <button v-if="pomodoroStore.status.value === 'idle'" type="button" class="focus-bar__icon-button" data-focus-pomodoro-start :aria-label="text('pomodoro.start')" @click="pomodoroStore.start">
            <Play :size="17" aria-hidden="true" />
          </button>
          <button v-else-if="pomodoroStore.status.value === 'running'" type="button" class="focus-bar__icon-button" data-focus-pomodoro-pause :aria-label="text('pomodoro.pause')" @click="pomodoroStore.pause">
            <Pause :size="17" aria-hidden="true" />
          </button>
          <button v-else type="button" class="focus-bar__icon-button" data-focus-pomodoro-resume :aria-label="text('pomodoro.resume')" @click="pomodoroStore.resume">
            <Play :size="17" aria-hidden="true" />
          </button>
          <button type="button" class="focus-bar__icon-button" data-focus-pomodoro-reset :aria-label="text('pomodoro.reset')" @click="pomodoroStore.reset">
            <RotateCcw :size="16" aria-hidden="true" />
          </button>
          </template>

        <div v-if="phaseMenuOpen" :id="phaseMenuId" class="focus-bar__phase-menu liquid-popover" data-phase-menu role="menu">
          <button v-for="phase in (['focus', 'break', 'longBreak'] as PomodoroPhase[])" :key="phase" type="button" role="menuitem" :disabled="pomodoroStore.status.value === 'running' && phase !== pomodoroStore.phase.value" :data-phase-select="phase" @click="selectPhase(phase)">{{ text(`pomodoro.phase.${phase}` as TranslationKey) }}</button>
          <button type="button" role="menuitem" data-phase-select="sleep" @click="selectSleep">{{ text('timer.sleep') }}</button>
        </div>
        <section v-if="sleepOpen" :id="sleepPanelId" class="focus-bar__sleep-popover liquid-popover" data-sleep-panel :aria-label="text('timer.sleep')">
          <SleepTimer :store="sleepTimerStore" embedded />
        </section>
      </section>

      <p class="focus-bar__clock" data-focus-local-clock>{{ localTime }}</p>

      <div class="focus-bar__advanced">
        <button
          ref="trigger"
          type="button"
          class="focus-bar__advanced-trigger"
          data-advanced-trigger
          :data-filter-active="filtersActive"
          :aria-label="filterTriggerLabel"
          :title="filterTriggerLabel"
          :aria-controls="advancedId"
          :aria-expanded="advancedOpen"
          @click="toggleAdvanced"
        >
          <SlidersHorizontal :size="17" aria-hidden="true" />
          <span data-focus-filter-summary>{{ filterSummary }}</span>
          <ChevronDown class="focus-bar__filter-chevron" :size="16" aria-hidden="true" />
        </button>
        <div v-if="advancedOpen" class="focus-bar__advanced-popover liquid-popover">
          <AdvancedFilters :id="advancedId" :state="state" :tracks="tracks" @close="closeAdvanced(true)" />
        </div>
      </div>

    </div>
  </section>
</template>

<style scoped>
/* One material layer: the shared liquid-shell supplies tint, rim, blur and fallback.
   Keep the responsive composition here rather than overriding historical toolbars. */
.focus-bar {
  position: relative;
  width: fit-content;
  max-width: 100%;
  margin-inline: auto;
  padding: 0.25rem 0.5rem;
  border-radius: 999px;
  font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
  cursor: pointer;
}
.focus-bar__hit-area {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: inherit;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.focus-bar__toolbar {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--liquid-space);
  min-width: 0;
  pointer-events: none;
}
.focus-bar__toolbar :is(button, a, input, select, textarea),
.focus-bar__toolbar :is([data-advanced-filters], [data-phase-menu], [data-sleep-panel]) { pointer-events: auto; }
.focus-bar__toolbar button {
  min-width: 44px;
  min-height: 44px;
  padding: 0.375rem 0.625rem;
  color: var(--liquid-text-primary);
  background: transparent;
  border: 0;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
  transition: background var(--liquid-motion) var(--liquid-easing);
}
.focus-bar__hit-area:hover,
.focus-bar__toolbar button:hover { background: var(--liquid-separator); }
.focus-bar__toolbar button:active,
.focus-bar__toolbar button[aria-pressed="true"] { background: var(--liquid-selected); }
.focus-bar__toolbar button:disabled { opacity: 0.5; cursor: default; }
.focus-bar__presence {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 0.375rem;
  align-items: center;
  max-width: 16rem;
  min-height: 44px;
  padding-inline: 0.375rem 0.5rem;
  color: var(--liquid-text-secondary);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.focus-bar__presence-dot,
.focus-bar__owner-dot { flex: 0 0 auto; width: 0.375rem; height: 0.375rem; border-radius: 50%; background: var(--liquid-text-secondary); }
.focus-bar__presence--connected .focus-bar__presence-dot { background: var(--colour-accent); }

.focus-bar__owner { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--liquid-text-primary); white-space: nowrap; }
.focus-bar__owner-dot { background: var(--colour-accent-strong); box-shadow: 0 0 0 1px var(--liquid-edge-light); }
.focus-bar__timer { display: flex; flex: 0 1 auto; align-items: center; gap: 0.25rem; min-width: 0; padding-inline: 0.375rem; }
.focus-bar__timer > output,
[data-sleep-trigger] { flex: 0 0 auto; min-width: 3.25rem; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 1rem; font-weight: 700; font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; }
.focus-bar__toolbar .focus-bar__phase { display: flex; gap: 0.25rem; align-items: center; justify-content: center; font-size: 0.8125rem; font-weight: 650; line-height: 1.25; }
.focus-bar__phase svg { flex: 0 0 auto; }
.focus-bar__toolbar .focus-bar__icon-button { display: grid; flex: 0 0 44px; width: 44px; padding: 0; place-items: center; }
.focus-bar__clock { display: none; }
.focus-bar__advanced { flex: 0 0 auto; min-width: 0; }
.focus-bar__toolbar .focus-bar__advanced-trigger { position: relative; display: flex; align-items: center; justify-content: center; gap: 0.5rem; max-width: 15rem; padding-inline: 0.75rem; }
.focus-bar__advanced-trigger span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8125rem; }
.focus-bar__advanced-trigger svg { flex: 0 0 auto; }
.focus-bar__advanced-trigger[aria-expanded="true"] { background: var(--liquid-selected); }
/* All disclosures share the measured space above the entire Player. They are
   anchored to the shell, outside the timer's flex sizing, including landscape. */
.focus-bar__phase-menu,
.focus-bar__sleep-popover,
.focus-bar__advanced-popover {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: var(--layer-workspace-popover);
  max-width: calc(100vw - 2 * var(--workspace-edge-inset));
  max-height: min(33rem, max(0px, calc(min(100dvh - var(--workspace-edge-inset), var(--workspace-player-top, var(--workspace-player-controls-top))) - var(--workspace-focus-bottom) - 1rem)));
  border-radius: var(--liquid-radius-popover);
  cursor: default;
}
.focus-bar__phase-menu { left: 0; right: auto; display: grid; gap: 0.25rem; width: max-content; min-width: min(12rem, 100%); padding: 0.5rem; overflow: auto; }
.focus-bar__phase-menu button { width: 100%; text-align: start; border-radius: var(--liquid-radius-control); }
.focus-bar__sleep-popover { width: min(24rem, calc(100vw - 2 * var(--workspace-edge-inset))); overflow: auto; }
.focus-bar__advanced-popover { width: min(26rem, calc(100vw - 2 * var(--workspace-edge-inset))); overflow: hidden; }
.focus-bar__advanced-popover :deep(.advanced-filters) { max-height: inherit; height: auto; background: transparent; border: 0; box-shadow: none; backdrop-filter: none; }

@media (max-width: 47.99rem) {
  .focus-bar { padding: 0.25rem; }
  .focus-bar__toolbar { flex-wrap: nowrap; gap: 0; }
  .focus-bar__presence { position: relative; flex-wrap: nowrap; max-width: none; gap: 0.25rem; padding-inline: 0.375rem; color: var(--liquid-text-primary); }
  [data-focus-online]::after { content: attr(data-count); }
  /* Preserve the full server status for screen readers and the desktop summary. */
  .focus-bar__presence-label,
  .focus-bar__owner-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .focus-bar__owner { position: absolute; top: 0.375rem; left: 0.25rem; }
  .focus-bar__owner-dot { width: 0.25rem; height: 0.25rem; }
  .focus-bar__timer { flex: 1 1 auto; gap: 0; padding: 0; }
  .focus-bar__timer > output { min-width: 3.125rem; }
  .focus-bar__toolbar .focus-bar__phase { flex: 0 1 auto; min-width: 44px; padding-inline: 0.25rem; }
  .focus-bar__phase span { min-width: 0; }
  .focus-bar__toolbar .focus-bar__advanced-trigger { width: 44px; height: 44px; padding: 0; }
  .focus-bar__advanced-trigger [data-focus-filter-summary],
  .focus-bar__filter-chevron { display: none; }
  .focus-bar__advanced-trigger[data-filter-active="true"]::after { content: ''; position: absolute; top: 0.5rem; right: 0.5rem; width: 0.25rem; height: 0.25rem; border-radius: 50%; background: var(--colour-accent); }
  .focus-bar__advanced-popover,
  .focus-bar__sleep-popover { left: 0; right: 0; width: auto; }
}
/* Text enlargement consumes the same real width as a narrower viewport. The
   workspace container query follows that available space, unlike a device test. */
@container focus-zone (max-width: 17em) {
  .focus-bar { width: 100%; border-radius: var(--liquid-radius-popover); }
  .focus-bar__toolbar { display: grid; grid-template-columns: 1fr auto; }
  .focus-bar__timer { grid-row: 2; grid-column: 1 / -1; justify-content: center; }
  .focus-bar__presence { grid-row: 1; }
  .focus-bar__advanced { grid-row: 1; justify-self: end; }
}
@container focus-zone (max-width: 14em) {
  /* At 200% text the countdown and phase share a readable column; transport
     targets stay alongside it instead of squeezing an unbreakable phase word. */
  .focus-bar__timer { display: grid; grid-template-columns: minmax(0px, 1fr) 44px 44px; }
  .focus-bar__timer > output,
  .focus-bar__timer > [data-sleep-trigger] { grid-column: 1; grid-row: 1; display: grid; min-height: 44px; align-items: center; }
  .focus-bar__timer > .focus-bar__phase { grid-column: 1; grid-row: 2; }
  .focus-bar__timer > .focus-bar__icon-button { grid-column: 2; grid-row: 1 / 3; align-self: center; }
  .focus-bar__timer > [data-focus-pomodoro-reset] { grid-column: 3; }
}
@media (prefers-reduced-motion: reduce) {
  .focus-bar__toolbar button { transition: none; }
}
</style>
