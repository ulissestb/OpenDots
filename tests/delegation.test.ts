import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { createApp } from '../src/server/app.js';
import {
  DotDelegation,
  type Delegation,
  delegationTools,
} from '../src/server/delegation.js';
import { DotAgent } from '../src/server/dot-agent.js';
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
const config = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: 'http://opendots.test/api/copilotkit',
  webSearchProvider: 'disabled' as const,
};
function workspaceWithDots() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => workspace.close());
  const lead = workspace.dots()[0];
  const researcher = workspace.createDot(
    lead.spaceId,
    'Researcher',
    'Finds and verifies facts with sources.',
    true,
    true,
  );
  workspace.bindThread('parent', lead.id, 'Parent');
  return { workspace, lead, researcher };
}
function toolCall(name: string, args: Record<string, unknown>, id = 'call') {
  return completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}
const runInput = (threadId: string, content: string): RunAgentInput => ({
  threadId,
  runId: 'run',
  state: {},
  context: [],
  messages: [{ id: 'user', role: 'user', content }],
  tools: [],
  forwardedProps: {},
});
const requestBody = (call: unknown[]) =>
  JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as {
    messages: { role: string; content: unknown }[];
    tools?: { function: { name: string } }[];
  };

describe('DotDelegation', () => {
  function delegation() {
    const f = workspaceWithDots();
    const turn = vi.fn(
      async (
        _threadId: string,
        _prompt: string,
        _signal: AbortSignal,
        _metadata?: Record<string, unknown>,
      ): Promise<string> => 'Verified answer.',
    );
    const create = vi.fn(async (dotId: string, title: string) =>
      f.workspace.bindThread(crypto.randomUUID(), dotId, title),
    );
    return {
      ...f,
      turn,
      create,
      d: new DotDelegation(f.workspace, create, turn),
    };
  }
  const request = (
    f: ReturnType<typeof workspaceWithDots>,
    overrides: Record<string, unknown> = {},
  ) => ({
    from: f.lead,
    parentThreadId: 'parent',
    targetDotId: f.researcher.id,
    task: 'Check the release date.',
    deadline: Date.now() + 120_000,
    signal: new AbortController().signal,
    ...overrides,
  });

  it('runs the task as the other Dot and reuses its conversation', async () => {
    const f = delegation();
    const first = await f.d.delegate(request(f, { context: 'Version 2.' }));
    expect(first).toMatchObject({
      dotId: f.researcher.id,
      dotName: 'Researcher',
      reply: 'Verified answer.',
    });
    expect(f.create).toHaveBeenCalledWith(
      f.researcher.id,
      `${f.lead.name} → Researcher`,
    );
    const [threadId, prompt, , metadata] = f.turn.mock.calls[0] as unknown as [
      string,
      string,
      AbortSignal,
      Record<string, unknown>,
    ];
    expect(threadId).toBe(first.threadId);
    expect(prompt).toContain('Check the release date.');
    expect(prompt).toContain('Version 2.');
    expect(metadata).toMatchObject({ opendotsSource: 'delegation' });
    const second = await f.d.delegate(request(f));
    expect(second.threadId).toBe(first.threadId);
    expect(f.create).toHaveBeenCalledTimes(1);
    // The registry is only populated while the child runs.
    expect(f.d.context(first.threadId)).toBeUndefined();
  });

  it('refuses self, cycles, and turns without enough time left', async () => {
    const f = delegation();
    await expect(
      f.d.delegate(request(f, { targetDotId: f.lead.id })),
    ).rejects.toThrow('cannot delegate to itself');
    await expect(
      f.d.delegate(request(f, { deadline: Date.now() + 5_000 })),
    ).rejects.toThrow('Not enough time left');
    // While the researcher works, it cannot hand the task back to the lead.
    let inner: Promise<unknown> | undefined;
    f.turn.mockImplementationOnce(async (threadId: string) => {
      inner = f.d.delegate({
        ...request(f),
        from: f.researcher,
        parentThreadId: threadId,
        targetDotId: f.lead.id,
      });
      await inner.catch(() => undefined);
      return 'done';
    });
    await f.d.delegate(request(f));
    await expect(inner).rejects.toThrow('already working on this request');
    expect(f.turn).toHaveBeenCalledTimes(1);
  });

  it('stops at the depth limit', async () => {
    const f = delegation();
    const third = f.workspace.createDot(
      f.lead.spaceId,
      'Writer',
      'Writes clearly.',
      true,
      true,
    );
    const fourth = f.workspace.createDot(
      f.lead.spaceId,
      'Editor',
      'Edits.',
      true,
      true,
    );
    let depthError: unknown;
    f.turn.mockImplementationOnce(async (researcherThread: string) => {
      f.turn.mockImplementationOnce(async (writerThread: string) => {
        depthError = await f.d
          .delegate({
            ...request(f),
            from: third,
            parentThreadId: writerThread,
            targetDotId: fourth.id,
          })
          .catch((error: unknown) => error);
        return 'writer done';
      });
      await f.d.delegate({
        ...request(f),
        from: f.researcher,
        parentThreadId: researcherThread,
        targetDotId: third.id,
      });
      return 'researcher done';
    });
    await f.d.delegate(request(f));
    expect(String(depthError)).toContain('depth limit');
  });

  it('passes cancellation to the child turn', async () => {
    const f = delegation();
    const controller = new AbortController();
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => (started = resolve));
    f.turn.mockImplementationOnce(
      (_threadId: string, _prompt: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
          started();
        }),
    );
    const running = f.d.delegate(request(f, { signal: controller.signal }));
    await childStarted;
    controller.abort(new Error('Owner stopped the run.'));
    await expect(running).rejects.toThrow('Owner stopped the run.');
    // A stop while the child conversation is being created never runs it.
    const fresh = delegation();
    const early = new AbortController();
    const pending = fresh.d.delegate(request(fresh, { signal: early.signal }));
    early.abort(new Error('Stopped early.'));
    await expect(pending).rejects.toThrow('Stopped early.');
    expect(fresh.turn).not.toHaveBeenCalled();
  });
});

