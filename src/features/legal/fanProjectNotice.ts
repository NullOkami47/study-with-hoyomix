import { ref, type Ref } from 'vue'

import { safeLocalStorage, type SafeStorage } from '../../utils/safeStorage'

export const FAN_PROJECT_NOTICE_STORAGE_KEY = 'study-with-hoyomix:fan-project-notice:v1'

export interface FanProjectNoticeStore {
  /** Whether the notice should currently be shown. */
  visible: Ref<boolean>
  /** Hides the notice and remembers that, on this device only. */
  dismiss(): void
}

export interface FanProjectNoticeStoreOptions {
  storage?: SafeStorage
}

/**
 * A stored dismissal is only honoured in the one exact shape this module writes.
 * Anything else - truncated, hand-edited, from a future version, or another
 * product's key collision - is treated as "not dismissed", because the failure
 * that matters is hiding the notice from someone who never saw it.
 */
function isDismissalRecord(raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 2 && record.version === 1 && record.dismissed === true
}

/**
 * First-visit notice state.
 *
 * Deliberately local-device only. It is never sent to the server and never read
 * from account state, so signing in does not carry a dismissal across devices and
 * signing out does not resurrect one. The notice is information, not an agreement:
 * there is no acceptance to record, nothing is gated on it, and anonymous use is
 * unaffected whether it is showing or dismissed.
 */
export function createFanProjectNoticeStore(
  options: FanProjectNoticeStoreOptions = {},
): FanProjectNoticeStore {
  const storage = options.storage ?? safeLocalStorage
  const stored = storage.getItem(FAN_PROJECT_NOTICE_STORAGE_KEY)
  const visible = ref(stored === null || !isDismissalRecord(stored))

  return {
    visible,
    dismiss() {
      // Hide first. If storage is denied the notice still closes for this
      // session, which is the behaviour a reader expects from a close button.
      visible.value = false
      storage.setItem(
        FAN_PROJECT_NOTICE_STORAGE_KEY,
        JSON.stringify({ version: 1, dismissed: true }),
      )
    },
  }
}

let defaultStore: FanProjectNoticeStore | undefined

export function useFanProjectNotice(): FanProjectNoticeStore {
  defaultStore ??= createFanProjectNoticeStore()
  return defaultStore
}
