import { describe, expect, it } from 'vitest'

import {
  CHAT_SAFE_MARGIN,
  DEFAULT_CHAT_HEIGHT,
  DEFAULT_CHAT_WIDTH,
  MIN_CHAT_HEIGHT,
  MIN_DERIVED_CHAT_HEIGHT,
  MIN_CHAT_WIDTH,
  clampChatLayout,
  defaultChatLayout,
  maxChatSize,
  parseChatLayout,
  resolveChatLayout,
  resolveChatSheetLayout,
  serialiseChatLayout,
} from './chatLayout'

const desktop = { width: 1440, height: 900 }
/** The player zone at 1280: bottom-left, 30rem wide, its own 1rem inset. */
const playerAt1280 = { x: 16, y: 736, width: 480, height: 148 }
function overlaps(
  layout: { x: number; y: number; width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return layout.x < rect.x + rect.width && layout.x + layout.width > rect.x
    && layout.y < rect.y + rect.height && layout.y + layout.height > rect.y
}

describe('floating chat layout', () => {
  it('places a first visit bottom-right, derived from the viewport rather than fixed', () => {
    const layout = defaultChatLayout(desktop)

    expect(layout.width).toBe(DEFAULT_CHAT_WIDTH)
    expect(layout.height).toBe(DEFAULT_CHAT_HEIGHT)
    expect(layout.x + layout.width).toBe(desktop.width - CHAT_SAFE_MARGIN)
    expect(layout.y + layout.height).toBe(desktop.height - CHAT_SAFE_MARGIN)

    // A different viewport yields a different coordinate: nothing here is measured
    // against one display.
    const narrower = defaultChatLayout({ width: 1024, height: 768 })
    expect(narrower.x).toBeLessThan(layout.x)
    expect(narrower.x + narrower.width).toBe(1024 - CHAT_SAFE_MARGIN)
  })

  it('keeps the default clear of the player at every width, lifting it where the corner is not free', () => {
    const clear = defaultChatLayout({ width: 1280, height: 900 }, playerAt1280)
    const intersects = (rect: { x: number; y: number; width: number; height: number }): boolean =>
      clear.x < rect.x + rect.width && clear.x + clear.width > rect.x
      && clear.y < rect.y + rect.height && clear.y + clear.height > rect.y
    expect(intersects(playerAt1280)).toBe(false)

    // At 768 the player spans the width, so beside it is not an option and the window
    // is lifted above it instead of overlapping.
    const player768 = { x: 16, y: 700, width: 736, height: 184 }
    const lifted = defaultChatLayout({ width: 768, height: 900 }, player768)
    expect(lifted.y + lifted.height).toBeLessThanOrEqual(player768.y)
  })

  /**
   * A compact 768x720 desktop viewport has room for a shortened window above the card.
   */
  it('shrinks into the available band above a player when no same-size slot avoids the card', () => {
    const viewport = { width: 768, height: 720, top: 116 }
    const player = { x: 16, y: 362, width: 736, height: 342 }
    const progress = { x: 16, y: 602, width: 736, height: 16 }
    const controls = { x: 16, y: 630, width: 736, height: 72 }
    const layout = defaultChatLayout(viewport, [player, progress, controls])

    expect(layout).toEqual({ x: 400, y: 116, width: DEFAULT_CHAT_WIDTH, height: 246 })
    expect(layout.height).toBeLessThan(DEFAULT_CHAT_HEIGHT)
    expect(layout.height).toBeGreaterThanOrEqual(MIN_DERIVED_CHAT_HEIGHT)
    expect(overlaps(layout, progress)).toBe(false)
    expect(overlaps(layout, controls)).toBe(false)
  })
  it('keeps the default placement clear at a 1396x1088-like desktop viewport', () => {
    const viewport = { width: 1396, height: 1088, top: 66 }
    const player = { x: 16, y: 916, width: 480, height: 156 }
    const layout = defaultChatLayout(viewport, player)

    expect(layout).toEqual({ x: 1028, y: 688, width: DEFAULT_CHAT_WIDTH, height: DEFAULT_CHAT_HEIGHT })
    expect(layout.y).toBeGreaterThanOrEqual(viewport.top!)
    expect(layout.x + layout.width).toBeLessThanOrEqual(viewport.width - CHAT_SAFE_MARGIN)
  })

  it('preserves a user layout while the collapsed player controls remain clear', () => {
    const viewport = { width: 900, height: 900, top: 66 }
    const saved = { x: 16, y: 360, width: 352, height: 320 }
    const collapsedPlayer = { x: 16, y: 700, width: 868, height: 184 }
    const collapsedControls = { x: 16, y: 760, width: 868, height: 92 }

    expect(resolveChatLayout(
      serialiseChatLayout(saved),
      viewport,
      [collapsedPlayer, collapsedControls],
    )).toEqual(saved)
  })

  it('moves a user-placed layout off expanded Player controls while allowing safe artwork overlap', () => {
    const viewport = { width: 900, height: 900, top: 66 }
    const saved = { x: 16, y: 360, width: 352, height: 320 }
    const expandedPlayer = { x: 16, y: 200, width: 868, height: 684 }
    const progress = { x: 16, y: 620, width: 868, height: 24 }
    const controls = { x: 16, y: 650, width: 868, height: 180 }

    const reconciled = resolveChatLayout(
      serialiseChatLayout(saved),
      viewport,
      [expandedPlayer, progress, controls],
    )

    // The full player has no side lane at this viewport, so the chat may still share its
    // non-interactive surface. It must move just enough to leave the seek and control rows clear.
    expect(reconciled).toEqual({ ...saved, y: 300 })
    expect(reconciled.y).toBeGreaterThanOrEqual(viewport.top!)
    expect(reconciled.y + reconciled.height).toBeLessThanOrEqual(viewport.height - CHAT_SAFE_MARGIN)
    for (const protectedRegion of [progress, controls]) {
      expect(overlaps(reconciled, protectedRegion)).toBe(false)
    }
  })

  it('reconciles a remembered layout after the viewport shrinks and keeps the header reachable', () => {
    const resized = { width: 768, height: 720, top: 66 }
    const saved = { x: 900, y: 700, width: 352, height: 384 }
    const player = { x: 16, y: 500, width: 736, height: 204 }
    const progress = { x: 16, y: 560, width: 736, height: 24 }
    const controls = { x: 16, y: 592, width: 736, height: 96 }

    const reconciled = resolveChatLayout(
      serialiseChatLayout(saved),
      resized,
      [player, progress, controls],
    )

    expect(reconciled).not.toEqual(saved)
    expect(reconciled.x).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
    expect(reconciled.y).toBeGreaterThanOrEqual(resized.top!)
    expect(reconciled.x + reconciled.width).toBeLessThanOrEqual(resized.width - CHAT_SAFE_MARGIN)
    expect(reconciled.y + reconciled.height).toBeLessThanOrEqual(resized.height - CHAT_SAFE_MARGIN)
    expect(reconciled.height).toBeGreaterThanOrEqual(MIN_DERIVED_CHAT_HEIGHT)
    expect(overlaps(reconciled, progress)).toBe(false)
    expect(overlaps(reconciled, controls)).toBe(false)
  })
  it('keeps portrait and short-landscape sheets above the Player controls with a scrollable body band', () => {
    const resolveSheet = resolveChatSheetLayout
    const portrait = resolveSheet(
      { width: 375, height: 812, top: 124 },
      [
        { x: 16, y: 486, width: 343, height: 310 },
        { x: 16, y: 640, width: 343, height: 24 },
        { x: 16, y: 670, width: 343, height: 96 },
      ],
      48,
    )
    expect(portrait).toEqual({ blockEnd: 342, availableHeight: 346 })

    // The player card consumes the lower half of this 667x375 landscape viewport. The
    // sheet yields the card but keeps 150px above the seek row for its header and body.
    const landscape = resolveSheet(
      { width: 667, height: 375, top: 54 },
      [
        { x: 16, y: 130, width: 635, height: 229 },
        { x: 16, y: 220, width: 635, height: 16 },
        { x: 16, y: 244, width: 635, height: 96 },
      ],
      48,
    )
    expect(landscape).toEqual({ blockEnd: 171, availableHeight: 150 })
    expect(landscape.availableHeight).toBeGreaterThan(48 + 64)
  })
  /**
   * The measured phone case: a bar that wraps to two rows reaches 124px, and an expanded
   * player starts at 486px, leaving 346px for a window whose default height is 384. The
   * failure this pins is the window keeping 384 and sliding upward out of the band, which
   * puts its header -- and the close button inside it -- underneath the bar, where neither
   * can be reached. Overlapping is recoverable by dragging; that is not.
   */
  it('fits the lifted window into the band between the reserved top and the player', () => {
    const phone = { width: 375, height: 812, top: 124 }
    const player = { x: 16, y: 486, width: 343, height: 310 }
    const layout = defaultChatLayout(phone, player)

    expect(layout.y).toBeGreaterThanOrEqual(phone.top)
    expect(layout.y + layout.height).toBeLessThanOrEqual(player.y)
    // Shortened to the band rather than kept at the default that does not fit in it.
    expect(layout.height).toBeLessThan(DEFAULT_CHAT_HEIGHT)
    expect(layout.height).toBeGreaterThanOrEqual(MIN_CHAT_HEIGHT)
  })

  /**
   * The caller may name several regions, weakest last, and the strongest one that can
   * actually be cleared is the one that wins. The player asks for two: its whole card, and
   * failing that just the body carrying the video and transport.
   */
  it('clears the whole player card when there is room, and only yields its header when there is not', () => {
    const tablet = { width: 768, height: 900, top: 66 }
    // A resting player: a compact card with a short body inside it.
    const restingCard = { x: 16, y: 630, width: 480, height: 254 }
    const restingBody = { x: 16, y: 680, width: 480, height: 204 }
    const resting = defaultChatLayout(tablet, [restingCard, restingBody])

    // Room above the card, so the two surfaces do not touch at all.
    expect(resting.y + resting.height).toBeLessThanOrEqual(restingCard.y)

    // The same player with a video playing: the card now owns most of the viewport, so the
    // card cannot be cleared and the header is conceded -- but never the body.
    // Tall enough that the band above the card is under the derived floor, which is what
    // makes clearing the whole card genuinely impossible rather than merely tight.
    const playingCard = { x: 16, y: 200, width: 480, height: 684 }
    const playingBody = { x: 16, y: 400, width: 480, height: 484 }
    const playing = defaultChatLayout(tablet, [playingCard, playingBody])

    expect(playing.y + playing.height).toBeLessThanOrEqual(playingBody.y)
    expect(playing.y + playing.height).toBeGreaterThan(playingCard.y)
    expect(playing.y).toBeGreaterThanOrEqual(tablet.top)
  })

  it('shifts left to clear a top-right reserved popover when lifting is not viable', () => {
    const viewport = { width: 1366, height: 768 }
    const topPopover = { x: 950, y: 60, width: 384, height: 420 }
    const layout = defaultChatLayout(viewport, topPopover)

    const overlaps = layout.x < topPopover.x + topPopover.width
      && layout.x + layout.width > topPopover.x
      && layout.y < topPopover.y + topPopover.height
      && layout.y + layout.height > topPopover.y
    expect(overlaps).toBe(false)
    expect(layout.x + layout.width).toBeLessThanOrEqual(topPopover.x)
    expect(layout.x).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
  })

  it('never positions or clamps the window into the reserved top band', () => {
    const phone = { width: 375, height: 812, top: 124 }

    // A dragged position above the bar is pulled back below it.
    expect(clampChatLayout({ x: 16, y: 0, width: 343, height: 320 }, phone).y).toBe(124)
    // A remembered layout from a session with no bar is reconciled the same way.
    expect(resolveChatLayout(
      serialiseChatLayout({ x: 16, y: 20, width: 343, height: 320 }),
      phone,
    ).y).toBe(124)
    // And the height available is measured from below the band, not from the viewport top.
    expect(maxChatSize(phone).height).toBe(812 - 124 - CHAT_SAFE_MARGIN)
    // With nothing reserved the safe margin is the only ceiling, as before.
    expect(clampChatLayout({ x: 16, y: 0, width: 343, height: 320 }, { width: 375, height: 812 }).y)
      .toBe(CHAT_SAFE_MARGIN)
  })

  it('restores a valid saved layout unchanged when the viewport still holds it', () => {
    const saved = { x: 320, y: 240, width: 420, height: 460 }

    expect(resolveChatLayout(serialiseChatLayout(saved), desktop)).toEqual(saved)
  })

  it('falls back to the default for every malformed record rather than repairing one', () => {
    const fallback = defaultChatLayout(desktop)
    const rejected = [
      null,
      '',
      'not json',
      '[]',
      '"string"',
      '42',
      '{}',
      JSON.stringify({ x: 10, y: 10, width: 400 }),
      JSON.stringify({ x: Number.NaN, y: 10, width: 400, height: 400 }),
      JSON.stringify({ x: 10, y: 10, width: Number.POSITIVE_INFINITY, height: 400 }),
      JSON.stringify({ x: 10, y: 10, width: -400, height: 400 }),
      JSON.stringify({ x: 10, y: 10, width: 400, height: 0 }),
      JSON.stringify({ x: 10, y: 10, width: 99_999, height: 400 }),
      JSON.stringify({ x: '10', y: 10, width: 400, height: 400 }),
    ]

    for (const raw of rejected) {
      expect(parseChatLayout(raw), String(raw)).toBeUndefined()
      expect(resolveChatLayout(raw, desktop), String(raw)).toEqual(fallback)
    }
  })

  it('pulls a position saved on a larger display back inside a smaller one', () => {
    const savedOnWideMonitor = serialiseChatLayout({ x: 2200, y: 1300, width: 360, height: 400 })
    const phone = { width: 375, height: 667 }

    const restored = resolveChatLayout(savedOnWideMonitor, phone)

    expect(restored.x).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
    expect(restored.y).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
    expect(restored.x + restored.width).toBeLessThanOrEqual(phone.width - CHAT_SAFE_MARGIN)
    expect(restored.y + restored.height).toBeLessThanOrEqual(phone.height - CHAT_SAFE_MARGIN)
  })

  it('caps a saved size to the viewport and keeps a negative coordinate reachable', () => {
    const oversize = serialiseChatLayout({ x: -500, y: -500, width: 5000, height: 4000 })
    const viewport = { width: 1024, height: 768 }

    const restored = resolveChatLayout(oversize, viewport)

    expect(restored.width).toBe(viewport.width - (2 * CHAT_SAFE_MARGIN))
    expect(restored.height).toBe(viewport.height - (2 * CHAT_SAFE_MARGIN))
    expect(restored.x).toBe(CHAT_SAFE_MARGIN)
    expect(restored.y).toBe(CHAT_SAFE_MARGIN)
  })

  it('never clamps below the size at which the window stops being usable', () => {
    const tiny = clampChatLayout({ x: 0, y: 0, width: 10, height: 10 }, desktop)

    expect(tiny.width).toBe(MIN_CHAT_WIDTH)
    expect(tiny.height).toBe(MIN_CHAT_HEIGHT)
  })

  it('lets the viewport win over the minimum when the viewport is smaller than it', () => {
    // A window shrunk to fit a 200px viewport would have unusable controls, so the
    // minimum is kept and the clamp pins it to the safe margin: reachable, not tidy.
    const viewport = { width: 200, height: 200 }
    const limit = maxChatSize(viewport)

    expect(limit).toEqual({ width: MIN_CHAT_WIDTH, height: MIN_CHAT_HEIGHT })
    expect(clampChatLayout({ x: 900, y: 900, width: 400, height: 400 }, viewport))
      .toEqual({ x: CHAT_SAFE_MARGIN, y: CHAT_SAFE_MARGIN, width: MIN_CHAT_WIDTH, height: MIN_CHAT_HEIGHT })
  })

  it('round-trips only the four geometry fields', () => {
    const raw = serialiseChatLayout({ x: 1, y: 2, width: 300, height: 400 })

    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['height', 'width', 'x', 'y'])
  })
})
