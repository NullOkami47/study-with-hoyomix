interface RetentionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
}

export interface RetentionAttempt {
  token: string;
  at: number;
  outcome: 'in_progress' | 'cleaned' | 'recovered' | 'failed';
  operationId?: string;
  markedParents?: number;
}

export interface RetentionOperation {
  version: 1;
  id: string;
  phase: 'started' | 'not_started' | 'sql_complete' | 'complete';
  at: number;
  kind: 'automatic' | 'owner';
  markedParents?: number;
  completionId?: string;
}

interface CompletionReceipt {
  version: 1;
  operationId: string;
  completionId: string;
}

export interface RetentionSnapshot {
  paused: boolean;
  durablePaused: boolean;
  token: string | null;
  attempt?: RetentionAttempt;
  operation?: RetentionOperation;
  state: string;
  recovery: 'blocked' | 'finalise' | 'prune' | 'none';
}

const PAUSE = 'retention-paused';
const ATTEMPT = 'retention-attempt';
const OPERATION = 'retention-operation';
const COMPLETION = 'retention-completion';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function validAttempt(value: unknown): value is RetentionAttempt {
  return record(value) && keys(value, ['token', 'at', 'outcome', 'operationId', 'markedParents']) &&
    string(value.token) && time(value.at) && ['in_progress', 'cleaned', 'recovered', 'failed'].includes(String(value.outcome)) &&
    (value.operationId === undefined || string(value.operationId)) &&
    (value.markedParents === undefined || count(value.markedParents));
}

function validOperation(value: unknown): value is RetentionOperation {
  if (!record(value) || !keys(value, ['version', 'id', 'phase', 'at', 'kind', 'markedParents', 'completionId']) ||
      value.version !== 1 || !string(value.id) || !time(value.at) || !['automatic', 'owner'].includes(String(value.kind))) return false;
  if (value.phase === 'started' || value.phase === 'not_started') {
    return value.markedParents === undefined && value.completionId === undefined;
  }
  if (value.phase === 'sql_complete') return count(value.markedParents) && value.completionId === undefined;
  return value.phase === 'complete' && count(value.markedParents) && string(value.completionId);
}

function validReceipt(value: unknown): value is CompletionReceipt {
  return record(value) && keys(value, ['version', 'operationId', 'completionId']) &&
    value.version === 1 && string(value.operationId) && string(value.completionId);
}

/** Durable coordination only. The caller owns SQL and serialises retention events. */
export class RetentionGuard {
  constructor(private readonly storage: RetentionStorage) {}

  async inspect(): Promise<RetentionSnapshot> {
    // No cached healthy result: a reconstruction and every later event read durable evidence.
    const paused = await this.storage.get<unknown>(PAUSE);
    const attempt = await this.storage.get<unknown>(ATTEMPT);
    const operation = await this.storage.get<unknown>(OPERATION);
    const receipt = await this.storage.get<unknown>(COMPLETION);
    const base: RetentionSnapshot = {
      paused: true, durablePaused: paused === true, token: null, state: 'invalid', recovery: 'blocked',
    };
    if (paused !== undefined && typeof paused !== 'boolean' ||
        attempt !== undefined && !validAttempt(attempt) ||
        operation !== undefined && !validOperation(operation) ||
        receipt !== undefined && !validReceipt(receipt)) return base;
    if (operation === undefined) {
      if (attempt === undefined && receipt === undefined && paused === undefined) {
        return { ...base, paused: false, state: 'healthy', recovery: 'none' };
      }
      return { ...base, state: 'legacy_quarantined', ...(validAttempt(attempt) ? { attempt, token: attempt.token } : {}) };
    }
    if (!validOperation(operation) || !validAttempt(attempt) || attempt.operationId !== operation.id || paused === undefined) return base;
    const snapshot = { ...base, attempt, operation, token: attempt.token };
    if (operation.phase === 'started' || operation.phase === 'not_started') {
      if (attempt.outcome !== 'in_progress' && attempt.outcome !== 'failed' || attempt.markedParents !== undefined) return snapshot;
      return { ...snapshot, state: operation.phase === 'started' ? 'sql_unknown' : 'not_started',
        recovery: operation.phase === 'started' ? 'blocked' : 'prune' };
    }
    if (attempt.markedParents !== undefined && attempt.markedParents !== operation.markedParents) return snapshot;
    if (operation.phase === 'sql_complete') {
      if (attempt.outcome !== 'in_progress' && attempt.outcome !== 'failed') return snapshot;
      return { ...snapshot, state: 'finalisation_required', recovery: 'finalise' };
    }
    // Prior operations and interrupted Owner finalisations may leave a valid old
    // receipt. Only an exact match proves completion; other valid receipts keep
    // the operation finalisation-only and can never authorise SQL replay.
    const confirmed = validReceipt(receipt) && receipt.operationId === operation.id && receipt.completionId === operation.completionId;
    if (confirmed && paused === false && (attempt.outcome === 'cleaned' || attempt.outcome === 'recovered') &&
        attempt.markedParents === operation.markedParents) {
      return { ...snapshot, paused: false, state: 'confirmed', recovery: 'none' };
    }
    return { ...snapshot, state: 'finalisation_required', recovery: 'finalise' };
  }

