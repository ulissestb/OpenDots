import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Store,
  eventHistoryLimit,
  runHistoryLimit,
} from '../src/server/store.js';

const resources: { store: Store; dir: string }[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-'));
  const path = join(dir, 'test.sqlite');
  const store = new Store(path);
  resources.push({ store, dir });
  return { store, path };
}
afterEach(() =>
  resources.splice(0).forEach(({ store, dir }) => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }),
);
describe('durable task lifecycle', () => {
  it('persists tasks and settings across connections', () => {
    const { store, path } = fixture();
    const task = store.createTask('Compare the sample notebooks', 60);
    store.updateSettings({ name: 'Sam' });
    const reopened = new Store(path);
    expect(reopened.task(task.id)?.prompt).toBe(task.prompt);
    expect(reopened.settings().name).toBe('Sam');
    reopened.close();
  });
  it('claims each due job once even through separate database connections', () => {
    const { store, path } = fixture();
    store.createTask('Research one');
    const second = new Store(path);
    const firstClaim = store.claim(1000);
    expect(firstClaim).toBeTruthy();
    expect(second.claim(1000)).toBeNull();
    second.close();
  });
  it('never overwrites a cancellation with a late result', () => {
    const { store } = fixture();
    const task = store.createTask('Research one');
    const claim = store.claim(Date.now())!;
    store.action(task.id, 'cancel');
    expect(
      store.finish(claim, { text: 'Late result', sources: [], sample: true }),
    ).toBe(false);
    expect(store.task(task.id)?.status).toBe('cancelled');
  });
  it('keeps recurring history and schedules only after completion', () => {
    const { store } = fixture();
    const task = store.createTask('Recurring research', 60);
    const now = Date.now();
    const claim = store.claim(now)!;
    store.finish(
      claim,
      { text: 'First result', sources: [], sample: true },
      now,
    );
    expect(store.claim(now + 59_000)).toBeNull();
    expect(store.claim(now + 60_001)?.id).toBe(task.id);
    expect(store.detail(task.id)?.runs).toHaveLength(2);
  });
  it('global pause invalidates running leases and blocks queued jobs', () => {
    const { store } = fixture();
    const task = store.createTask('Research one');
    const claim = store.claim(Date.now())!;
    store.updateSettings({ paused: true });
    expect(store.claim(Date.now())).toBeNull();
    expect(
      store.finish(claim, { text: 'Late result', sources: [], sample: true }),
    ).toBe(false);
    store.updateSettings({ paused: false });
    expect(store.claim(Date.now())?.id).toBe(task.id);
  });
  it('requeues a running task instead of failing it when the model changes', () => {
    const { store } = fixture();
    const task = store.createTask('Research one');
    const claim = store.claim(Date.now())!;
    store.updateSettings({ model: 'other-model' });
    expect(store.owns(claim)).toBe(false);
    store.fail(claim, 'Run stopped because settings changed.');
    expect(store.task(task.id)?.status).toBe('queued');
    expect(store.claim(Date.now())?.id).toBe(task.id);
  });
  it('recovers expired work after restart without duplicate completion', () => {
    const { store } = fixture();
    store.createTask('Recover me');
    const now = Date.now();
    const old = store.claim(now)!;
    const recovered = store.claim(now + 180_001)!;
    expect(recovered.id).toBe(old.id);
    expect(recovered.lease).not.toBe(old.lease);
    expect(store.finish(old, { text: 'Old', sources: [], sample: true })).toBe(
      false,
    );
    expect(
      store.finish(recovered, { text: 'New', sources: [], sample: true }),
    ).toBe(true);
  });
});
describe('recurring failures and history', () => {
  it('keeps a recurring task scheduled after a failure, with backoff', () => {
    const { store } = fixture();
    const task = store.createTask('Daily research', 86_400);
    const now = Date.now();
    store.fail(store.claim(now)!, 'Model unavailable', now);
    const failed = store.task(task.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Model unavailable');
    expect(failed.nextRunAt).toBe(now + 60_000);
    expect(store.claim(now + 59_000)).toBeNull();
    const retry = store.claim(now + 60_000)!;
    expect(retry.id).toBe(task.id);
    // A second consecutive failure doubles the wait.
    store.fail(retry, 'Model unavailable', now + 60_000);
    expect(store.task(task.id)?.nextRunAt).toBe(now + 180_000);
    // Success resets to the normal interval.
    const third = store.claim(now + 180_000)!;
    store.finish(
      third,
      { text: 'Recovered', sources: [], sample: true },
      now + 180_000,
    );
    expect(store.task(task.id)?.nextRunAt).toBe(now + 180_000 + 86_400_000);
  });
  it('caps the retry wait at the task interval', () => {
    const { store } = fixture();
    const task = store.createTask('Frequent research', 90);
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      store.fail(store.claim(now)!, 'Failed', now);
      now = store.task(task.id)!.nextRunAt!;
    }
    const last = store.task(task.id)!;
    expect(last.nextRunAt! - last.updatedAt).toBe(90_000);
  });
  it('ends a one-off task on failure', () => {
    const { store } = fixture();
    const task = store.createTask('Once');
    const now = Date.now();
    store.fail(store.claim(now)!, 'Failed', now);
    expect(store.task(task.id)?.nextRunAt).toBeNull();
    expect(store.claim(now + 10 * 86_400_000)).toBeNull();
  });
  it('pausing or cancelling a failed recurring task stops its retries', () => {
    const { store } = fixture();
    const task = store.createTask('Daily research', 86_400);
    const now = Date.now();
    store.fail(store.claim(now)!, 'Failed', now);
    store.action(task.id, 'pause');
    expect(store.claim(now + 86_400_000)).toBeNull();
  });
  it('prunes old runs and events per task', () => {
    const { store } = fixture();
    const task = store.createTask('Frequent research', 60);
    let now = Date.now();
    for (let i = 0; i < runHistoryLimit + 5; i++) {
      const claim = store.claim(now)!;
      store.finish(claim, { text: `Run ${i}`, sources: [], sample: true }, now);
      now += 60_000;
    }
    const detail = store.detail(task.id)!;
    expect(detail.runs).toHaveLength(runHistoryLimit);
    expect(detail.runs[0].result?.text).toBe(`Run ${runHistoryLimit + 4}`);
    expect(detail.events.length).toBeLessThanOrEqual(eventHistoryLimit);
    for (let i = 0; i < eventHistoryLimit + 10; i++)
      store.event(task.id, null, `Progress ${i}`);
    store.finish(
      store.claim(now)!,
      { text: 'Last', sources: [], sample: true },
      now,
    );
    const events = store.detail(task.id)!.events;
    expect(events).toHaveLength(eventHistoryLimit);
    expect(events.at(-1)?.text).toBe('Fictional sample brief ready.');
  });
});
