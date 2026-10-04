import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((fn) => fn());
});

it('runs concurrent server turns on one conversation one after another', async () => {
  const config = {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://queue.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: 'http://opendots.test/api/copilotkit',
    webSearchProvider: 'disabled' as const,
  };
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const runner = new SqliteAgentRunner(':memory:');
  cleanup.push(() => {
    store.close();
    workspace.close();
    runner.close();
  });
  // Automatic memory extraction would add model calls between turns.
  store.updateSettings({ memoryAllowed: false });
  const platform = new Platform(store, workspace, config, undefined, runner);
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
    config: { mode: 'live', baseUrl: config.baseUrl },
    platform,
    auth: false,
  });
  const thread = await platform.createConversation(
    workspace.dots()[0].id,
    'Voice',
  );
  let calls = 0;
  let inFlight = 0;
  let overlapped = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = String(request instanceof Request ? request.url : request);
    if (url.startsWith('https://queue.invalid/')) {
      calls += 1;
      const answer = `answer ${calls}`;
      inFlight += 1;
      overlapped ||= inFlight > 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight -= 1;
      return completion({ role: 'assistant', content: answer });
    }
    if (url.startsWith('http://opendots.test/'))
      return app.request(url.slice('http://opendots.test'.length), init);
    return new Response(null, { status: 204 });
  });
  // Two voice tasks in one call used to supersede each other: the first
  // failed and its messages were never saved.
  const [first, second] = await Promise.all([
    platform.turn(thread.id, 'first task', new AbortController().signal),
    platform.turn(thread.id, 'second task', new AbortController().signal),
  ]);
  expect([first, second]).toEqual(['answer 1', 'answer 2']);
  expect(overlapped).toBe(false);
  expect(
    runner.getThreadMessages(thread.id).map((message) => message.content),
  ).toEqual(['first task', 'answer 1', 'second task', 'answer 2']);
  // A turn stopped while waiting never starts.
  const stopped = new AbortController();
  const blocked = platform.turn(
    thread.id,
    'slow',
    new AbortController().signal,
  );
  const waiting = platform.turn(thread.id, 'never', stopped.signal);
  stopped.abort(new Error('Call ended.'));
  await expect(waiting).rejects.toThrow('Call ended.');
  await blocked;
  expect(calls).toBe(3);
});
