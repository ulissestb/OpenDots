import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { ProviderCredentialStore } from '../src/server/providers/credential-store.js';
import { ProviderRegistry } from '../src/server/providers/registry.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Settings } from '../src/shared/types.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const settings: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
};
function registry(
  env: { apiKey?: string; model?: string } = {},
  chatgpt = false,
) {
  const credentials = new ProviderCredentialStore(':memory:');
  cleanup.push(() => credentials.close());
  if (chatgpt)
    credentials.save('openai-codex', {
      tokens: { access_token: 'a', refresh_token: 'r' },
      accountId: 'account',
      email: null,
      plan: null,
      expiresAt: Date.now() + 3_600_000,
    });
  return ProviderRegistry.fromConfig(env, new CodexAuth(credentials));
}
describe('provider resolution', () => {
  it('reports the existing environment variables when nothing is configured', () => {
    expect(registry().readiness(settings)).toMatchObject({
      ready: false,
      provider: 'openai-compatible',
      missing: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
    });
    expect(registry({ apiKey: 'key' }).readiness(settings).missing).toEqual([
      'OPENAI_MODEL',
    ]);
  });
  it('picks the first ready provider automatically', () => {
    expect(registry({}, true).readiness(settings)).toMatchObject({
      ready: true,
      provider: 'openai-codex',
      model: 'gpt-5.5',
    });
    expect(
      registry({ apiKey: 'key', model: 'm' }, true).readiness(settings),
    ).toMatchObject({ provider: 'openai-compatible', model: 'm' });
  });
  it('applies the workspace default, then the Dot override', () => {
    const providers = registry({ apiKey: 'key', model: 'm' }, true);
    const workspace = {
      ...settings,
      modelProvider: 'openai-codex' as const,
      model: 'gpt-5.4',
    };
    expect(providers.readiness(workspace)).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.4',
    });
    expect(
      providers.readiness(workspace, {
        provider: 'openai-compatible',
        model: null,
      }),
    ).toMatchObject({ provider: 'openai-compatible', model: 'm' });
    expect(
      providers.readiness(workspace, { provider: null, model: 'gpt-5.5' }),
    ).toMatchObject({ provider: 'openai-codex', model: 'gpt-5.5' });
  });
  it('names the missing setup for an unready choice', () => {
    expect(() =>
      registry().resolve({ ...settings, modelProvider: 'openai-codex' }),
    ).toThrow('Model provider setup required: ChatGPT sign-in.');
  });
});
function appFixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const config = {
    intelligenceKey: 'fixture',
    baseUrl: 'https://example.com',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  };
  const platform = new Platform(store, workspace, config, registry({}, true));
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
    config: { mode: 'live', baseUrl: config.baseUrl },
    platform,
    auth: false,
  });
  return { app, workspace, platform };
}
const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
describe('provider settings', () => {
  it('lets a ChatGPT sign-in satisfy the model setup', () => {
    const { platform } = appFixture();
    expect(platform.setup()).toMatchObject({
      model: true,
      missing: [],
      defaultProvider: { provider: 'openai-codex', model: 'gpt-5.5' },
    });
  });
  it('validates and saves the workspace default', async () => {
    const { app } = appFixture();
    expect(
      (
        await app.request(
          '/api/settings',
          send('PATCH', { modelProvider: 'x' }),
        )
      ).status,
    ).toBe(400);
    const saved = await app.request(
      '/api/settings',
      send('PATCH', { modelProvider: 'openai-codex', model: 'gpt-5.4' }),
    );
    expect(await saved.json()).toMatchObject({
      modelProvider: 'openai-codex',
      model: 'gpt-5.4',
    });
    const providers = await (await app.request('/api/providers')).json();
    expect(providers.defaultProvider).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.4',
    });
    expect(JSON.stringify(providers)).not.toContain('refresh');
  });
  it('saves and clears a Dot override', async () => {
    const { app, workspace } = appFixture();
    const dot = workspace.dots()[0];
    const base = {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: true,
      memoryAllowed: true,
    };
    await app.request(
      `/api/dots/${dot.id}`,
      send('PUT', { ...base, provider: 'openai-codex', model: 'gpt-5.4' }),
    );
    expect(workspace.dot(dot.id)).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.4',
    });
    await app.request(`/api/dots/${dot.id}`, send('PUT', base));
    expect(workspace.dot(dot.id)?.provider).toBe('openai-codex');
    await app.request(
      `/api/dots/${dot.id}`,
      send('PUT', { ...base, provider: null, model: null }),
    );
    expect(workspace.dot(dot.id)).toMatchObject({
      provider: null,
      model: null,
    });
  });
});
it('adds provider columns to an existing dots table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-migrate-'));
  const path = join(dir, 'db.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO spaces VALUES ('s','Old','',1);
    INSERT INTO dots VALUES ('d','s','Old Dot','Be useful.',1,1,1);`);
  old.close();
  const workspace = new WorkspaceStore(path, 'owner');
  cleanup.push(() => {
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });
  expect(workspace.dot('d')).toMatchObject({ provider: null, model: null });
});
