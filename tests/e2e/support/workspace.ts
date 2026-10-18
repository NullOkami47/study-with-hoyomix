import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Every secondary tool lives in the Control Center, and the whole top bar is the way in.
 * These helpers are the only place a spec should name that route, so the specs read as
 * "open Library" rather than as a sequence of presses.
 */
export type ControlCentreSection =
  | 'focus' | 'library' | 'music' | 'chat' | 'calendar'
  | 'account' | 'appearance' | 'application' | 'about' | 'privacy'

/** The hub itself, for visibility and count assertions. */
export function controlCentre(page: Page): Locator {
  return page.locator('#workspace-control-centre-sheet')
}

/** The one active panel inside the hub. */
export function controlCentrePanel(page: Page): Locator {
  return page.locator('[data-control-centre-panel]')
}

/**
 * Presses the bar's activation surface. Idempotent, so a spec may call it before each
 * command without tracking hub state itself.
 *
 * Keyboard activation, deliberately. The hit area spans the whole bar *behind* the toolbar,
 * so its own centre point is covered by the controls in front of it -- correctly, because a
 * press on a control must reach that control. Playwright's click would refuse the obstructed
 * centre, and clicking a computed gap instead would make every spec depend on where the bar's
 * controls happen to sit at that viewport. Enter on the focused button is the same activation
 * over a stable target. The pointer route is covered explicitly, with real hit testing, in
 * tests/e2e/top-bar.spec.ts, which is where that contract belongs.
 */
export async function openControlCentre(page: Page): Promise<void> {
  const hitArea = page.locator('[data-focus-control-centre]')
  await expect(hitArea).toBeVisible()
  if ((await hitArea.getAttribute('aria-expanded')) !== 'true') {
    await hitArea.focus()
    await page.keyboard.press('Enter')
  }
  await expect(controlCentre(page)).toBeVisible()
}

/** Opens the hub and selects one category, leaving that panel active. */
export async function openControlCentreSection(page: Page, section: ControlCentreSection): Promise<void> {
  await openControlCentre(page)
  const secondary = ['chat', 'account', 'appearance', 'application', 'about', 'privacy'].includes(section)
  const more = page.locator('[data-control-centre-more]')
  if (secondary && await more.isVisible() && await more.getAttribute('aria-expanded') !== 'true') await more.click()
  const nav = page.locator(`[data-control-centre-nav="${section}"]`)
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'true')
}

/** Opens the standalone queue surface without opening the modal Control Centre. */
export async function openQueue(page: Page): Promise<Locator> {
  const toggle = page.locator('[data-player-toggle-queue]')
  const playerDisclosure = page.locator('[data-player-collapse]')
  if ((await playerDisclosure.getAttribute('aria-expanded')) === 'false') await playerDisclosure.click()
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  const drawer = page.locator('[data-queue-drawer]')
  await expect(drawer).toBeVisible()
  return drawer
}

/** Closes the hub from its own control and waits for it to leave the document. */
export async function closeControlCentre(page: Page): Promise<void> {
  await controlCentre(page).locator('[data-overlay-close]').click()
  await expect(controlCentre(page)).toHaveCount(0)
}
