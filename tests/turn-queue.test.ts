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

it('lets a browser run finish before a server turn on the same conversation', async () => {
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
  store.updateSettings({ memoryAllowed: false });
  const platform = new Platform(store, workspace, config, undefined, runner);
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
    config: { mode: 'live', baseUrl: config.baseUrl },
    platform,
    auth: false,
  });
  const dot = workspace.dots()[0];
  const thread = await platform.createConversation(dot.id, 'Chat');
  let release!: () => void;
  const owner = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = String(request instanceof Request ? request.url : request);
    if (url.startsWith('https://queue.invalid/')) {
      calls += 1;
      if (calls === 1) {
        await owner;
        return completion({ role: 'assistant', content: 'owner reply' });
      }
      return completion({ role: 'assistant', content: 'task reply' });
    }
    if (url.startsWith('http://opendots.test/'))
      return app.request(url.slice('http://opendots.test'.length), init);
    return new Response(null, { status: 204 });
  });
  const browser = app.request(`/api/copilotkit/agent/${dot.id}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      threadId: thread.id,
      runId: 'browser-run',
      state: {},
      messages: [{ id: 'owner-1', role: 'user', content: 'owner message' }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
  await vi.waitFor(() => expect(calls).toBe(1));
  const task = platform.turn(
    thread.id,
    'scheduled task',
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The server turn waits instead of superseding the owner's reply.
  expect(calls).toBe(1);
  release();
  await (await browser).text();
  expect(await task).toBe('task reply');
  expect(
    runner.getThreadMessages(thread.id).map((message) => message.content),
  ).toEqual(['owner message', 'owner reply', 'scheduled task', 'task reply']);
});

it('stores only replay-relevant run inputs and the most recent runs', async () => {
  const { trimEvents } = await import('../src/server/sqlite-runner.js');
  const { EventType } = await import('@ag-ui/client');
  const run = (index: number) => [
    {
      type: EventType.RUN_STARTED,
      threadId: 't',
      runId: `r${index}`,
      input: {
        threadId: 't',
        runId: `r${index}`,
        messages: [{ id: `m${index}`, role: 'user', content: 'hi' }],
        tools: [{ name: 'big', parameters: 'x'.repeat(1000) }],
        context: [{ value: 'y'.repeat(1000) }],
      },
    },
    { type: EventType.RUN_FINISHED, threadId: 't', runId: `r${index}` },
  ];
  const events = Array.from({ length: 205 }, (_, index) => run(index)).flat();
  const trimmed = trimEvents(events as never) as unknown as {
    runId: string;
    input?: Record<string, unknown>;
  }[];
  expect(trimmed).toHaveLength(400);
  expect(trimmed[0].runId).toBe('r5');
  expect(Object.keys(trimmed[0].input ?? {}).sort()).toEqual([
    'messages',
    'runId',
    'threadId',
  ]);
});
