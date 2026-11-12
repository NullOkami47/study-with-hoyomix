import { describe, expect, it } from 'vitest';
import { RetentionGuard } from '../chat/retentionGuard';

const PAUSE = 'retention-paused';
const ATTEMPT = 'retention-attempt';
const OP = 'retention-operation';
const RECEIPT = 'retention-completion';

// Each put models one atomic DO KV operation, with faults on either side of commit.
class Storage {
  data = new Map<string, unknown>();
  writes: string[][] = [];
  faultAt = 0;
  faultAfterCommit = false;
  readFailure = false;
  async get<T>(key: string): Promise<T | undefined> {
    if (this.readFailure) throw new Error('read unavailable');
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === 'string' ? { [key]: value } : key;
    this.writes.push(Object.keys(entries));
    const fail = this.writes.length === this.faultAt;
    if (fail && !this.faultAfterCommit) throw new Error('write unavailable');
    for (const [name, item] of Object.entries(entries)) this.data.set(name, structuredClone(item));
    if (fail) throw new Error('acknowledgement unavailable');
  }
}

describe('retention causal completion guard', () => {
  it('keeps empty dormant storage healthy without writing', async () => {
    const storage = new Storage();
    const state = await new RetentionGuard(storage).inspect();
    expect(state.paused).toBe(false);
    expect(state.recovery).toBe('none');
    expect(storage.writes.length).toBe(0);
  });
  it('quarantines pre-protocol cleaned attempts even when the old boolean is false', async () => {
    const storage = new Storage();
    storage.data.set(PAUSE, false);
    storage.data.set(ATTEMPT, { token: 'legacy', at: 1, outcome: 'cleaned', markedParents: 2 });
    const state = await new RetentionGuard(storage).inspect();
    expect(state.paused).toBe(true);
    expect(state.recovery).toBe('blocked');
    expect(storage.writes.length).toBe(0);
  });

  it('finishes in four puts / eight keys and survives reconstruction', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const { operation, attempt } = await guard.begin('automatic', 10);
    expect((await new RetentionGuard(storage).inspect()).recovery).toBe('blocked');
    const checkpoint = await guard.checkpoint(operation, 4);
    expect((await new RetentionGuard(storage).inspect()).recovery).toBe('finalise');
    await guard.finish(checkpoint, attempt, 'automatic');
    const state = await new RetentionGuard(storage).inspect();
    expect(state.paused).toBe(false);
    expect(state.attempt?.outcome).toBe('cleaned');
    expect(state.attempt?.markedParents).toBe(4);
    expect(storage.writes.length).toBe(4);
    expect(storage.writes.reduce((n, keys) => n + keys.length, 0)).toBe(8);
  });

  for (const afterCommit of [false, true]) {
    for (const boundary of [1, 2, 3, 4]) {
      it(`reconstructs safely after put ${boundary} fails ${afterCommit ? 'after' : 'before'} commit`, async () => {
        const storage = new Storage();
        storage.faultAt = boundary;
        storage.faultAfterCommit = afterCommit;
        const guard = new RetentionGuard(storage);
        await expect((async () => {
          const { operation, attempt } = await guard.begin('automatic', 10);
          const checkpoint = await guard.checkpoint(operation, 3);
          await guard.finish(checkpoint, attempt, 'automatic');
        })()).rejects.toThrow();
        const state = await new RetentionGuard(storage).inspect();
        const safe = boundary === 1 && !afterCommit || boundary === 4 && afterCommit;
        expect(state.paused).toBe(!safe);
        expect(state.recovery).toBe(safe ? 'none' : boundary <= 2 && !(boundary === 2 && afterCommit) ? 'blocked' : 'finalise');
        if (state.paused) {
          await expect(new RetentionGuard(storage).begin('automatic', 20)).rejects.toThrow();
        }
      });
    }
  }

  it('requires Owner finalisation after ambiguous unpause and failed pause reassert', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const { operation, attempt } = await guard.begin('automatic', 10);
    const checkpoint = await guard.checkpoint(operation, 2);
    storage.faultAt = 3;
    storage.faultAfterCommit = true;
    await expect(guard.finish(checkpoint, attempt, 'automatic')).rejects.toThrow();
    storage.faultAt = 4;
    storage.faultAfterCommit = false;
    await expect(guard.reassert(attempt)).rejects.toThrow();
    const reconstructed = new RetentionGuard(storage);
    const snapshot = await reconstructed.inspect();
    expect(snapshot.durablePaused).toBe(false);
    expect(snapshot.paused).toBe(true);
    expect(snapshot.recovery).toBe('finalise');
    const consumed = await reconstructed.consume(snapshot, 20);
    expect(consumed.operation.id === operation.id).toBe(true);
    expect(consumed.attempt.token === attempt.token).toBe(false);
    await expect(reconstructed.consume(snapshot, 21)).rejects.toThrow();
    await reconstructed.finish(consumed.operation, consumed.attempt, 'owner');
    expect((await new RetentionGuard(storage).inspect()).paused).toBe(false);
  });

  it('cannot use a fresh generation to bypass an unknown SQL operation', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const { attempt } = await guard.begin('automatic', 10);
    await guard.reassert(attempt);
    const state = await guard.inspect();
    expect(state.recovery).toBe('blocked');
    await expect(guard.begin('owner', 20)).rejects.toThrow();
    await expect(guard.consume(state, 20)).rejects.toThrow();
  });

  it('permits one new Owner batch only after a known never-started operation', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    await guard.begin('automatic', 10, true);
    expect((await guard.inspect()).recovery).toBe('prune');
    await expect(guard.begin('automatic', 20)).rejects.toThrow();
    const next = await guard.begin('owner', 20);
    expect((await guard.inspect()).recovery).toBe('blocked');
    await expect(guard.begin('owner', 30)).rejects.toThrow();
    expect(next.operation.phase).toBe('started');
  });

  it('does not let an earlier completion receipt unpause a later started operation', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const first = await guard.begin('automatic', 1);
    await guard.finish(await guard.checkpoint(first.operation, 0), first.attempt, 'automatic');
    await guard.begin('automatic', 2);
    storage.data.set(PAUSE, false);
    const state = await new RetentionGuard(storage).inspect();
    expect(state.paused).toBe(true);
    expect(state.recovery).toBe('blocked');
  });

  it('keeps a receipt-backed manual pause paused until an Owner consumes it', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const first = await guard.begin('automatic', 1);
    await guard.finish(await guard.checkpoint(first.operation, 0), first.attempt, 'automatic');
    await guard.reassert(first.attempt);
    const snapshot = await new RetentionGuard(storage).inspect();
    expect(snapshot.paused).toBe(true);
    expect(snapshot.recovery).toBe('finalise');
    const consumed = await guard.consume(snapshot, 2);
    await guard.finish(consumed.operation, consumed.attempt, 'owner');
    expect((await guard.inspect()).paused).toBe(false);
  });

  for (const [key, invalid] of [
    [PAUSE, 'false'], [ATTEMPT, { token: 'x', at: 1, outcome: 'unknown' }],
    [OP, { version: 2 }], [OP, { version: 1, id: 'wrong', phase: 'started', at: 1, kind: 'automatic' }],
    [RECEIPT, { version: 2 }],
  ] as const) {
    it(`quarantines malformed or contradictory ${key} metadata ${JSON.stringify(invalid)}`, async () => {
      const storage = new Storage();
      const guard = new RetentionGuard(storage);
      const first = await guard.begin('automatic', 1);
      await guard.finish(await guard.checkpoint(first.operation, 1), first.attempt, 'automatic');
      storage.data.set(key, invalid);
      const state = await guard.inspect();
      expect(state.paused).toBe(true);
      expect(state.recovery).toBe('blocked');
      await expect(guard.begin('owner', 2)).rejects.toThrow();
    });
  }

  it('propagates read failures without writes or cached healthy answers', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    await guard.inspect();
    storage.readFailure = true;
    await expect(guard.inspect()).rejects.toThrow();
    await expect(guard.begin('automatic', 1)).rejects.toThrow();
    expect(storage.writes.length).toBe(0);
  });

  it('quarantines an isolated legacy pause boolean, including false', async () => {
    for (const pause of [true, false]) {
      const storage = new Storage();
      storage.data.set(PAUSE, pause);
      const snapshot = await new RetentionGuard(storage).inspect();
      expect(snapshot.paused).toBe(true);
      expect(snapshot.recovery).toBe('blocked');
    }
  });

  it('finalises an ambiguous second operation despite the previous operation receipt', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const first = await guard.begin('automatic', 1);
    await guard.finish(await guard.checkpoint(first.operation, 1), first.attempt, 'automatic');
    const second = await guard.begin('automatic', 2);
    const checkpoint = await guard.checkpoint(second.operation, 2);
    storage.faultAt = storage.writes.length + 1;
    storage.faultAfterCommit = true;
    await expect(guard.finish(checkpoint, second.attempt, 'automatic')).rejects.toThrow();
    const snapshot = await new RetentionGuard(storage).inspect();
    expect(snapshot.paused).toBe(true);
    expect(snapshot.recovery).toBe('finalise');
    await expect(guard.begin('owner', 3)).rejects.toThrow();
    const recovery = await guard.consume(snapshot, 3);
    await guard.finish(recovery.operation, recovery.attempt, 'owner');
    expect((await guard.inspect()).paused).toBe(false);
  });

  it('keeps the same completed operation finalisable after a repeated completion loses acknowledgement', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const first = await guard.begin('automatic', 1);
    await guard.finish(await guard.checkpoint(first.operation, 1), first.attempt, 'automatic');
    await guard.reassert(first.attempt);
    const recovery = await guard.consume(await guard.inspect(), 2);
    storage.faultAt = storage.writes.length + 1;
    storage.faultAfterCommit = true;
    await expect(guard.finish(recovery.operation, recovery.attempt, 'owner')).rejects.toThrow();
    const snapshot = await new RetentionGuard(storage).inspect();
    expect(snapshot.paused).toBe(true);
    expect(snapshot.recovery).toBe('finalise');
    await expect(guard.checkpoint(snapshot.operation!, 1)).rejects.toThrow();
    await expect(guard.begin('owner', 3)).rejects.toThrow();
    const retry = await guard.consume(snapshot, 3);
    await guard.finish(retry.operation, retry.attempt, 'owner');
    expect((await guard.inspect()).paused).toBe(false);
  });

  it('rejects negative or fractional SQL counts before persisting a checkpoint', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const first = await guard.begin('automatic', 1);
    for (const value of [-1, 0.5, 11, NaN, Infinity]) await expect(guard.checkpoint(first.operation, value)).rejects.toThrow();
    expect(storage.writes.length).toBe(1);
  });

  for (const afterCommit of [false, true]) {
    it(`keeps failed Owner consumption finalisation-only ${afterCommit ? 'after' : 'before'} commit`, async () => {
      const storage = new Storage();
      const guard = new RetentionGuard(storage);
      const first = await guard.begin('automatic', 1);
      await guard.checkpoint(first.operation, 2);
      const snapshot = await guard.inspect();
      storage.faultAt = storage.writes.length + 1;
      storage.faultAfterCommit = afterCommit;
      await expect(guard.consume(snapshot, 2)).rejects.toThrow();
      const reconstructed = new RetentionGuard(storage);
      const current = await reconstructed.inspect();
      expect(current.paused).toBe(true);
      expect(current.recovery).toBe('finalise');
      expect(current.token === snapshot.token).toBe(!afterCommit);
      if (afterCommit) await expect(reconstructed.consume(snapshot, 3)).rejects.toThrow();
      const recovery = await reconstructed.consume(current, 3);
      await reconstructed.finish(recovery.operation, recovery.attempt, 'owner');
      expect((await reconstructed.inspect()).paused).toBe(false);
    });
  }

  it('rejects a checkpoint when durable attempt metadata contradicts its journal', async () => {
    const storage = new Storage();
    const guard = new RetentionGuard(storage);
    const first = await guard.begin('automatic', 1);
    storage.data.set(ATTEMPT, { ...first.attempt, outcome: 'cleaned' });
    await expect(guard.checkpoint(first.operation, 2)).rejects.toThrow();
    expect(storage.writes.length).toBe(1);
  });

  for (const key of [ATTEMPT, OP, RECEIPT]) {
    it(`blocks oversized identifiers in ${key}`, async () => {
      const storage = new Storage();
      const guard = new RetentionGuard(storage);
      const first = await guard.begin('automatic', 1);
      await guard.finish(await guard.checkpoint(first.operation, 1), first.attempt, 'automatic');
      const old = storage.data.get(key) as Record<string, unknown>;
      const identifierKey = key === ATTEMPT ? 'token' : key === OP ? 'id' : 'completionId';
      storage.data.set(key, { ...old, [identifierKey]: 'a'.repeat(101) });
      expect((await guard.inspect()).recovery).toBe('blocked');
    });
  }
});
