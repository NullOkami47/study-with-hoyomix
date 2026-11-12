import type { TranslationKey } from '../../i18n'

/**
 * M-09: OAuth callback navigations return to `/` with exactly one status parameter, either
 * `?account=linked` or `?auth_error=<code>`. The Worker only ever sends codes from a fixed enum
 * (`OAUTH_NAVIGATION_ERRORS` in `workers/auth/routes.ts`); this module turns them into a
 * localised message key and removes the parameter so a reload or a shared URL does not repeat it.
 * The parameter value is never rendered: an unknown or tampered code maps to a generic message.
 */
export const AUTH_NOTICE_PARAMETERS = ['account', 'auth_error'] as const

export interface AuthNotice {
  kind: 'success' | 'error'
  key: TranslationKey
}

const ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  collision: 'account.notice.collision',
  provider_already_linked: 'account.notice.providerAlreadyLinked',
  unauthorized: 'account.notice.unauthorized',
  oauth_callback_failed: 'account.notice.callbackFailed',
}

/** Maps the status parameters of a query string to a notice, or `null` when there is none. */
export function authNoticeFromSearch(search: string): AuthNotice | null {
  const params = new URLSearchParams(search)
  const error = params.get('auth_error')
  if (error !== null) {
    const key = Object.prototype.hasOwnProperty.call(ERROR_KEYS, error) ? ERROR_KEYS[error]! : 'account.notice.generic'
    return { kind: 'error', key }
  }
  if (params.get('account') === 'linked') return { kind: 'success', key: 'account.notice.linked' }
  return null
}

/**
 * The same-document URL without the status parameters, keeping every other parameter, the path
 * and the hash. Returns `null` when the URL carries no status parameter.
 */
export function withoutAuthNoticeParameters(href: string): string | null {
  const url = new URL(href)
  if (!AUTH_NOTICE_PARAMETERS.some((name) => url.searchParams.has(name))) return null
  for (const name of AUTH_NOTICE_PARAMETERS) url.searchParams.delete(name)
  return `${url.pathname}${url.search}${url.hash}`
}

interface LocationLike { href: string; search: string }
interface HistoryLike { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void }

/** Reads the notice from the current URL once and removes its parameter with `replaceState`. */
export function consumeAuthNotice(
  location: LocationLike = window.location,
  history: HistoryLike = window.history,
): AuthNotice | null {
  const notice = authNoticeFromSearch(location.search)
  const cleaned = withoutAuthNoticeParameters(location.href)
  if (cleaned !== null) {
    try {
      history.replaceState(history.state, '', cleaned)
    } catch {
      /* A refused history update must not hide the message. */
    }
  }
  return notice
}
