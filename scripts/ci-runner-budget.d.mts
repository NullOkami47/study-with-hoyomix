export type TimeBudgetName =
  | 'realWranglerRelease'
  | 'realWranglerBackgroundTransition'
  | 'authCrossDeviceSync'
  | 'socialAuthVisual'
  | 'preferencesModuleReload'
export type ConcurrencyBudgetName = 'workerTests'
export function concurrencyBudget(name: ConcurrencyBudgetName, env?: Record<string, string | undefined>): number
export function runnerProfile(env?: Record<string, string | undefined>): 'self-hosted' | 'hosted'
export function timeBudget(name: TimeBudgetName, env?: Record<string, string | undefined>): number
export function recordElapsed(label: string, budgetName: TimeBudgetName, startedAt: number, env?: Record<string, string | undefined>): void
