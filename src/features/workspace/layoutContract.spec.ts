import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string): string => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('cinematic workspace layout contract', () => {
  it('owns player, chat, action-stack, and sheet geometry through semantic quarter-rem tokens', () => {
    const tokens = readSource('../../styles/tokens.css')
    const workspace = readSource('./StudyWorkspace.vue')

    expect(tokens).toContain('--workspace-player-inline-size: 30rem')
    // The chat window's default *size* is a token; its position is not, because
    // chatLayout.ts derives the position from the live viewport.
    expect(tokens).toContain('--workspace-chat-window-inline-size: 22rem')
    expect(tokens).toContain('--workspace-chat-window-block-size: 24rem')
    expect(tokens).not.toContain('--workspace-quick-actions-row-block-size')
    expect(workspace).not.toMatch(/(?:30|22|29)rem/u)
    expect(tokens).not.toContain('28.8125rem')
  })

  it('sizes the top bar by its own controls rather than by the viewport', () => {
    const focusBar = readSource('./FocusBar.vue')

    // Intrinsic width plus auto margins is what makes the bar compact and centred; a
    // viewport-proportional cap with a filler column is what made it a full-width slab.
    expect(focusBar).toMatch(/\.focus-bar\s*\{[^}]*width: fit-content;/u)
    expect(focusBar).toMatch(/\.focus-bar\s*\{[^}]*margin-inline: auto;/u)
    expect(focusBar).not.toContain('max-width: 68rem')
    expect(focusBar).not.toMatch(/minmax\(0, 1fr\)/u)

    // Game and mode controls are disclosed in one filter panel instead of a wrapped row.
    expect(focusBar).toContain('data-focus-filter-summary')
    expect(focusBar).not.toContain('data-focus-mode=')
  })

  it('keeps every secondary utility inside the Control Center rather than on the scene', () => {
    const focusBar = readSource('./FocusBar.vue')
    const workspace = readSource('./StudyWorkspace.vue')

    // The resting scene is the top bar and player. Secondary tools, including chat, stay
    // inside the Control Centre rather than parked over the artwork.
    expect(workspace).not.toContain('data-workspace-zone="quick-actions"')
    expect(workspace).not.toContain('QuickActions')
    expect(workspace).not.toContain('#tray')
    expect(focusBar).not.toContain('trayOpen')
    expect(focusBar).not.toContain('data-focus-tray')

    // The bar's whole surface is the way in, through a sibling hit area behind the
    // toolbar rather than a button wrapped around it.
    expect(focusBar).toMatch(/<section[\s\S]*?class="focus-bar liquid-shell"[\s\S]*?@click="onBarClick"/u)
    expect(focusBar).toMatch(/data-focus-control-centre[\s\S]*?class="focus-bar__toolbar"/u)
    expect(workspace).toMatch(/<FocusBar[\s\S]*?@open-control-centre="openControlCentre\(\)"/u)
    expect(workspace).toMatch(/<ControlCentre[\s\S]*?:section="controlCentreSection"/u)
  })

  it('makes the centred hub the whole screen on a phone and keeps the chat window off the zone grid', () => {
    const overlay = readSource('./OverlaySheet.vue')
    const workspace = readSource('./StudyWorkspace.vue')

    expect(overlay).toMatch(/@media \(max-width: 47\.99rem\)[\s\S]*\.overlay-sheet--centre \{[\s\S]*inset: 0;[\s\S]*width: 100vw;[\s\S]*height: 100dvh;/u)
    expect(overlay).toMatch(/\.overlay-sheet--centre \{[\s\S]*padding-block-end: env\(safe-area-inset-bottom\);/u)

    // The chat window is fixed to the viewport and positions itself, so it is a sibling
    // of the zones rather than a zone with a reserved slot in the layout.
    expect(workspace).not.toContain('data-workspace-zone="chat"')
    // The whole card is preferred; the subsequent rectangles protect Player controls and
    // transient surfaces when the full card cannot be avoided.
    expect(workspace).toMatch(/<FloatingChatWindow[\s\S]*:reserved="playerRegions"/u)
    expect(workspace).toMatch(/<FloatingChatWindow[\s\S]*<QueueDrawer[\s\S]*@close="queueOpen = false"/u)
  })

  it('defines hover, active, and focus-visible feedback for overlay close and Library selects', () => {
    const overlay = readSource('./OverlaySheet.vue')
    const playbackDiagnostics = readSource('../player/PlaybackDiagnostics.vue')
    const libraryPanel = readSource('../library/LibraryPanel.vue')

    for (const state of [':hover', ':active', ':focus-visible']) {
      expect(overlay).toContain(`.overlay-sheet__header button${state}`)
      expect(playbackDiagnostics).toContain(`.playback-diagnostics select${state}`)
      expect(libraryPanel).toContain(`.library-panel select${state}`)
    }
  })

  it('uses labelled-control typography for the visible player Queue command', () => {
    const player = readSource('../player/PlayerBar.vue')

    expect(player).toMatch(/\.player-bar__queue span\s*\{[^}]*font-size: 0\.875rem;[^}]*font-weight: 650;/u)
  })
})
