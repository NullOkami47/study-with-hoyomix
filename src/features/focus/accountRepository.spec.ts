import { expect, it } from 'vitest'
import { ref } from 'vue'
import { createAccountFocusRepository } from './accountRepository'

it('keeps anonymous and account histories separate, including a run crossing logout', async () => {
  const user = ref<string | null>('A')
  const scoped = createAccountFocusRepository(user)
  const record = { id: crypto.randomUUID(), schemaVersion: 1 as const, phase: 'focus' as const,
    startedAt: '2026-10-16T00:00:00.000Z', endedAt: '2026-10-16T00:01:00.000Z', createdAt: '2026-10-16T00:01:00.000Z',
    plannedFocusSeconds: 60, actualFocusSeconds: 60, status: 'completed' as const }
  scoped.claimRun(record.id)
  user.value = 'B'
  await scoped.timerRepository.recordIfAbsent(record)
  expect(await scoped.repository.list()).toEqual([])
  user.value = 'A'
  expect((await scoped.repository.list()).map(v => v.id)).toEqual([record.id])
  user.value = null
  expect(await scoped.repository.list()).toEqual([])
  scoped.destroy()
})
