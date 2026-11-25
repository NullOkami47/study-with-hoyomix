/**
 * Side-effect module imported first by `src/main.js` (task 41.8): restores the debug log kept in
 * sessionStorage, records page lifecycle events, and installs the global capture (window errors,
 * unhandled rejections, console.error/warn, failed or slow `/api/*` calls, Service Worker state).
 * Both installs are idempotent, so the player's own lifecycle install later is a no-op.
 */
import { installDebugCapture, installDebugLogLifecycle } from './debugLog'

installDebugLogLifecycle()
installDebugCapture()
