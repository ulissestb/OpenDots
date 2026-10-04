import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { research, type Config } from '../src/server/research.js';
const config: Config = {
  mode: 'live',
  apiKey: 'test',
  model: 'test',
  browserUrl: 'http://browser:4311',
  browserSecret: 'test',
  baseUrl: 'https://model.example/v1',
};
afterEach(() => vi.unstubAllGlobals());
it('aborts research when permissions are revoked outside the runner instance', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, config);
  let requestSignal: AbortSignal | undefined;
  const request = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        requestSignal = options.signal ?? undefined;
        requestSignal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', request);
  store.createTask('Read https://example.com');
  const tick = runner.tick();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  store.updateSettings({ memoryAllowed: false });
  await tick;
  expect(requestSignal?.aborted).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect(store.tasks()[0].status).toBe('queued');
  runner.stop();
  store.close();
});
it('checks abort again before sending source evidence or memories to the model', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      title: 'Source',
      text: 'Page text',
      url: 'https://example.com',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(
    research(
      'Read https://example.com',
      [],
      config,
      controller.signal,
      (text) => {
        if (text.startsWith('Source captured')) controller.abort();
      },
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it('omits stored memories from research when memory permission is disabled', async () => {
  const store = new Store(':memory:');
  store.saveMemory({ text: 'Sensitive preference' });
  store.updateSettings({ memoryAllowed: false });
  const task = store.createTask('Read this sample');
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  await runner.tick();
  expect(store.detail(task.id)?.runs[0].result?.text).not.toContain(
    'Sensitive preference',
  );
  store.close();
});
it('requeues active work on graceful shutdown instead of losing it', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, config);
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) =>
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  store.createTask('Read https://example.com');
  const pending = runner.tick();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  runner.stop();
  await pending;
  expect(store.tasks()[0].status).toBe('queued');
  expect(store.claim()).toBeTruthy();
  store.close();
});
it('survives database errors in the scheduler tick', async () => {
  const store = new Store(':memory:');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const claim = vi.spyOn(store, 'claim').mockImplementation(() => {
    throw new Error('database is locked');
  });
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  runner.start();
  await vi.waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      'Scheduler tick failed:',
      expect.any(String),
    ),
  );
  claim.mockRestore();
  // A failure while recording the failure does not reject the tick either.
  store.createTask('Read this sample');
  vi.spyOn(store, 'fail').mockImplementation(() => {
    throw new Error('disk I/O error');
  });
  const failing = new Runner(store, { mode: 'sample', baseUrl: '' }, () =>
    Promise.reject(new Error('Model failed')),
  );
  await expect(failing.tick()).resolves.toBeUndefined();
  runner.stop();
  errors.mockRestore();
  store.close();
});
