import { describe, expect, it, vi } from 'vitest'

import { createPwaInstallStatus, resolvePwaInstallState } from './installStatus'

function installEnvironment(initialStandalone = false) {
  const target = new EventTarget()
  const media = new EventTarget() as EventTarget & { matches: boolean; media: string }
  media.matches = initialStandalone
  media.media = '(display-mode: standalone)'
  return {
    media,
    navigator: {},
    window: {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      matchMedia: vi.fn(() => media),
    },
  }
}

describe('PWA install status', () => {
  it('prioritises current standalone runtime over session installation, prompt availability, and unknown', () => {
    expect(resolvePwaInstallState({
      runningStandalone: true,
      installedThisSession: true,
      installPromptAvailable: true,
    })).toBe('runningStandalone')
    expect(resolvePwaInstallState({
      runningStandalone: false,
      installedThisSession: true,
      installPromptAvailable: true,
    })).toBe('installedThisSession')
    expect(resolvePwaInstallState({
      runningStandalone: false,
      installedThisSession: false,
      installPromptAvailable: true,
    })).toBe('promptAvailable')
    expect(resolvePwaInstallState({
      runningStandalone: false,
      installedThisSession: false,
      installPromptAvailable: false,
    })).toBe('unknown')
  })

  it('starts installed only from a standalone display mode', () => {
    const environment = installEnvironment(true)
    const status = createPwaInstallStatus(environment)

    expect(status.runningStandalone.value).toBe(true)
    expect(status.installedThisSession.value).toBe(false)
    expect(status.installPromptAvailable.value).toBe(false)
    status.destroy()
  })

  it('reports an actual install prompt and records completion without claiming the browser tab is standalone', () => {
    const environment = installEnvironment()
    const status = createPwaInstallStatus(environment)

    environment.window.dispatchEvent(new Event('beforeinstallprompt'))
    expect(status.runningStandalone.value).toBe(false)
    expect(status.installedThisSession.value).toBe(false)
    expect(status.installPromptAvailable.value).toBe(true)

    environment.window.dispatchEvent(new Event('appinstalled'))
    expect(status.runningStandalone.value).toBe(false)
    expect(status.installedThisSession.value).toBe(true)
    expect(status.installPromptAvailable.value).toBe(false)
    status.destroy()
  })

  it('updates installed state when the standalone media query changes', () => {
    const environment = installEnvironment()
    const status = createPwaInstallStatus(environment)

    environment.media.matches = true
    environment.media.dispatchEvent(new Event('change'))

    expect(status.runningStandalone.value).toBe(true)
    expect(status.installedThisSession.value).toBe(false)
    status.destroy()

    environment.media.matches = false
    environment.media.dispatchEvent(new Event('change'))
    expect(status.runningStandalone.value).toBe(true)
  })
})
