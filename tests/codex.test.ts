import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { ProviderCredentialStore } from '../src/server/providers/credential-store.js';
import {
  completedOutput,
  normalizeCodexBody,
} from '../src/server/providers/openai-codex.js';
import { ProviderRegistry } from '../src/server/providers/registry.js';
import { chatgptJwt, responsesText } from './fixtures/responses-stream.js';

const closers: { close(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closers.splice(0).forEach((item) => item.close());
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function credentials(secret?: string) {
  const store = new ProviderCredentialStore(':memory:', secret);
  closers.push(store);
  return store;
}
function connected(store: ProviderCredentialStore, expiresAt: number) {
  store.save('openai-codex', {
    tokens: { access_token: 'old-access', refresh_token: 'old-refresh' },
    accountId: 'account-1',
    email: null,
    plan: null,
    expiresAt,
  });
}
const body = (call: unknown[]) =>
  String((call[1] as RequestInit | undefined)?.body ?? '');

describe('credential store', () => {
  it('encrypts tokens when a secret is set and fails closed on a wrong one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-credentials-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite');
    const store = new ProviderCredentialStore(path, 'right-secret');
    connected(store, Date.now() + 3_600_000);
    expect(store.get('openai-codex')?.tokens?.access_token).toBe('old-access');
    store.close();
    const wrong = new ProviderCredentialStore(path, 'wrong-secret');
    closers.push(wrong);
    expect(wrong.get('openai-codex')).toMatchObject({
      tokens: null,
      state: 'needs_reauth',
    });
  });
});

describe('ChatGPT device sign-in', () => {
  it('polls until approved, exchanges the code and stores the account', async () => {
    vi.useFakeTimers();
    const store = credentials();
    const auth = new CodexAuth(store);
    const idToken = chatgptJwt({ email: 'me@example.com' });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json({
          device_auth_id: 'device-1',
          user_code: 'ABCD-1234',
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(
        json({ authorization_code: 'code-1', code_verifier: 'verifier-1' }),
      )
      .mockResolvedValueOnce(
        json({
          access_token: chatgptJwt(),
          refresh_token: 'refresh-1',
          id_token: idToken,
        }),
      );
    const flow = await auth.startDeviceFlow();
    expect(flow).toMatchObject({ userCode: 'ABCD-1234', interval: 1 });
    expect(flow).not.toHaveProperty('deviceAuthId');
    expect(auth.flowStatus(flow.flowId).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1000);
    expect(auth.flowStatus(flow.flowId).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1000);
    expect(auth.flowStatus(flow.flowId).status).toBe('complete');
    const exchange = network.mock.calls[3];
    expect(String(exchange[0])).toBe('https://auth.openai.com/oauth/token');
    const params = new URLSearchParams(body(exchange));
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code_verifier')).toBe('verifier-1');
    expect(params.get('redirect_uri')).toBe(
      'https://auth.openai.com/deviceauth/callback',
    );
    expect(store.get('openai-codex')).toMatchObject({
      accountId: 'account-1',
      plan: 'plus',
      email: 'me@example.com',
      state: 'connected',
    });
  });
  it('refreshes once for concurrent callers and persists the rotated token', async () => {
    const store = credentials();
    connected(store, Date.now() + 30_000);
    const auth = new CodexAuth(store);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        json({ access_token: 'new-access', refresh_token: 'new-refresh' }),
      );
    const results = await Promise.all([
      auth.accessToken(),
      auth.accessToken(),
      auth.accessToken(),
    ]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(
      new URLSearchParams(body(network.mock.calls[0])).get('refresh_token'),
    ).toBe('old-refresh');
    expect(results.map((result) => result.token)).toEqual([
      'new-access',
      'new-access',
      'new-access',
    ]);
    expect(store.get('openai-codex')?.tokens?.refresh_token).toBe(
      'new-refresh',
    );
  });
  it('asks for a new sign-in when the refresh token is rejected', async () => {
    const store = credentials();
    connected(store, Date.now() - 1);
    const auth = new CodexAuth(store);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ error: 'invalid_grant' }, 400),
    );
    await expect(auth.accessToken()).rejects.toThrow(/Reconnect/);
    expect(store.get('openai-codex')?.state).toBe('needs_reauth');
  });
});

describe('Codex request normalization', () => {
  it('keeps only accepted fields and strips server-side item ids', () => {
    const result = normalizeCodexBody(
      {
        model: 'gpt-5.5',
        instructions: '',
        max_output_tokens: 100,
        temperature: 0.2,
        metadata: { a: 1 },
        input: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'reasoning', id: 'rs_2', encrypted_content: 'sealed' },
          { type: 'function_call', id: 'fc_1', call_id: 'call', name: 'x' },
        ],
      },
      'thread',
    );
    expect(result).toEqual({
      model: 'gpt-5.5',
      instructions: 'You are a helpful assistant.',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'thread',
      input: [
        { type: 'reasoning', encrypted_content: 'sealed' },
        { type: 'function_call', call_id: 'call', name: 'x' },
      ],
    });
  });
});

