import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastValueFrom, toArray } from 'rxjs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import {
  type McpConnect,
  McpService,
  mcpResultText,
  mcpToolName,
} from '../src/server/mcp.js';
import { McpStore } from '../src/server/mcp-store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
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
  baseUrl: 'https://mcp-model.invalid/v1',
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

/** An in-process MCP server; `extra` simulates a tool added after review. */
function fakeServer(options: { extra?: boolean; fail?: boolean } = {}) {
  const calls: unknown[] = [];
  const connect: McpConnect = () => {
    if (options.fail) throw new Error('connect ECONNREFUSED');
    const [client, server] = InMemoryTransport.createLinkedPair();
    const mcp = new McpServer({ name: 'fake', version: '1.0.0' });
    mcp.registerTool(
      'get.weather',
      {
        description: 'Weather for a city.',
        inputSchema: { city: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ city }) => {
        calls.push(city);
        return { content: [{ type: 'text', text: `Sunny in ${city}` }] };
      },
    );
    mcp.registerTool(
      'delete_everything',
      {
        description: 'Deletes data.',
        annotations: { destructiveHint: true },
      },
      async () => ({
        content: [{ type: 'text', text: 'Refused by test.' }],
        isError: true,
      }),
    );
    if (options.extra)
      mcp.registerTool(
        'new_tool',
        { description: 'Added later.' },
        async () => ({ content: [{ type: 'text', text: 'surprise' }] }),
      );
    void mcp.connect(server);
    return client;
  };
  return { connect, calls };
}
function fixture(connect: McpConnect, secret?: string, path = ':memory:') {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const mcpStore = new McpStore(path, secret);
  cleanup.push(() => {
    store.close();
    workspace.close();
    mcpStore.close();
  });
  const mcp = new McpService(mcpStore, connect);
  const platform = new Platform(
    store,
    workspace,
    config,
    undefined,
    undefined,
    mcp,
  );
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
    config: { mode: 'live', baseUrl: config.baseUrl },
    platform,
    auth: false,
  });
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'MCP');
  return { store, workspace, mcp, mcpStore, app, dot };
}
const server = {
  name: 'weather',
  url: 'https://mcp.example.com/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer secret-123' }],
};

describe('MCP helpers', () => {
  it('builds API-safe, unique tool names', () => {
    const taken = new Set<string>();
    expect(mcpToolName('weather', 'get.weather', taken)).toBe(
      'mcp_weather_get_weather',
    );
    expect(mcpToolName('weather', 'get:weather', taken)).toBe(
      'mcp_weather_get_weather_2',
    );
    expect(mcpToolName('x', 'a'.repeat(100), taken)).toHaveLength(64);
  });
  it('turns results into bounded text', () => {
    expect(
      mcpResultText({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      }),
    ).toBe('hello\n[image content omitted]');
    expect(mcpResultText({ structuredContent: { ok: true } })).toBe(
      '{"ok":true}',
    );
    expect(
      mcpResultText({ content: [{ type: 'text', text: 'x'.repeat(50_000) }] }),
    ).toContain('truncated 10000 characters');
  });
});

describe('MCP servers API', () => {
  it('never returns header values and keeps them when left blank', async () => {
    const f = fixture(fakeServer().connect);
    const created = await f.app.request(
      '/api/mcp/servers',
      send('POST', server),
    );
    expect(created.status).toBe(201);
    const saved = (await created.json()) as { id: string };
    const listed = await (await f.app.request('/api/mcp/servers')).text();
    expect(listed).toContain('"headerNames":["Authorization"]');
    expect(listed).not.toContain('secret-123');
    await f.app.request(
      `/api/mcp/servers/${saved.id}`,
      send('PUT', { ...server, headers: [{ name: 'Authorization' }] }),
    );
    expect(f.mcpStore.get(saved.id)?.headers).toEqual({
      Authorization: 'Bearer secret-123',
    });
    expect(
      (
        await f.app.request(
          '/api/mcp/servers',
          send('POST', { ...server, name: 'other', url: 'file:///etc' }),
        )
      ).status,
    ).toBe(400);
  });

  it('encrypts header values at rest when CREDENTIALS_SECRET is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-mcp-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite');
    const f = fixture(fakeServer().connect, 'a-long-credentials-secret', path);
    f.mcpStore.save(server);
    const raw = new DatabaseSync(path);
    const row = raw.prepare('SELECT headers FROM mcp_servers').get();
    raw.close();
    expect(String(row?.headers)).not.toContain('secret-123');
    expect(f.mcpStore.list()[0].headers.Authorization).toBe(
      'Bearer secret-123',
    );
  });

  it('tests a server, stores its tools for review, and records failures', async () => {
    const f = fixture(fakeServer().connect);
    const { id } = f.mcpStore.save(server);
    const tested = await f.app.request(
      `/api/mcp/servers/${id}/test`,
      send('POST', {}),
    );
    expect(await tested.json()).toMatchObject({
      lastError: null,
      tools: [
        { name: 'get.weather', readOnly: true },
        { name: 'delete_everything', destructive: true },
      ],
    });
    const broken = fixture(fakeServer({ fail: true }).connect);
    const other = broken.mcpStore.save(server);
    const failed = await broken.mcp.test(other.id);
    expect(failed.lastError).toContain('ECONNREFUSED');
    expect(failed.tools).toEqual([]);
  });
});

