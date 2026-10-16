/** Shared verified account identity for the workspace and account surfaces.
 * Initial uncertainty remains local; refresh failures retain a previously
 * verified identity. Only an authoritative anonymous answer or explicit logout
 * clears it. Revision changes fence requests that predate an account transition.
 */
import { computed, ref, type ComputedRef } from 'vue'
import { invalidateDefaultNoticeSession } from '../notices/noticeCentre'

export interface AccountSession {
  /** True only for a resolved, authenticated session. Anonymous and unreachable are both false. */
  signedIn: ComputedRef<boolean>
  /** Identity used to fence in-flight account operations across account switches. */
  userId: ComputedRef<string | null>
  /** Increments on every settle or publish, so a consumer can bridge each answer exactly once. */
  revision: ComputedRef<number>
  /** Resolves the session if it has not been resolved already. Safe to call from every mount. */
  ensure: () => Promise<void>
  refresh: () => Promise<void>
  /** Records an answer a caller already has, and invalidates the memo so the next ensure re-asks. */
  publish: (signedIn: boolean, userId?: string | null) => void
}

const signedIn = ref(false)
const userId = ref<string | null>(null)
const revision = ref(0)
let pending: Promise<void> | undefined
let readGeneration = 0

function settle(value: boolean, identity: string | null = null): void {
  invalidateDefaultNoticeSession()
  userId.value = value ? identity : null
  signedIn.value = value
  revision.value += 1
}

/**
 * A 401 is an authoritative anonymous answer. Initial transport failures cannot
 * establish an identity; refresh failures must not revoke an already verified one.
 */
async function read(preserveKnown = false): Promise<void> {
  const generation = ++readGeneration
  try {
    const response = await fetch('/api/session', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (generation !== readGeneration) return
    if (response.status === 401) return settle(false)
    if (!response.ok) throw new Error('session_failed')
    const body = await response.json() as { user?: { id: string } | null }
    if (generation !== readGeneration) return
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'user') ||
      (body.user !== null && (typeof body.user?.id !== 'string' || !body.user.id))) throw new Error('session_invalid_response')
    settle(Boolean(body.user), typeof body.user?.id === 'string' ? body.user.id : null)
  } catch {
    if (generation === readGeneration && !preserveKnown) settle(false)
  }
}

function ensure(): Promise<void> {
  // Memoised on the promise rather than on a "done" flag, so several categories mounting in
  // the same tick share one request instead of racing three.
  pending ??= read()
  return pending
}

function publish(value: boolean, identity: string | null = null): void {
  // The memo is dropped, not refreshed: after a sign-out the previous answer is stale, and
  // the next surface that needs the session should ask rather than trust this one.
  pending = undefined
  readGeneration += 1
  settle(value, identity)
}

const session: AccountSession = {
  signedIn: computed(() => signedIn.value),
  userId: computed(() => userId.value),
  revision: computed(() => revision.value),
  ensure,
  refresh: () => { pending = read(true); return pending },
  publish,
}

export function useAccountSession(): AccountSession {
  return session
}

/** Test seam: module state outlives a component, so a spec must be able to start clean. */
export function resetAccountSession(): void {
  readGeneration += 1
  pending = undefined
  signedIn.value = false
  userId.value = null
  revision.value = 0
}
