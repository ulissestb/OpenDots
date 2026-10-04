import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { parseSkillMarkdown } from '../src/shared/skills.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((fn) => fn());
});
const config = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://skills.invalid/v1',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: '',
  webSearchProvider: 'disabled' as const,
};
const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
function fixture() {
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
  const dot = workspace.dots()[0];
  const other = workspace.createDot(
    dot.spaceId,
    'Other',
    'Another Dot.',
    true,
    true,
  );
  workspace.bindThread('thread', dot.id, 'Skills');
  return { store, workspace, app, dot, other };
}
const skill = {
  name: 'weekly-report',
  description: 'Write the weekly status report.',
  instructions: 'Use the template in template.md. Keep it under a page.',
  files: { 'template.md': '# Week {{n}}' },
};

describe('SKILL.md parsing', () => {
  it('reads name, description, and body', () => {
    expect(
      parseSkillMarkdown(
        '---\nname: evidence-review\ndescription: "Review evidence."\n---\nCompare sources.\n',
      ),
    ).toEqual({
      name: 'evidence-review',
      description: 'Review evidence.',
      instructions: 'Compare sources.',
    });
    expect(parseSkillMarkdown('Just steps.')).toEqual({
      instructions: 'Just steps.',
    });
  });
});

describe('skills API', () => {
  it('creates, lists, updates, and deletes skills with validation', async () => {
    const f = fixture();
    const created = await f.app.request('/api/skills', send('POST', skill));
    expect(created.status).toBe(201);
    const saved = (await created.json()) as { id: string; dotIds: unknown };
    expect(saved.dotIds).toBeNull();
    expect(
      (await f.app.request('/api/skills', send('POST', skill))).status,
    ).toBe(409);
    expect(
      (
        await f.app.request(
          '/api/skills',
          send('POST', { ...skill, name: 'Bad Name' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.app.request(
          '/api/skills',
          send('POST', {
            ...skill,
            name: 'escape',
            files: { '../secret': 'x' },
          }),
        )
      ).status,
    ).toBe(400);
    const updated = await f.app.request(
      `/api/skills/${saved.id}`,
      send('PUT', { ...skill, dotIds: [f.other.id] }),
    );
    expect(await updated.json()).toMatchObject({ dotIds: [f.other.id] });
    const list = (await (await f.app.request('/api/skills')).json()) as {
      name: string;
    }[];
    expect(list.map((item) => item.name)).toEqual(['weekly-report']);
    expect(
      (await f.app.request(`/api/skills/${saved.id}`, send('DELETE', {})))
        .status,
    ).toBe(200);
    expect(f.workspace.skills.list()).toEqual([]);
  });
});

describe('skills in a run', () => {
  const run = (f: ReturnType<typeof fixture>) =>
    lastValueFrom(
      new DotAgent(f.store, f.workspace, config, f.dot.id)
        .run({
          threadId: 'thread',
          runId: crypto.randomUUID(),
          state: {},
          context: [],
          messages: [{ id: 'user', role: 'user', content: 'Weekly report' }],
          tools: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
  const body = (call: unknown[]) =>
    JSON.parse(String((call[1] as RequestInit).body)) as {
      messages: { role: string; content: unknown }[];
      tools?: { function: { name: string } }[];
    };

  it('lists assigned skills, loads them on demand, and hides others', async () => {
    const f = fixture();
    f.workspace.skills.save(skill);
    f.workspace.skills.save({
      ...skill,
      name: 'not-mine',
      description: 'Only for the other Dot.',
      dotIds: [f.other.id],
    });
    f.workspace.skills.save({
      ...skill,
      name: 'switched-off',
      enabled: false,
    });
    const replies = [
      completion(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'load',
              type: 'function',
              function: {
                name: 'load_skill',
                arguments: JSON.stringify({ name: 'weekly-report' }),
              },
            },
          ],
        },
        'tool_calls',
      ),
      completion(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'file',
              type: 'function',
              function: {
                name: 'read_skill_file',
                arguments: JSON.stringify({
                  name: 'weekly-report',
                  path: 'template.md',
                }),
              },
            },
          ],
        },
        'tool_calls',
      ),
      completion({ role: 'assistant', content: 'Report ready.' }),
    ];
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (request) =>
        String(request).startsWith('https://skills.invalid/')
          ? replies.shift()!
          : new Response(null, { status: 204 }),
      );
    await run(f);
    const calls = network.mock.calls.filter((call) =>
      String(call[0]).startsWith('https://skills.invalid/'),
    );
    const first = body(calls[0]);
    const prompt = JSON.stringify(first.messages);
    expect(prompt).toContain('weekly-report: Write the weekly status report.');
    expect(prompt).not.toContain('not-mine');
    expect(prompt).not.toContain('switched-off');
    expect(prompt).not.toContain('Keep it under a page');
    expect(first.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(['load_skill', 'read_skill_file']),
    );
    expect(JSON.stringify(body(calls[1]).messages)).toContain(
      'Keep it under a page',
    );
    expect(JSON.stringify(body(calls[2]).messages)).toContain('# Week {{n}}');
  });

  it('offers no skill tools when none are assigned', async () => {
    const f = fixture();
    f.workspace.skills.save({ ...skill, dotIds: [f.other.id] });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (request) =>
        String(request).startsWith('https://skills.invalid/')
          ? completion({ role: 'assistant', content: 'Hi.' })
          : new Response(null, { status: 204 }),
      );
    await run(f);
    const call = network.mock.calls.find((item) =>
      String(item[0]).startsWith('https://skills.invalid/'),
    )!;
    expect(
      body(call).tools?.map((tool) => tool.function.name) ?? [],
    ).not.toContain('load_skill');
  });
});

