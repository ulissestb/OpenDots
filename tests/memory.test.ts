import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import {
  MemoryExtractor,
  parseExtraction,
} from '../src/server/memory-extractor.js';
import { looksSecret } from '../src/server/memory-tools.js';
import { ProviderRegistry } from '../src/server/providers/registry.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((close) => close());
});

const config: PlatformConfig = {
  intelligenceKey: 'fixture',
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const dot = workspace.dots()[0];
  const other = workspace.createDot(
    dot.spaceId,
    'Other',
    'Another specialist.',
    false,
    true,
  );
  workspace.bindThread('thread', dot.id, 'Memory');
  const providers = ProviderRegistry.fromConfig(config);
  const extractor = new MemoryExtractor(store, workspace, providers);
  const agent = (withExtractor = false) =>
    new DotAgent(
      store,
      workspace,
      config,
      dot.id,
      false,
      providers,
      withExtractor ? extractor : undefined,
    );
  const input = (
    content = 'Hi there.',
    id = 'user-message',
  ): RunAgentInput => ({
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id, role: 'user', content }],
    tools: [],
    forwardedProps: {},
  });
  return { store, workspace, dot, other, agent, input, extractor };
}

function toolCall(name: string, args: Record<string, unknown>) {
  return completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}

const requestBody = (call: unknown[]) =>
  JSON.parse(String((call[1] as RequestInit | undefined)?.body));

describe('memory store', () => {
  it('migrates a legacy memories table without losing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-memory-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(
      'CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);',
    );
    legacy.prepare('INSERT INTO memories VALUES (?, ?, ?)').run('m1', 'Old', 5);
    legacy.close();
    const store = new Store(path);
    cleanup.push(() => store.close());
    expect(store.memories()).toEqual([
      {
        id: 'm1',
        text: 'Old',
        dotId: null,
        source: 'user',
        threadId: null,
        createdAt: 5,
        updatedAt: 5,
      },
    ]);
    expect(store.settings().autoMemory).toBe(true);
  });

  it('scopes memories to global plus the Dot, and caps the prompt budget', () => {
    const { store, dot, other } = fixture();
    store.saveMemory({ text: 'Global fact' });
    store.saveMemory({ text: 'Dot fact', dotId: dot.id });
    store.saveMemory({ text: 'Other fact', dotId: other.id });
    expect(
      store
        .memoriesFor(dot.id)
        .map((m) => m.text)
        .sort(),
    ).toEqual(['Dot fact', 'Global fact']);
    expect(store.memoriesFor(null).map((m) => m.text)).toEqual(['Global fact']);
    for (let i = 0; i < 30; i++)
      store.saveMemory({ text: `${i}`.padEnd(400, 'x') });
    const prompt = store.promptMemories(dot.id);
    expect(
      prompt.reduce((sum, m) => sum + m.text.length, 0),
    ).toBeLessThanOrEqual(8000);
    expect(prompt.length).toBeLessThan(store.memoriesFor(dot.id).length);
  });

  it('keeps scope and source when editing text', () => {
    const { store, dot } = fixture();
    const saved = store.saveMemory({
      text: 'Likes tea',
      dotId: dot.id,
      source: 'auto',
      threadId: 'thread',
    });
    const edited = store.saveMemory({ text: 'Likes green tea' }, saved.id);
    expect(edited).toMatchObject({
      text: 'Likes green tea',
      dotId: dot.id,
      source: 'auto',
      threadId: 'thread',
    });
  });

  it('rejects an unknown Dot scope through the API', async () => {
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const sample = {
      mode: 'sample' as const,
      baseUrl: 'https://api.openai.com/v1',
    };
    const runner = new Runner(store, sample);
    const app = createApp({
      store,
      runner,
      config: sample,
      auth: false,
    });
    const response = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Scoped', dotId: 'missing' }),
    });
    expect(response.status).toBe(400);
    expect(store.memories()).toHaveLength(0);
    const patched = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoMemory: false }),
    });
    expect(patched.status).toBe(200);
    expect(store.settings().autoMemory).toBe(false);
  });

  it('flags obvious secrets', () => {
    expect(looksSecret('password: hunter2')).toBe(true);
    expect(looksSecret('Key is sk-abcdefghijklmnopqrstuv')).toBe(true);
    expect(looksSecret('Card 4111 1111 1111 1111')).toBe(true);
    expect(looksSecret('Prefers short answers in Portuguese')).toBe(false);
  });
  it('refuses Luhn-valid card numbers but keeps phone numbers', () => {
    expect(looksSecret('My phone is 5511987654321')).toBe(false);
    expect(looksSecret('Call +55 11 98765-4321 after 6pm')).toBe(false);
    expect(looksSecret('Order 1234 5678 9012 3456 arrived')).toBe(false);
    expect(looksSecret('Visa 4111-1111-1111-1111')).toBe(true);
    expect(looksSecret('Amex 378282246310005')).toBe(true);
  });
});

