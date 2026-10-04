import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { VoiceService } from '../src/server/voice.js';
import { callIdFromLocation } from '../src/server/voice-backends.js';
import type { CodexAuth } from '../src/server/providers/codex-auth.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111';
const answer = (location: string) =>
  new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
    headers: { location },
  });

function fixture(options: { key?: boolean; codex?: boolean } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.bindThread('thread', workspace.dots()[0].id, 'A conversation');
  resources.push(() => {
    store.close();
    workspace.close();
  });
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    ...(options.key ? { voiceKey: 'api-key', voiceModel: 'voice-model' } : {}),
    voiceName: 'marin',
    runtimeUrl: '',
    slackUsers: [],
  };
  const accessToken = vi.fn(async ({ force }: { force?: boolean } = {}) => ({
    token: force ? 'fresh-token' : 'chatgpt-token',
    accountId: 'account-1',
  }));
  const codex = {
    credential: () => ({ state: 'connected' }),
    accessToken,
  } as unknown as CodexAuth;
  const transport = vi.fn<typeof fetch>();
  const voice = new VoiceService(
    {
      workspace,
      store,
      config,
      turn: vi.fn(async () => 'ok'),
      history: vi.fn(async () => ''),
      requireReady() {},
      setup: () => ({
        voice: true,
        intelligence: false,
        model: true,
        browser: false,
        slack: 'not_configured',
        missing: [],
      }),
    },
    transport,
    options.codex === false ? undefined : codex,
  );
  return { voice, transport, accessToken, workspace };
}
const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

it('reads provider call ids from every known Location shape', () => {
  expect(callIdFromLocation('/v1/realtime/calls/rtc_test')).toBe('rtc_test');
  expect(callIdFromLocation('/v1/realtime/calls/calls/rtc_backend')).toBe(
    'rtc_backend',
  );
  expect(
    callIdFromLocation(
      '/v1/realtime/calls/019eb97d-8e9a-7ff3-94b0-ea019babd5d7',
    ),
  ).toBe('019eb97d-8e9a-7ff3-94b0-ea019babd5d7');
  expect(callIdFromLocation('/v1/realtime/calls')).toBeUndefined();
  expect(callIdFromLocation(null)).toBeUndefined();
});

it('starts a ChatGPT-subscription call with the frameless protocol', async () => {
  const f = fixture();
  f.transport
    .mockResolvedValueOnce(answer('/v1/realtime/calls/calls/rtc_backend'))
    .mockResolvedValue(new Response(null, { status: 200 }));
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  expect(call.backend).toBe('chatgpt');
  const [[url, init]] = f.transport.mock.calls;
  expect(String(url)).toBe(
    'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  );
  expect(headerOf(init, 'authorization')).toBe('Bearer chatgpt-token');
  expect(headerOf(init, 'chatgpt-account-id')).toBe('account-1');
  expect(headerOf(init, 'openai-alpha')).toBe('quicksilver=v2');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    sdp: offer,
    session: {
      model: 'gpt-live-1-codex',
      audio: { output: { voice: 'cove' } },
      delegation: { type: 'client' },
    },
  });
  // Frameless calls end via session.close from the client, not HTTP.
  await f.voice.end(call.id, '');
  expect(
    f.transport.mock.calls.some(([url]) => String(url).includes('/hangup')),
  ).toBe(false);
  expect(f.workspace.call(call.id).error).toBeNull();
});

it('refreshes the ChatGPT token once on 401', async () => {
  const f = fixture();
  f.transport
    .mockResolvedValueOnce(new Response('expired', { status: 401 }))
    .mockResolvedValueOnce(answer('/v1/realtime/calls/rtc_test'));
  await f.voice.begin('thread', offer, new AbortController().signal);
  expect(f.accessToken).toHaveBeenCalledWith({ force: true });
  expect(headerOf(f.transport.mock.calls[1][1], 'authorization')).toBe(
    'Bearer fresh-token',
  );
});

it('falls back to VOICE_API_KEY when the subscription path fails', async () => {
  const f = fixture({ key: true });
  f.transport
    .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
    .mockResolvedValueOnce(answer('/v1/realtime/calls/rtc_key'));
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  expect(call.backend).toBe('api-key');
  const last = f.transport.mock.calls[1];
  expect(String(last[0])).toBe('https://api.openai.com/v1/realtime/calls');
  expect(headerOf(last[1], 'authorization')).toBe('Bearer api-key');
});

it('reports each endpoint status when no voice path works', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(
    new Response('{"error":"nope"}', { status: 403 }),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow(
    /Voice provider could not start the call\. ChatGPT realtime: HTTP 403 \{"error":"nope"\}/,
  );
  expect(f.workspace.calls()[0].status).toBe('failed');
});

it('requires a ChatGPT sign-in or an API key', async () => {
  const f = fixture({ codex: false });
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('sign in with ChatGPT');
  expect(f.transport).not.toHaveBeenCalled();
});

it('stops trying ChatGPT endpoints after a usage limit', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('usage limit reached');
  expect(f.transport).toHaveBeenCalledTimes(1);
});