describe('Dots writing skills', () => {
  const toolCall = (name: string, args: unknown, id: string) =>
    completion(
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
  const runWith = async (
    f: ReturnType<typeof fixture>,
    replies: Response[],
  ) => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      if (!String(request).startsWith('https://skills.invalid/'))
        return new Response(null, { status: 204 });
      bodies.push(String(init?.body));
      // Real model calls take seconds: give the 100 ms run watcher time to
      // notice any permission change between calls.
      if (bodies.length > 1) await new Promise((r) => setTimeout(r, 300));
      return replies.shift()!;
    });
    const events = await lastValueFrom(
      new DotAgent(f.store, f.workspace, config, f.dot.id)
        .run({
          threadId: 'thread',
          runId: crypto.randomUUID(),
          state: {},
          context: [],
          messages: [
            { id: 'user', role: 'user', content: 'Create a Java skill' },
          ],
          tools: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    return { bodies, events };
  };

  it('creates a private skill without stopping its own run', async () => {
    const f = fixture();
    f.store.updateSettings({ memoryAllowed: false });
    const { bodies, events } = await runWith(f, [
      toolCall(
        'create_skill',
        {
          name: 'java-developer',
          description: 'Write idiomatic, tested Java code.',
          instructions: 'Use Java 21, JUnit 5, and records.',
          files: { 'checklist.md': '- tests pass' },
        },
        'create',
      ),
      completion({ role: 'assistant', content: 'Skill created.' }),
    ]);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(bodies[1]).toContain('only you');
    const [created] = f.workspace.skills.list();
    expect(created).toMatchObject({
      name: 'java-developer',
      author: f.dot.id,
      dotIds: [f.dot.id],
      enabled: true,
      files: { 'checklist.md': '- tests pass' },
    });
  });

  it('updates only skills the Dot wrote', async () => {
    const f = fixture();
    f.store.updateSettings({ memoryAllowed: false });
    f.workspace.skills.save(skill);
    f.workspace.skills.save(
      {
        name: 'mine',
        description: 'Old.',
        instructions: 'Old steps.',
        dotIds: [f.dot.id],
      },
      undefined,
      f.dot.id,
    );
    const { bodies } = await runWith(f, [
      toolCall(
        'update_skill',
        { name: 'weekly-report', instructions: 'Hijacked.' },
        'owner',
      ),
      toolCall(
        'update_skill',
        { name: 'mine', instructions: 'Better steps.' },
        'own',
      ),
      completion({ role: 'assistant', content: 'Done.' }),
    ]);
    expect(bodies[1]).toContain('was not created by you');
    const skills = f.workspace.skills.list();
    expect(skills.find((item) => item.name === 'weekly-report')).toMatchObject({
      instructions: skill.instructions,
      author: null,
    });
    expect(skills.find((item) => item.name === 'mine')).toMatchObject({
      instructions: 'Better steps.',
      description: 'Old.',
      author: f.dot.id,
    });
  });

  it('offers no authoring tools when the Dot may not write skills', async () => {
    const f = fixture();
    f.workspace.updateDot(f.dot.id, { ...f.dot, skillAuthoringAllowed: false });
    const { bodies } = await runWith(f, [
      completion({ role: 'assistant', content: 'Hi.' }),
    ]);
    expect(bodies[0]).not.toContain('create_skill');
  });
});