describe('memory in DotAgent', () => {
  it('shows visible memories and offers memory tools', async () => {
    const f = fixture();
    f.store.saveMemory({ text: 'Owner is called Ana' });
    f.store.saveMemory({ text: 'Other secret plan', dotId: f.other.id });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Hi Ana.' }),
      );
    await lastValueFrom(f.agent().run(f.input()).pipe(toArray()));
    const request = requestBody(network.mock.calls[0]);
    const text = JSON.stringify(request);
    expect(text).toContain('Owner is called Ana');
    expect(text).not.toContain('Other secret plan');
    expect(
      request.tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual(
      expect.arrayContaining(['save_memory', 'update_memory', 'forget_memory']),
    );
  });

  it('hides memories and tools when the Dot may not use memory', async () => {
    const f = fixture();
    f.store.saveMemory({ text: 'Owner is called Ana' });
    f.workspace.updateDot(f.dot.id, { ...f.dot, memoryAllowed: false });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Hello.' }),
      );
    await lastValueFrom(f.agent().run(f.input()).pipe(toArray()));
    const text = JSON.stringify(requestBody(network.mock.calls[0]));
    expect(text).not.toContain('Owner is called Ana');
    expect(text).not.toContain('save_memory');
  });

  it('saves a memory through the tool, attributed to the agent', async () => {
    const f = fixture();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        toolCall('save_memory', {
          text: 'Prefers short answers',
          scope: 'dot',
        }),
      )
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Noted.' }),
      );
    const events = await lastValueFrom(
      f
        .agent()
        .run(f.input('Remember I prefer short answers.'))
        .pipe(toArray()),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'call-save_memory',
        }),
      ]),
    );
    expect(f.store.memories()).toEqual([
      expect.objectContaining({
        text: 'Prefers short answers',
        dotId: f.dot.id,
        source: 'agent',
        threadId: 'thread',
      }),
    ]);
  });

  it("cannot forget another Dot's memory", async () => {
    const f = fixture();
    const hidden = f.store.saveMemory({ text: 'Hidden', dotId: f.other.id });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolCall('forget_memory', { id: hidden.id }))
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Done.' }),
      );
    await lastValueFrom(f.agent().run(f.input('Forget it.')).pipe(toArray()));
    expect(f.store.memory(hidden.id)).toBeDefined();
  });

  it('extracts memories after an owner turn but not after internal turns', async () => {
    const f = fixture();
    const extract = vi.spyOn(f.extractor, 'extract').mockResolvedValue(0);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      completion({ role: 'assistant', content: 'Nice to meet you.' }),
    );
    await lastValueFrom(
      f.agent(true).run(f.input('I live in Recife.')).pipe(toArray()),
    );
    expect(extract).toHaveBeenCalledWith({
      dotId: f.dot.id,
      threadId: 'thread',
      user: 'I live in Recife.',
      reply: 'Nice to meet you.',
    });
    extract.mockClear();
    await lastValueFrom(
      f
        .agent(true)
        .run(f.input('Scheduled check', 'opendots:scheduled:1'))
        .pipe(toArray()),
    );
    expect(extract).not.toHaveBeenCalled();
  });
});

describe('memory extractor', () => {
  const turn = (dotId: string) => ({
    dotId,
    threadId: 'thread',
    user: 'I am a nurse and my password: hunter2',
    reply: 'Thanks for sharing.',
  });

  it('saves durable facts, skipping duplicates and secrets', async () => {
    const f = fixture();
    const existing = f.store.saveMemory({ text: 'Likes coffee' });
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      completion({
        role: 'assistant',
        content: `Here you go: ${JSON.stringify({
          add: [
            { text: 'Works as a nurse', scope: 'global' },
            { text: 'likes coffee', scope: 'global' },
            { text: 'Password: hunter2', scope: 'global' },
          ],
          update: [{ id: existing.id, text: 'Likes strong coffee' }],
        })}`,
      }),
    );
    expect(await f.extractor.extract(turn(f.dot.id))).toBe(2);
    expect(
      f.store
        .memories()
        .map((m) => [m.text, m.source])
        .sort(),
    ).toEqual([
      ['Likes strong coffee', 'user'],
      ['Works as a nurse', 'auto'],
    ]);
    const request = requestBody(network.mock.calls[0]);
    expect(request.tools ?? []).toHaveLength(0);
  });

  it('ignores invalid output', async () => {
    const f = fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'not json at all' }),
    );
    expect(await f.extractor.extract(turn(f.dot.id))).toBe(0);
    expect(f.store.memories()).toHaveLength(0);
    expect(parseExtraction('{"add": "nope"}')).toBeUndefined();
  });

  it('runs a follow-up turn after the one in flight instead of dropping it', async () => {
    const f = fixture();
    const reply = (text: string) =>
      completion({
        role: 'assistant',
        content: JSON.stringify({
          add: [{ text, scope: 'global' }],
          update: [],
        }),
      });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply('Lives in Lisbon'))
      .mockResolvedValueOnce(reply('Prefers short answers'));
    const first = f.extractor.extract(turn(f.dot.id));
    expect(await f.extractor.extract(turn(f.dot.id))).toBe(0);
    await first;
    await vi.waitFor(() => expect(f.store.memories()).toHaveLength(2));
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('does not call the model when automatic memory is off', async () => {
    const f = fixture();
    f.store.updateSettings({ autoMemory: false });
    const network = vi.spyOn(globalThis, 'fetch');
    expect(await f.extractor.extract(turn(f.dot.id))).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('memory in shared Slack channels', () => {
  it('offers no memory tools when several Slack users act as the owner', async () => {
    const f = fixture();
    const shared = new DotAgent(
      f.store,
      f.workspace,
      { ...config, slackUsers: ['U1', 'U2'] },
      f.dot.id,
      true,
      ProviderRegistry.fromConfig(config),
      f.extractor,
    );
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(completion({ role: 'assistant', content: 'Noted.' }));
    await lastValueFrom(
      shared.run(f.input('I live in Berlin.')).pipe(toArray()),
    );
    const body = requestBody(network.mock.calls[0]);
    const names = (body.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    expect(names).not.toContain('save_memory');
    // No extraction call follows the reply.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(network).toHaveBeenCalledTimes(1);
  });
});