  async begin(kind: 'automatic' | 'owner', now: number, notStarted = false): Promise<{ attempt: RetentionAttempt; operation: RetentionOperation }> {
    const snapshot = await this.inspect();
    if (!time(now) || snapshot.paused && !(kind === 'owner' && snapshot.recovery === 'prune')) throw new Error('Retention is quarantined');
    const operation: RetentionOperation = { version: 1, id: crypto.randomUUID(), phase: notStarted ? 'not_started' : 'started', at: now, kind };
    const attempt: RetentionAttempt = { token: crypto.randomUUID(), at: now, outcome: 'in_progress', operationId: operation.id };
    await this.storage.put({ [PAUSE]: true, [ATTEMPT]: attempt, [OPERATION]: operation });
    return { attempt, operation };
  }

  async checkpoint(operation: RetentionOperation, markedParents: number): Promise<RetentionOperation> {
    const snapshot = await this.inspect();
    if (!count(markedParents) || operation.phase !== 'started' || snapshot.state !== 'sql_unknown' ||
        snapshot.operation?.id !== operation.id || snapshot.operation.phase !== 'started') {
      throw new Error('Invalid retention checkpoint');
    }
    const checkpoint: RetentionOperation = { ...snapshot.operation, phase: 'sql_complete', markedParents };
    await this.storage.put(OPERATION, checkpoint);
    return checkpoint;
  }

  async finish(operation: RetentionOperation, attempt: RetentionAttempt, kind: 'automatic' | 'owner'): Promise<void> {
    const snapshot = await this.inspect();
    if (snapshot.recovery !== 'finalise' || snapshot.operation?.id !== operation.id || snapshot.token !== attempt.token ||
        attempt.operationId !== operation.id || operation.markedParents !== snapshot.operation.markedParents) {
      throw new Error('Invalid retention completion');
    }
    const completionId = crypto.randomUUID();
    const complete: RetentionOperation = { ...snapshot.operation, phase: 'complete', completionId };
    const completed: RetentionAttempt = { ...attempt, outcome: kind === 'owner' ? 'recovered' : 'cleaned', markedParents: complete.markedParents };
    await this.storage.put({ [OPERATION]: complete, [ATTEMPT]: completed, [PAUSE]: false });
    // This receipt certifies acknowledgement of the preceding put only, never HTTP delivery.
    await this.storage.put(COMPLETION, { version: 1, operationId: complete.id, completionId } satisfies CompletionReceipt);
  }

  async consume(snapshot: RetentionSnapshot, now: number): Promise<{ operation: RetentionOperation; attempt: RetentionAttempt }> {
    const current = await this.inspect();
    if (!time(now) || !current.paused || current.recovery !== 'finalise' || !current.operation ||
        snapshot.token !== current.token || snapshot.operation?.id !== current.operation.id) throw new Error('Invalid retention recovery generation');
    const attempt: RetentionAttempt = { token: crypto.randomUUID(), at: now, outcome: 'in_progress', operationId: current.operation.id };
    await this.storage.put({ [PAUSE]: true, [ATTEMPT]: attempt });
    return { operation: current.operation, attempt };
  }

  async reassert(attempt: RetentionAttempt): Promise<void> {
    // Never replace the journal: SQL-complete knowledge must survive a failed completion.
    await this.storage.put({ [PAUSE]: true, [ATTEMPT]: { ...attempt, outcome: 'failed' } });
  }
}