describe('Dot runs on the ChatGPT subscription', () => {
  function fixture(tuning: { reasoningEffort?: 'low' | 'high' } = {}) {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const creds = credentials();
    closers.push(store, workspace);
    connected(creds, Date.now() + 3_600_000);
    const config = {
      intelligenceKey: 'fixture',
      baseUrl: 'https://unused.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      ...tuning,
    };
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, { ...dot, provider: 'openai-codex' });
    workspace.bindThread('thread', dot.id, 'Codex');
    const agent = new DotAgent(
      store,
      workspace,
      config,
      dot.id,
      false,
      ProviderRegistry.fromConfig(config, new CodexAuth(creds)),
    );
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      state: {},
      context: [],
      messages: [{ id: 'user', role: 'user', content: 'Hello' }],
      tools: [],
      forwardedProps: {},
    };
    return { agent, input, creds };
  }
  it('calls the Codex backend with the subscription token and retries once on 401', async () => {
    const { agent, input } = fixture();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'expired' }, 401))
      .mockResolvedValueOnce(
        json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh' }),
      )
      .mockResolvedValueOnce(responsesText('Hi from ChatGPT.'));
    const events = await lastValueFrom(agent.run(input).pipe(toArray()));
    const [first, refresh, retry] = network.mock.calls;
    expect(String(first[0])).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
    const headers = new Headers((first[1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer old-access');
    expect(headers.get('chatgpt-account-id')).toBe('account-1');
    expect(headers.get('originator')).toBe('opendots');
    expect(String(refresh[0])).toBe('https://auth.openai.com/oauth/token');
    expect(
      new Headers((retry[1] as RequestInit).headers).get('authorization'),
    ).toBe('Bearer fresh-access');
    const sent = JSON.parse(body(retry));
    expect(sent).toMatchObject({
      model: 'gpt-5.5',
      store: false,
      stream: true,
    });
    expect(sent.instructions).toContain('You are Dot');
    expect(sent).not.toHaveProperty('max_output_tokens');
    expect(
      events.some(
        (event) =>
          (event.type === EventType.TEXT_MESSAGE_CHUNK ||
            event.type === EventType.TEXT_MESSAGE_CONTENT) &&
          'delta' in event &&
          String(event.delta).includes('Hi from ChatGPT.'),
      ),
    ).toBe(true);
  });
  it('fails with a clear error when ChatGPT is not connected', async () => {
    const { agent, input, creds } = fixture();
    creds.delete('openai-codex');
    const network = vi.spyOn(globalThis, 'fetch');
    const events = await lastValueFrom(agent.run(input).pipe(toArray())).catch(
      (error: Error) => [{ type: 'thrown', message: error.message }],
    );
    expect(JSON.stringify(events)).toMatch(/ChatGPT sign-in/);
    expect(network).not.toHaveBeenCalled();
  });
  const run = (agent: DotAgent, input: RunAgentInput) =>
    lastValueFrom(agent.run(input).pipe(toArray())).catch((error: Error) => [
      { type: 'thrown', message: error.message },
    ]);
  const errorMessage = (events: unknown[]) =>
    (
      events.find(
        (event) =>
          (event as { type: string }).type === EventType.RUN_ERROR ||
          (event as { type: string }).type === 'thrown',
      ) as { message?: string } | undefined
    )?.message;
  it('shows the usage limit once instead of retrying into a connection error', async () => {
    const { agent, input } = fixture();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { type: 'usage_limit_reached' } }),
          { status: 429, headers: { 'retry-after': '120' } },
        ),
      );
    const message = errorMessage(await run(agent, input));
    expect(network).toHaveBeenCalledTimes(1);
    expect(message).toBe('ChatGPT usage limit reached; retry after 2 minutes.');
  });
  it('asks to reconnect when the token is rejected mid-run', async () => {
    const { agent, input, creds } = fixture();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'expired' }, 401))
      .mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    const message = errorMessage(await run(agent, input));
    expect(network).toHaveBeenCalledTimes(2);
    expect(message).toBe('ChatGPT sign-in expired. Reconnect it in Settings.');
    expect(message).not.toMatch(/Connection error/);
    expect(creds.get('openai-codex')?.state).toBe('needs_reauth');
  });
  it('sends the configured reasoning effort in the Codex body', async () => {
    const { agent, input } = fixture({ reasoningEffort: 'high' });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responsesText('Thought it through.'));
    await run(agent, input);
    const sent = JSON.parse(body(network.mock.calls[0]));
    expect(sent.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(sent).not.toHaveProperty('max_output_tokens');
    expect(sent).not.toHaveProperty('reasoning_effort');
  });
  it('leaves reasoning to the model default when unset', async () => {
    const { agent, input } = fixture();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responsesText('Default.'));
    await run(agent, input);
    expect(JSON.parse(body(network.mock.calls[0]))).not.toHaveProperty(
      'reasoning',
    );
  });
});

describe('ChatGPT token refresh timeout', () => {
  it('times out a hung refresh and lets the next call try again', async () => {
    const store = credentials();
    connected(store, Date.now() - 1);
    const auth = new CodexAuth(store, Date.now, 20);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            ),
          ),
      );
    await expect(auth.accessToken()).rejects.toThrow(
      'ChatGPT token refresh timed out',
    );
    expect(store.get('openai-codex')?.state).toBe('connected');
    network.mockResolvedValueOnce(
      json({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    );
    await expect(auth.accessToken()).resolves.toMatchObject({
      token: 'new-access',
    });
    expect(network).toHaveBeenCalledTimes(2);
  });
});

describe('Codex audit regressions', () => {
  it('keeps a sign-in that lands while a dead refresh is in flight', async () => {
    const store = credentials();
    connected(store, Date.now() - 1);
    const auth = new CodexAuth(store);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.save('openai-codex', {
        tokens: { access_token: 'fresh', refresh_token: 'fresh-refresh' },
        accountId: 'account-1',
        email: null,
        plan: null,
        expiresAt: Date.now() + 3_600_000,
      });
      return json({ error: 'invalid_grant' }, 400);
    });
    await expect(auth.accessToken()).rejects.toThrow();
    expect(store.get('openai-codex')?.state).toBe('connected');
  });

  it('splits SSE events whose CRLF straddles two chunks', async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"type":"a"}\r\n\r', '\ndata: {"type":"b"}\r\n\r\n'];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const text = await new Response(
      source.pipeThrough(completedOutput()),
    ).text();
    expect(text).toBe('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
  });
});