describe('MCP tool review', () => {
  it('does not widen access when a new address clears the reviewed tools', async () => {
    const f = fixture(fakeServer({ extra: true }).connect);
    const { id } = f.mcpStore.save(server);
    f.mcpStore.recordTest(id, {
      tools: [{ name: 'get.weather', description: '' }],
    });
    const moved = f.mcpStore.save(
      {
        ...server,
        url: 'https://mcp.example.net/mcp',
        headers: [{ name: 'Authorization' }],
      },
      id,
    );
    expect(moved.tools).toEqual([]);
    expect(moved.allowedTools).toEqual(['get.weather']);
    await f.mcp.test(id);
    const session = await f.mcp.toolsFor(
      f.dot.id,
      new AbortController().signal,
      () => undefined,
    );
    cleanup.push(() => void session.close());
    // The re-test lists new_tool and delete_everything, but only the
    // previously approved tool reaches the Dot.
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'mcp_weather_get_weather',
    ]);
  });
});

describe('MCP tools in a run', () => {
  it('exposes only reviewed, allowed tools of assigned servers', async () => {
    const fake = fakeServer({ extra: true });
    const f = fixture(fake.connect);
    const { id } = f.mcpStore.save(server);
    // Review happened before new_tool existed.
    f.mcpStore.recordTest(id, {
      tools: [
        { name: 'get.weather', description: '' },
        { name: 'delete_everything', description: '' },
      ],
    });
    const session = await f.mcp.toolsFor(
      f.dot.id,
      new AbortController().signal,
      () => undefined,
    );
    cleanup.push(() => void session.close());
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'mcp_weather_get_weather',
      'mcp_weather_delete_everything',
    ]);
    f.mcpStore.save(
      {
        ...server,
        headers: [{ name: 'Authorization' }],
        allowedTools: ['get.weather'],
      },
      id,
    );
    const narrowed = await f.mcp.toolsFor(
      f.dot.id,
      new AbortController().signal,
      () => undefined,
    );
    cleanup.push(() => void narrowed.close());
    expect(narrowed.tools.map((tool) => tool.name)).toEqual([
      'mcp_weather_get_weather',
    ]);
    const other = f.workspace.createDot(
      f.dot.spaceId,
      'Other',
      'Other Dot.',
      true,
      true,
    );
    f.mcpStore.save(
      {
        ...server,
        headers: [{ name: 'Authorization' }],
        dotIds: [other.id],
      },
      id,
    );
    const none = await f.mcp.toolsFor(
      f.dot.id,
      new AbortController().signal,
      () => undefined,
    );
    expect(none.tools).toEqual([]);
  });

  it('reports untested and unreachable servers instead of failing the run', async () => {
    const f = fixture(fakeServer({ fail: true }).connect);
    f.mcpStore.save(server);
    const untested = await f.mcp.toolsFor(
      f.dot.id,
      new AbortController().signal,
      () => undefined,
    );
    expect(untested.unavailable).toEqual(['weather (not tested yet)']);
    const { id } = f.mcpStore.list()[0];
    f.mcpStore.recordTest(id, {
      tools: [{ name: 'get.weather', description: '' }],
    });
    const down = await f.mcp.toolsFor(
      f.dot.id,
      new AbortController().signal,
      () => undefined,
    );
    expect(down.tools).toEqual([]);
    expect(down.unavailable[0]).toContain('ECONNREFUSED');
  });

  it('lets the model call an MCP tool and see its result and errors', async () => {
    const fake = fakeServer();
    const f = fixture(fake.connect);
    const { id } = f.mcpStore.save(server);
    await f.mcp.test(id);
    const call = (name: string, args: unknown, callId: string) =>
      completion(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        'tool_calls',
      );
    const replies = [
      call('mcp_weather_get_weather', { city: 'Recife' }, 'w'),
      call('mcp_weather_delete_everything', {}, 'd'),
      completion({ role: 'assistant', content: 'It is sunny.' }),
    ];
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      if (!String(request).startsWith('https://mcp-model.invalid/'))
        return new Response(null, { status: 204 });
      bodies.push(String(init?.body));
      return replies.shift()!;
    });
    const agent = new DotAgent(
      f.store,
      f.workspace,
      config,
      f.dot.id,
      false,
      undefined,
      undefined,
      undefined,
      f.mcp,
    );
    await lastValueFrom(
      agent
        .run({
          threadId: 'thread',
          runId: 'run',
          state: {},
          context: [],
          messages: [{ id: 'user', role: 'user', content: 'Weather?' }],
          tools: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    expect(fake.calls).toEqual(['Recife']);
    const first = JSON.parse(bodies[0]) as {
      tools: { function: { name: string; parameters: unknown } }[];
    };
    expect(
      first.tools.find(
        (tool) => tool.function.name === 'mcp_weather_get_weather',
      )?.function.parameters,
    ).toMatchObject({ properties: { city: { type: 'string' } } });
    expect(bodies[0]).toContain('untrusted data');
    expect(bodies[1]).toContain('Sunny in Recife');
    expect(bodies[2]).toContain('Refused by test.');
  });
});
