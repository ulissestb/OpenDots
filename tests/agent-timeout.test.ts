import { afterEach, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { runTimeoutMs } from '../src/server/platform-config.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

it('stops a turn that exceeds its budget with a visible run error', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Timeout');
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
      runTimeoutMs: 50,
    },
    dot.id,
  );
  // The model never answers until the run is aborted.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        ),
      ),
  );
  const events = await lastValueFrom(
    agent
      .run({
        threadId: 'thread',
        runId: 'run',
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'Hello' }],
        tools: [],
        forwardedProps: {},
      })
      .pipe(toArray()),
  );
  expect(events.at(-1)).toEqual(
    expect.objectContaining({
      type: EventType.RUN_ERROR,
      message: expect.stringContaining('exceeded the 1 second limit'),
    }),
  );
});

it('parses the run budget with a default and clamps it', () => {
  expect(runTimeoutMs(undefined)).toBe(300_000);
  expect(runTimeoutMs('nope')).toBe(300_000);
  expect(runTimeoutMs('5')).toBe(30_000);
  expect(runTimeoutMs('600')).toBe(600_000);
  expect(runTimeoutMs('99999')).toBe(1_800_000);
});