describe('delegate_to_dot tool', () => {
  it('lists the other Dots, caps replies, and limits delegations per turn', async () => {
    const f = workspaceWithDots();
    const fake: Delegation = {
      context: () => undefined,
      delegate: vi.fn(async () => ({
        dotId: f.researcher.id,
        dotName: 'Researcher',
        threadId: 'child',
        reply: 'x'.repeat(30_000),
      })),
    };
    const [tool] = delegationTools({
      delegation: fake,
      from: f.lead,
      dots: f.workspace.dots(),
      parentThreadId: 'parent',
      deadline: Date.now() + 120_000,
      signal: new AbortController().signal,
      check: () => undefined,
    });
    expect(tool.description).toContain(f.researcher.id);
    expect(tool.description).not.toContain(`${f.lead.id}:`);
    const execute = (
      tool as unknown as {
        execute: (args: unknown) => Promise<{ reply: string }>;
      }
    ).execute;
    const args = { dot_id: f.researcher.id, task: 'Check it.' };
    const result = await execute(args);
    expect(result.reply.length).toBeLessThan(21_000);
    expect(result.reply).toContain('truncated');
    for (let index = 1; index < 4; index += 1) await execute(args);
    await expect(execute(args)).rejects.toThrow('limit for this turn');
  });

  it('is not offered when the only Dot is the caller', () => {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    cleanup.push(() => workspace.close());
    const dot = workspace.dots()[0];
    expect(
      delegationTools({
        delegation: { context: () => undefined, delegate: vi.fn() },
        from: dot,
        dots: workspace.dots(),
        parentThreadId: 'parent',
        deadline: Date.now() + 120_000,
        signal: new AbortController().signal,
        check: () => undefined,
      }),
    ).toEqual([]);
  });
});

describe('DotAgent delegation', () => {
  function agentFixture(delegation: Delegation) {
    const f = workspaceWithDots();
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const agent = (dotId: string) =>
      new DotAgent(
        store,
        f.workspace,
        config,
        dotId,
        false,
        undefined,
        undefined,
        delegation,
      );
    return { ...f, store, agent };
  }

  it('offers delegate_to_dot only while the Dot permission allows it', async () => {
    const f = agentFixture({ context: () => undefined, delegate: vi.fn() });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        completion({ role: 'assistant', content: 'Hi.' }),
      );
    await lastValueFrom(
      f.agent(f.lead.id).run(runInput('parent', 'Hi')).pipe(toArray()),
    );
    const allowed = requestBody(network.mock.calls[0]);
    expect(allowed.tools?.map((tool) => tool.function.name)).toContain(
      'delegate_to_dot',
    );
    expect(JSON.stringify(allowed.messages)).toContain('delegate_to_dot');
    f.workspace.updateDot(f.lead.id, { ...f.lead, delegationAllowed: false });
    await lastValueFrom(
      f.agent(f.lead.id).run(runInput('parent', 'Hi')).pipe(toArray()),
    );
    const denied = requestBody(network.mock.calls[1]);
    expect(denied.tools?.map((tool) => tool.function.name) ?? []).not.toContain(
      'delegate_to_dot',
    );
  });

  it('tells a delegated run who asked, drops memory tools, and keeps its deadline', async () => {
    const f = agentFixture({
      context: (threadId) =>
        threadId === 'child'
          ? {
              depth: 1,
              chain: [],
              deadline: Date.now() + 60,
              fromDotId: 'lead',
              fromDotName: 'Lead Dot',
              parentThreadId: 'parent',
              signal: new AbortController().signal,
            }
          : undefined,
      delegate: vi.fn(),
    });
    f.workspace.bindThread('child', f.researcher.id, 'Child');
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            ),
          ),
      );
    const events = await lastValueFrom(
      f
        .agent(f.researcher.id)
        .run(runInput('child', 'Task delegated by the Dot Lead Dot'))
        .pipe(toArray()),
    );
    const body = requestBody(network.mock.calls[0]);
    expect(JSON.stringify(body.messages)).toContain(
      'opened by the Dot Lead Dot',
    );
    const names = body.tools?.map((tool) => tool.function.name) ?? [];
    expect(names).not.toContain('save_memory');
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
  });

  it('stops the delegated run on the server when the delegating run stops', async () => {
    const parent = new AbortController();
    const f = agentFixture({
      context: (threadId) =>
        threadId === 'child'
          ? {
              depth: 1,
              chain: [],
              deadline: Date.now() + 60_000,
              fromDotId: 'lead',
              fromDotName: 'Lead Dot',
              parentThreadId: 'parent',
              signal: parent.signal,
            }
          : undefined,
      delegate: vi.fn(),
    });
    f.workspace.bindThread('child', f.researcher.id, 'Child');
    let modelSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      modelSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        ),
      );
    });
    const done = lastValueFrom(
      f
        .agent(f.researcher.id)
        .run(runInput('child', 'Task delegated by the Dot Lead Dot'))
        .pipe(toArray()),
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(modelSignal).toBeDefined());
    parent.abort(new Error('Owner stopped the run.'));
    await vi.waitFor(() => expect(modelSignal?.aborted).toBe(true));
    await done;
  });
});

