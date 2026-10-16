/**
 * Geometry for the floating chat window: where it sits, how large it is, and how a
 * remembered layout is reconciled with the viewport actually in front of the user.
 *
 * The window is the only workspace surface a user can put anywhere, so a saved
 * coordinate is treated as a preference rather than as a fact. Every value that
 * reaches the DOM passes through `clampChatLayout`, which is defined against the live
 * viewport: a position saved on a 2560px monitor cannot strand the window off the edge
 * of a 375px phone, and a size saved before the browser was resized cannot push the
 * window past the edge it now has. That reconciliation is the whole reason this module
 * is separate from the component -- it is pure, so it is testable without a DOM.
 */

/** Namespaced, versioned: a future layout shape changes the suffix rather than
 * reinterpreting bytes written by this one. */
export const CHAT_LAYOUT_STORAGE_KEY = 'study-with-hoyomix.floating-chat-layout.v1'

export interface ChatLayout {
  x: number
  y: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
  /**
   * The band at the top of the viewport that another surface owns -- the workspace's top
   * bar. The window is kept below it, because its header is both its label and its drag
   * handle: underneath the bar, the header and the close button inside it are unreachable,
   * and that is a dead end rather than an overlap the user can drag out of. Omitted means
   * nothing is reserved, and the safe margin is the only bound.
   */
  top?: number
}

/**
 * Minimums are the point below which the window's own controls stop being usable, not
 * an aesthetic preference. 300x380 is the upstream reference; the header, the body's
 * two paragraphs and the resize handle all remain reachable at 288x320 in this
 * project's type scale, and 288 is what lets the window keep its inset margins on a
 * 320px display -- the narrowest viewport the workspace supports.
 */
export const MIN_CHAT_WIDTH = 288
export const MIN_CHAT_HEIGHT = 320
/**
 * The floor for a placement this module derives, as opposed to one the user resizes to.
 * They differ on purpose: MIN_CHAT_HEIGHT is the smallest window worth dragging a corner
 * to, while this is the smallest window worth *placing somewhere clear* -- a header and a
 * scrollable body. Once an official video embed is playing, the player can own well over
 * half a laptop screen, and a window that insisted on 320 would have nowhere left to go
 * but on top of the video and its transport. Shorter and clear beats taller and covering.
 *
 * 140 is measured rather than chosen: on a 393x727 phone with an embed playing, the band
 * between the wrapped top bar and the player's body is 149px, and a floor above that is
 * what makes the window give up and land on the transport instead. A covered Pause button
 * is a broken player; a short chat window is a short chat window, and it grows again on its
 * own as soon as the player does not need the room.
 */
export const MIN_DERIVED_CHAT_HEIGHT = 140
/** Matches --workspace-chat-window-inline-size / -block-size in tokens.css. */
export const DEFAULT_CHAT_WIDTH = 352
export const DEFAULT_CHAT_HEIGHT = 384
/** Keeps a dragged window's edge clear of the viewport edge so it stays grabbable. */
export const CHAT_SAFE_MARGIN = 16
/**
 * Rejects a stored size no viewport could justify. This is an integrity bound on
 * decoded storage, not a layout constraint -- the layout constraint is the viewport,
 * applied by clampChatLayout, and it is always the tighter of the two.
 */
const MAX_CHAT_EXTENT = 20_000

