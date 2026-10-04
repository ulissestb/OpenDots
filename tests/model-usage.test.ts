import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { ProviderCredentialStore } from '../src/server/providers/credential-store.js';
import {
  knownModel,
  parseModelList,
} from '../src/server/providers/model-catalog.js';
import { OpenAICodexProvider } from '../src/server/providers/openai-codex.js';
import { OpenAICompatibleProvider } from '../src/server/providers/openai-compatible.js';
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
  apiKey: 'fixture-key',
  model: 'gpt-5.5',
  baseUrl: 'https://models.invalid/v1',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: '',
  webSearchProvider: 'disabled' as const,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('model lists', () => {
  it('parses OpenAI, OpenRouter, vLLM, and Codex shapes', () => {
    expect(
      parseModelList({
        data: [
          { id: 'gpt-5.5' },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
          { id: 'mystery-model' },
        ],
      }),
    ).toEqual([
      { id: 'gpt-5.5', contextWindow: 1_050_000, maxOutputTokens: 128_000 },
      { id: 'mystery-model' },
    ]);
    expect(
      parseModelList({
        data: [
          {
            id: 'anthropic/claude-x',
            name: 'Claude X',
            context_length: 200_000,
            top_provider: { max_completion_tokens: 64_000 },
          },
        ],
      }),
    ).toEqual([
      {
        id: 'anthropic/claude-x',
        label: 'Claude X',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    ]);
    expect(
      parseModelList({ data: [{ id: 'qwen', max_model_len: 32_768 }] }),
    ).toEqual([{ id: 'qwen', contextWindow: 32_768 }]);
    expect(
      parseModelList({
        models: [
          { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', context_window: 999 },
          { slug: 'internal', visibility: 'hide' },
        ],
      }),
    ).toEqual([
      {
        id: 'gpt-6-sol',
        label: 'GPT-6 Sol',
        contextWindow: 999,
        maxOutputTokens: 128_000,
      },
    ]);
    expect(knownModel('openai/gpt-4o').contextWindow).toBe(128_000);
  });

  it('lists the compatible provider live with its key and caches it', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ data: [{ id: 'gpt-5.5' }, { id: 'o3' }] }));
    const provider = new OpenAICompatibleProvider(config);
    const listed = await provider.models();
    expect(listed).toMatchObject({
      provider: 'openai-compatible',
      source: 'provider',
      models: [{ id: 'gpt-5.5' }, { id: 'o3', contextWindow: 200_000 }],
    });
    expect(String(network.mock.calls[0][0])).toBe(
      'https://models.invalid/v1/models',
    );
    expect(
      new Headers(network.mock.calls[0][1]?.headers).get('authorization'),
    ).toBe('Bearer fixture-key');
    await provider.models();
    expect(network).toHaveBeenCalledTimes(1);
    expect(provider.contextWindow('o3')).toBe(200_000);
  });

  it('falls back to the configured model when listing fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ error: 'nope' }, 403),
    );
    const listed = await new OpenAICompatibleProvider(config).models();
    expect(listed).toEqual({
      provider: 'openai-compatible',
      source: 'fallback',
      error: 'The provider model list returned HTTP 403.',
      models: [
        { id: 'gpt-5.5', contextWindow: 1_050_000, maxOutputTokens: 128_000 },
      ],
    });
  });

  it('lists ChatGPT models through the signed-in Codex fetch, else falls back', async () => {
    const credentials = new ProviderCredentialStore(':memory:');
    cleanup.push(() => credentials.close());
    const auth = new CodexAuth(credentials);
    vi.spyOn(auth, 'credential').mockReturnValue({
      state: 'connected',
    } as ReturnType<CodexAuth['credential']>);
    vi.spyOn(auth, 'accessToken').mockResolvedValue({
      token: 'chatgpt-token',
      accountId: 'account',
    });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json({ models: [{ slug: 'gpt-6-sol', context_window: 1_050_000 }] }),
      );
    const provider = new OpenAICodexProvider(auth);
    expect(await provider.models()).toMatchObject({
      source: 'provider',
      models: [{ id: 'gpt-6-sol', contextWindow: 1_050_000 }],
    });
    const [url, init] = network.mock.calls[0];
    expect(String(url)).toContain('chatgpt.com/backend-api/codex/models');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer chatgpt-token');
    expect(headers.get('chatgpt-account-id')).toBe('account');
    network.mockResolvedValueOnce(json({ detail: 'Not Found' }, 404));
    const fallback = await new OpenAICodexProvider(auth).models();
    expect(fallback.source).toBe('fallback');
    expect(fallback.models.map((model) => model.id)).toContain('gpt-5.5');
  });
});

describe('conversation usage', () => {
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
    workspace.bindThread('thread', dot.id, 'Usage');
    const agent = new DotAgent(store, workspace, config, dot.id);
    const run = () =>
      lastValueFrom(
        agent
          .run({
            threadId: 'thread',
            runId: crypto.randomUUID(),
            state: {},
            context: [],
            messages: [{ id: 'user', role: 'user', content: 'Hi' }],
            tools: [],
            forwardedProps: {},
          })
          .pipe(toArray()),
      );
    return { app, workspace, run };
  }

  it('reports the model before the first turn', async () => {
    const f = fixture();
    const response = await f.app.request('/api/conversations/thread/usage');
    expect(await response.json()).toMatchObject({
      provider: 'openai-compatible',
      model: 'gpt-5.5',
      contextWindow: 1_050_000,
      contextTokens: 0,
      calls: 0,
    });
  });

  it('counts each model call and keeps the latest call as context use', async () => {
    const f = fixture();
    const replies = [
      completion(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'spaces',
              type: 'function',
              function: { name: 'list_authorized_spaces', arguments: '{}' },
            },
          ],
        },
        'tool_calls',
        {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      ),
      completion({ role: 'assistant', content: 'Done.' }, 'stop', {
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        completion_tokens_details: { reasoning_tokens: 30 },
      }),
    ];
    // SDK telemetry also uses fetch, so answer by URL.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) =>
      String(request).startsWith('https://models.invalid/')
        ? replies.shift()!
        : new Response(null, { status: 204 }),
    );
    await f.run();
    const response = await f.app.request('/api/conversations/thread/usage');
    expect(await response.json()).toMatchObject({
      model: 'gpt-5.5',
      contextTokens: 1280,
      inputTokens: 2200,
      outputTokens: 130,
      reasoningTokens: 30,
      cachedInputTokens: 400,
      calls: 2,
    });
  });

  it('does not reveal other conversations', async () => {
    const f = fixture();
    const response = await f.app.request('/api/conversations/foreign/usage');
    expect(response.status).toBe(404);
  });

  it('serves a provider model list and rejects unknown providers', async () => {
    const f = fixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) =>
      String(request).startsWith('https://models.invalid/')
        ? json({ data: [{ id: 'gpt-5.5' }] })
        : new Response(null, { status: 204 }),
    );
    const listed = await f.app.request(
      '/api/providers/openai-compatible/models',
    );
    expect(await listed.json()).toMatchObject({
      source: 'provider',
      models: [{ id: 'gpt-5.5' }],
    });
    expect((await f.app.request('/api/providers/nope/models')).status).toBe(
      404,
    );
  });
});
