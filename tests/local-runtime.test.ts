import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { completedOutput } from '../src/server/providers/openai-codex.js';
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
function fixture(path: string) {
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner');
  const runner = new SqliteAgentRunner(path);
  cleanup.unshift(() => {
    store.close();
    workspace.close();
    runner.close();
  });
  const config = {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  };
  const platform = new Platform(store, workspace, config, undefined, runner);
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
    config: { mode: 'live', baseUrl: config.baseUrl },
    platform,
    auth: false,
  });
  return { app, workspace, runner, platform };
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify(body),
});
const input = (threadId: string, text: string) => ({
  threadId,
  runId: 'run-1',
  state: {},
  messages: [{ id: 'user-1', role: 'user', content: text }],
  tools: [],
  context: [],
  forwardedProps: {},
});
describe('conversations without CopilotKit Intelligence', () => {
  it('needs only a model, then runs and persists chats locally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-local-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite');
    const first = fixture(path);
    expect(first.platform.setup()).toMatchObject({
      intelligence: false,
      missing: [],
    });
    const dot = first.workspace.dots()[0];
    const created = await first.app.request(
      '/api/conversations',
      json({ dotId: dot.id, title: 'Local chat' }),
    );
    expect(created.status).toBe(201);
    const { id: threadId } = (await created.json()) as { id: string };
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((request, init) =>
      String(request instanceof Request ? request.url : request).startsWith(
        'https://unused.invalid/',
      )
        ? Promise.resolve(
            completion({ role: 'assistant', content: 'Hello from the model.' }),
          )
        : // Telemetry and other SDK traffic stay off the network in tests.
          String(request).startsWith('http')
          ? Promise.resolve(new Response(null, { status: 204 }))
          : real(request, init),
    );
    const run = await first.app.request(
      `/api/copilotkit/agent/${dot.id}/run`,
      json(input(threadId, 'Hi')),
    );
    expect(run.status).toBe(200);
    expect(await run.text()).toContain('Hello from the model.');
    await vi.waitFor(() =>
      expect(first.runner.getThreadMessages(threadId)).toHaveLength(2),
    );
    expect(await first.platform.history(threadId)).toContain(
      'assistant: Hello from the model.',
    );
    cleanup.shift()!();
    // A restarted server replays the stored conversation.
    const second = fixture(path);
    const replay = await second.app.request(
      `/api/copilotkit/agent/${dot.id}/connect`,
      json(input(threadId, '')),
    );
    expect(await replay.text()).toContain('Hello from the model.');
    expect(second.runner.listThreads()).toMatchObject([
      { id: threadId, agentId: dot.id },
    ]);
  });
  it('still enforces conversation ownership on the local runtime', async () => {
    const { app, workspace } = fixture(':memory:');
    const dot = workspace.dots()[0];
    const response = await app.request(
      `/api/copilotkit/agent/${dot.id}/run`,
      json(input('foreign-thread', 'Hi')),
    );
    expect(response.status).toBe(403);
  });
});
describe('Codex stream repair', () => {
  it('refills an empty response.completed output from streamed items', async () => {
    const item = { type: 'function_call', call_id: 'c', name: 'x' };
    const events = [
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'r', output: [] } },
    ];
    const raw = events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join('');
    // Split mid-event to cover chunk boundaries.
    const bytes = new TextEncoder().encode(raw);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 37));
        controller.enqueue(bytes.slice(37));
        controller.close();
      },
    });
    const text = await new Response(
      source.pipeThrough(completedOutput()),
    ).text();
    const completed = text
      .split('\n\n')
      .map((block) =>
        block.split('\n').find((line) => line.startsWith('data:')),
      )
      .filter((line): line is string => !!line)
      .map((line) => JSON.parse(line.slice(5)))
      .find((event) => event.type === 'response.completed');
    expect(completed.response.output).toEqual([item]);
  });
});