/** The highest the window may sit: the reserved band, never less than the safe margin. */
function safeTop(viewport: Viewport): number {
  return Math.max(CHAT_SAFE_MARGIN, viewport.top ?? 0)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clampRange(value: number, min: number, max: number): number {
  // A viewport can be smaller than the window's own minimum. Ordering the bounds this
  // way makes the minimum lose to the viewport rather than pushing the window off it.
  if (max <= min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * The largest window the viewport can hold, never below the usable minimum. On a
 * viewport too small for the minimum the window overflows its safe margin instead of
 * collapsing into something whose close button cannot be pressed.
 */
export function maxChatSize(viewport: Viewport): { width: number; height: number } {
  return {
    width: Math.max(MIN_CHAT_WIDTH, viewport.width - (2 * CHAT_SAFE_MARGIN)),
    // The reserved band is not space the window can use, so the height it may reach is
    // measured from below the bar rather than from the top of the viewport.
    height: Math.max(MIN_CHAT_HEIGHT, viewport.height - safeTop(viewport) - CHAT_SAFE_MARGIN),
  }
}

/**
 * Reconciles any layout with the current viewport. Size is settled first because the
 * position bounds depend on it: clamping a position against a width that is itself
 * about to shrink would leave the window inset from the edge it was dragged to.
 */
export function clampChatLayout(layout: ChatLayout, viewport: Viewport): ChatLayout {
  const limit = maxChatSize(viewport)
  const width = clampRange(Math.round(layout.width), MIN_CHAT_WIDTH, limit.width)
  const height = clampRange(Math.round(layout.height), MIN_CHAT_HEIGHT, limit.height)
  return {
    width,
    height,
    x: Math.round(clampRange(layout.x, CHAT_SAFE_MARGIN, viewport.width - width - CHAT_SAFE_MARGIN)),
    y: Math.round(clampRange(layout.y, safeTop(viewport), viewport.height - height - CHAT_SAFE_MARGIN)),
  }
}

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * The first reserved rectangle is a preferred area to avoid as a whole (the Player card).
 * Further rectangles are hard protected controls and transient surfaces. On a constrained
 * viewport the chat may share non-interactive Player content, but never these controls.
 */
function splitReserved(reserved?: Rect | Rect[]): { preferred: Rect[]; protected: Rect[] } {
  const regions = Array.isArray(reserved) ? reserved : reserved ? [reserved] : []
  return { preferred: regions.slice(0, 1), protected: regions.slice(1) }
}

function overlapsWithGap(layout: ChatLayout, rect: Rect, gap: number): boolean {
  return layout.x < rect.x + rect.width + gap
    && layout.x + layout.width > rect.x - gap
    && layout.y < rect.y + rect.height + gap
    && layout.y + layout.height > rect.y - gap
}

function positionsNear(
  origin: number,
  extent: number,
  min: number,
  max: number,
  obstacles: Rect[],
  axis: 'x' | 'y',
  gap: number,
): number[] {
  const values = new Set<number>()
  const add = (value: number): void => {
    values.add(Math.round(clampRange(value, min, max)))
  }
  add(origin)
  add(min)
  add(max)
  for (const rect of obstacles) {
    const start = axis === 'x' ? rect.x : rect.y
    const size = axis === 'x' ? rect.width : rect.height
    add(start - extent - gap)
    add(start + size + gap)
  }
  return [...values]
}

/** Finds the least-moving position at this size that clears every supplied region. */
function nearestClearPosition(
  origin: ChatLayout,
  viewport: Viewport,
  regions: Rect[],
  gap: number,
): ChatLayout | undefined {
  const minX = CHAT_SAFE_MARGIN
  const minY = safeTop(viewport)
  const maxX = Math.max(minX, viewport.width - origin.width - CHAT_SAFE_MARGIN)
  const maxY = Math.max(minY, viewport.height - origin.height - CHAT_SAFE_MARGIN)
  const xs = positionsNear(origin.x, origin.width, minX, maxX, regions, 'x', gap)
  const ys = positionsNear(origin.y, origin.height, minY, maxY, regions, 'y', gap)
  let best: ChatLayout | undefined
  let bestDistance = Number.POSITIVE_INFINITY

  for (const y of ys) {
    for (const x of xs) {
      const candidate = { ...origin, x, y }
      if (regions.some(region => overlapsWithGap(candidate, region, gap))) continue
      const dx = x - origin.x
      const dy = y - origin.y
      const distance = (dx * dx) + (dy * dy)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }
  }
  return best
}

function candidateExtents(
  target: number,
  minimum: number,
  boundaryStart: number,
  boundaryEnd: number,
  regions: Rect[],
  axis: 'x' | 'y',
): number[] {
  const edges = new Set<number>([boundaryStart, boundaryEnd])
  for (const rect of regions) {
    const start = axis === 'x' ? rect.x : rect.y
    const end = start + (axis === 'x' ? rect.width : rect.height)
    edges.add(Math.round(clampRange(start, boundaryStart, boundaryEnd)))
    edges.add(Math.round(clampRange(end, boundaryStart, boundaryEnd)))
  }
  const sortedEdges = [...edges].sort((a, b) => a - b)
  const extents = new Set<number>([Math.round(target), Math.round(minimum)])
  for (let left = 0; left < sortedEdges.length; left += 1) {
    for (let right = left + 1; right < sortedEdges.length; right += 1) {
      const extent = sortedEdges[right]! - sortedEdges[left]!
      if (extent >= minimum && extent <= target) extents.add(extent)
    }
  }
  return [...extents].filter(extent => extent >= minimum && extent <= target).sort((a, b) => b - a)
}

/**
 * If no position can keep the current size clear of protected controls, try the largest
 * smaller rectangles first. The chosen size loses as little area as possible, then keeps
 * the user's width where two candidates have the same area.
 */
function shrinkToClearProtected(
  layout: ChatLayout,
  viewport: Viewport,
  protectedRegions: Rect[],
): ChatLayout {
  const maxWidth = Math.min(layout.width, Math.max(MIN_CHAT_WIDTH, viewport.width - (2 * CHAT_SAFE_MARGIN)))
  const maxHeight = Math.min(layout.height, Math.max(MIN_DERIVED_CHAT_HEIGHT, viewport.height - safeTop(viewport) - CHAT_SAFE_MARGIN))
  const widths = candidateExtents(maxWidth, MIN_CHAT_WIDTH, CHAT_SAFE_MARGIN, viewport.width - CHAT_SAFE_MARGIN, protectedRegions, 'x')
  const heights = candidateExtents(maxHeight, MIN_DERIVED_CHAT_HEIGHT, safeTop(viewport), viewport.height - CHAT_SAFE_MARGIN, protectedRegions, 'y')
  const sizes: Array<{ width: number; height: number }> = []
  for (const width of widths) {
    for (const height of heights) sizes.push({ width, height })
  }
  sizes.sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.width - a.width)

  for (const size of sizes) {
    const candidate = nearestClearPosition({ ...layout, ...size }, viewport, protectedRegions, 0)
    if (candidate) return candidate
  }
  // The supported workspace viewports always leave a safe band at least as large as the
  // header and scrollable body. If an embedding host violates that contract, remain clamped
  // and reachable rather than inventing off-screen coordinates.
  return layout
}

/**
 * Reconciles a saved or live user layout with the viewport and current Player geometry.
 * It first makes the smallest move that avoids the full Player card. If no same-size spot
 * does that, it preserves every protected control and only then considers reducing size.
 */
export function reconcileChatLayout(
  layout: ChatLayout,
  viewport: Viewport,
  reserved?: Rect | Rect[],
  preserveUserLayout = false,
): ChatLayout {
  const bounded = clampChatLayout(layout, viewport)
  const { preferred, protected: protectedRegions } = splitReserved(reserved)
  const hardRegions = protectedRegions.length > 0 ? protectedRegions : preferred
  const preferredRegions = [...preferred, ...protectedRegions]
  const preferredFit = nearestClearPosition(bounded, viewport, preferredRegions, CHAT_SAFE_MARGIN)
  if (preferredFit) return preferredFit

  // Stored and actively user-placed windows keep their size when moving them can protect
  // controls. A compact layout is used only when no same-size protected placement exists.
  if (preserveUserLayout) {
    const protectedFit = nearestClearPosition(bounded, viewport, hardRegions, 0)
    if (protectedFit) return protectedFit
    return shrinkToClearProtected(bounded, viewport, hardRegions)
  }

  // A first-visit layout avoids the full card when it can fit a usable window above it.
  if (preferred.length > 0) {
    const resizedPreferred = shrinkToClearProtected(bounded, viewport, preferredRegions)
    if (preferredRegions.every(region => !overlapsWithGap(resizedPreferred, region, 0))) return resizedPreferred
  }

  // The card is too large to avoid. Keep the original size while protecting controls first.
  const protectedFit = nearestClearPosition(bounded, viewport, hardRegions, 0)
  if (protectedFit) return protectedFit
  return shrinkToClearProtected(bounded, viewport, hardRegions)
}

/**
 * First-visit placement starts bottom-right. The full Player card is avoided where it fits;
 * live control rectangles remain protected when a playing embed leaves less room.
 */
export function defaultChatLayout(viewport: Viewport, reserved?: Rect | Rect[]): ChatLayout {
  const limit = maxChatSize(viewport)
  const bottomRight = clampChatLayout({
    width: Math.min(DEFAULT_CHAT_WIDTH, limit.width),
    height: Math.min(DEFAULT_CHAT_HEIGHT, limit.height),
    x: viewport.width - Math.min(DEFAULT_CHAT_WIDTH, limit.width) - CHAT_SAFE_MARGIN,
    y: viewport.height - Math.min(DEFAULT_CHAT_HEIGHT, limit.height) - CHAT_SAFE_MARGIN,
  }, viewport)
  return reconcileChatLayout(bottomRight, viewport, reserved)
}

/**
 * Geometry for the narrow bottom sheet. It uses the whole-card edge when there is room for
 * a header and scrollable body; otherwise it fits above the uppermost protected Player row.
 */
export function resolveChatSheetLayout(
  viewport: Viewport,
  reserved: Rect | Rect[] | undefined,
  headerHeight: number,
): { blockEnd: number; availableHeight: number } {
  const { preferred, protected: protectedRegions } = splitReserved(reserved)
  const top = safeTop(viewport)
  const minimumSheetHeight = Math.max(MIN_DERIVED_CHAT_HEIGHT, Math.round(headerHeight) + 64)
  const measureAbove = (region: Rect): { blockEnd: number; availableHeight: number } => {
    const bottom = Math.max(top, Math.min(viewport.height - CHAT_SAFE_MARGIN, Math.round(region.y) - CHAT_SAFE_MARGIN))
    return {
      blockEnd: Math.round(viewport.height - bottom),
      availableHeight: Math.max(0, Math.round(bottom - top)),
    }
  }

  const preferredRegion = preferred[0]
  if (preferredRegion) {
    const wholeCard = measureAbove(preferredRegion)
    if (wholeCard.availableHeight >= minimumSheetHeight) return wholeCard
  }

  if (protectedRegions.length > 0) {
    const highestProtected = protectedRegions.reduce((highest, region) => region.y < highest.y ? region : highest)
    return measureAbove(highestProtected)
  }
  if (preferredRegion) return measureAbove(preferredRegion)

  return {
    blockEnd: CHAT_SAFE_MARGIN,
    availableHeight: Math.max(0, viewport.height - top - (2 * CHAT_SAFE_MARGIN)),
  }
}
/**
 * Decodes a stored layout. Anything that is not a complete, finite, positively-sized
 * record is discarded rather than repaired: a partial layout cannot be distinguished
 * from a layout written by a different version, and guessing at one would move the
 * user's window for reasons they could not see. The caller receives undefined and
 * falls back to the derived default.
 *
 * Positions are accepted even when off-screen, because a position is reconciled against
 * the live viewport by clampChatLayout on every restore. Sizes are the integrity bound:
 * a non-positive or absurd extent is not a coordinate that needs moving, it is a
 * corrupt record.
 */
export function parseChatLayout(raw: string | null): ChatLayout | undefined {
  if (!raw) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined
  const { x, y, width, height } = decoded as Partial<ChatLayout>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return undefined
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return undefined
  if (width <= 0 || height <= 0) return undefined
  if (width > MAX_CHAT_EXTENT || height > MAX_CHAT_EXTENT) return undefined
  return { x, y, width, height }
}

export function serialiseChatLayout(layout: ChatLayout): string {
  const { x, y, width, height } = layout
  return JSON.stringify({ x, y, width, height })
}

/**
 * The layout a session should open with: the remembered one reconciled against this
 * viewport, or the derived default when nothing valid was stored.
 */
export function resolveChatLayout(
  raw: string | null,
  viewport: Viewport,
  reserved?: Rect | Rect[],
): ChatLayout {
  const stored = parseChatLayout(raw)
  return stored ? reconcileChatLayout(stored, viewport, reserved, true) : defaultChatLayout(viewport, reserved)
}