describe('delegation through the platform', () => {
  it('runs the child turn in its own conversation and returns its reply', async () => {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const runner = new SqliteAgentRunner(':memory:');
    cleanup.push(() => {
      store.close();
      workspace.close();
      runner.close();
    });
    const lead = workspace.dots()[0];
    const researcher = workspace.createDot(
      lead.spaceId,
      'Researcher',
      'Finds facts.',
      true,
      true,
    );
    const platform = new Platform(store, workspace, config, undefined, runner);
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
      config: { mode: 'live', baseUrl: config.baseUrl },
      platform,
      auth: false,
    });
    const parent = await platform.createConversation(lead.id, 'Parent');
    const model = [
      toolCall('delegate_to_dot', {
        dot_id: researcher.id,
        task: 'Find the answer.',
      }),
      completion({ role: 'assistant', content: 'Researcher found 42.' }),
      completion({ role: 'assistant', content: 'The answer is 42.' }),
    ];
    const modelBodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const url = String(request instanceof Request ? request.url : request);
      if (url.startsWith('https://unused.invalid/')) {
        modelBodies.push(String(init?.body));
        return model.shift()!;
      }
      if (url.startsWith('http://opendots.test/'))
        return app.request(url.slice('http://opendots.test'.length), init);
      return new Response(null, { status: 204 });
    });
    const reply = await platform.turn(
      parent.id,
      'Ask the researcher.',
      new AbortController().signal,
    );
    expect(reply).toBe('The answer is 42.');
    const child = workspace.delegationThread(parent.id, researcher.id)!;
    expect(workspace.requireThread(child, researcher.id).title).toBe(
      `${lead.name} → Researcher`,
    );
    expect(runner.getThreadMessages(child)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'Researcher found 42.',
        }),
      ]),
    );
    // The child's prompt is marked internal so memory learning skips it.
    expect(
      runner
        .getThreadMessages(child)
        .some((message) => message.id.startsWith('opendots:delegation:')),
    ).toBe(true);
    expect(modelBodies[2]).toContain('Researcher found 42.');
  });
});

describe('delegation permission API', () => {
  it('defaults to on for new Dots and saves the per-Dot toggle', async () => {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    cleanup.push(() => {
      store.close();
      workspace.close();
    });
    const platform = new Platform(store, workspace, config);
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
      config: { mode: 'live', baseUrl: config.baseUrl },
      platform,
      auth: false,
    });
    const send = (method: string, body: unknown) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const base = {
      spaceId: workspace.dots()[0].spaceId,
      name: 'Writer',
      instructions: 'Writes clearly.',
      researchAllowed: true,
      memoryAllowed: true,
    };
    const created = await app.request('/api/dots', send('POST', base));
    expect(created.status).toBe(201);
    const dot = (await created.json()) as { id: string };
    expect(workspace.dot(dot.id)?.delegationAllowed).toBe(true);
    const updated = await app.request(
      `/api/dots/${dot.id}`,
      send('PUT', { ...base, delegationAllowed: false }),
    );
    expect(await updated.json()).toMatchObject({ delegationAllowed: false });
    // Omitting the field keeps the saved choice.
    await app.request(`/api/dots/${dot.id}`, send('PUT', base));
    expect(workspace.dot(dot.id)?.delegationAllowed).toBe(false);
  });
});
