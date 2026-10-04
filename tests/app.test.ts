import { afterEach, describe, expect, it } from 'vitest';
import { createApp, runtimeBodyLimit } from '../src/server/app.js';
import { AuthService } from '../src/server/auth.js';
import { AuthStore } from '../src/server/auth-store.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
function fixture(token?: string) {
  const store = new Store(':memory:');
  stores.push(store);
  const runner = new Runner(store, config);
  return {
    store,
    runner,
    app: createApp({ store, runner, config, auth: false, ownerToken: token }),
  };
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
afterEach(() => stores.splice(0).forEach((store) => store.close()));
describe('API boundaries', () => {
  it('requires owner token for state and mutations when configured', async () => {
    const { app } = fixture('private-token');
    expect((await app.request('/api/state')).status).toBe(401);
    expect(
      (
        await app.request('/api/state', {
          headers: { Authorization: 'Bearer private-token' },
        })
      ).status,
    ).toBe(200);
  });
  it('blocks browser cross-origin requests and form posts', async () => {
    const { app } = fixture();
    expect(
      (
        await app.request('/api/tasks', {
          ...json({ prompt: 'test' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/tasks', {
          method: 'POST',
          body: 'prompt=hello',
        })
      ).status,
    ).toBe(415);
  });
  it('validates inputs and enforces research permissions on the server', async () => {
    const { app, store } = fixture();
    expect(
      (await app.request('/api/tasks', json({ prompt: 'x' }))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/tasks',
          json({ prompt: 'Research', intervalSeconds: 1 }),
        )
      ).status,
    ).toBe(400);
    store.updateSettings({ researchAllowed: false });
    expect(
      (await app.request('/api/tasks', json({ prompt: 'Research' }))).status,
    ).toBe(403);
    expect(store.claim()).toBeNull();
  });
  it('runs a sample job from the durable queue and retains its result', async () => {
    const { app, store, runner } = fixture();
    const response = await app.request(
      '/api/tasks',
      json({ prompt: 'Plan a quiet weekend' }),
    );
    expect(response.status).toBe(201);
    await runner.tick();
    const task = store.tasks()[0];
    expect(task.status).toBe('completed');
    expect(store.detail(task.id)?.runs[0].result?.sample).toBe(true);
  });
  it('persists memory edits and deletes', async () => {
    const { app, store } = fixture();
    await app.request('/api/memories', json({ text: 'Prefer short briefs' }));
    const memory = store.memories()[0];
    const updated = await app.request(`/api/memories/${memory.id}`, {
      ...json({ text: 'Prefer deep briefs' }),
      method: 'PUT',
    });
    expect(updated.status).toBe(200);
    expect(store.memories()[0].text).toBe('Prefer deep briefs');
    await app.request(`/api/memories/${memory.id}`, {
      ...json({}),
      method: 'DELETE',
    });
    expect(store.memories()).toHaveLength(0);
  });
});
it('rejects DNS-rebinding Host even with a matching hostile Origin', async () => {
  const { app } = fixture();
  const response = await app.request('http://attacker.example/api/tasks', {
    ...json({ prompt: 'Sneaky task' }),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://attacker.example',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  expect(response.status).toBe(403);
});
describe('deployment boundaries', () => {
  const make = (options: { origin?: string; allowedHosts?: string[] } = {}) => {
    const store = new Store(':memory:');
    stores.push(store);
    return createApp({
      store,
      runner: new Runner(store, config),
      config,
      auth: false,
      ...options,
    });
  };
  const sized = (bytes: number) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(bytes),
    },
    body: 'x'.repeat(bytes),
  });
  it('allows large agent-runtime bodies but keeps 1 MB elsewhere', async () => {
    const app = make();
    expect((await app.request('/api/tasks', sized(2_000_000))).status).toBe(
      413,
    );
    expect(
      (await app.request('/api/copilotkit/agent/a/run', sized(2_000_000)))
        .status,
    ).toBe(404);
    expect(
      (await app.request('/api/copilotkit', sized(runtimeBodyLimit + 1)))
        .status,
    ).toBe(413);
  });
  it('normalizes APP_ORIGIN case and trailing slash', async () => {
    const app = make({ origin: 'HTTPS://Dots.Example.com/' });
    const response = await app.request('https://dots.example.com/api/state', {
      headers: { Origin: 'https://dots.example.com' },
    });
    expect(response.status).toBe(200);
  });
  it('accepts a same-host Origin on an allowed host, not other local ports', async () => {
    const app = make({
      origin: 'https://dots.example.com',
      allowedHosts: ['192.168.1.5'],
    });
    expect(
      (
        await app.request('http://192.168.1.5:4310/api/state', {
          headers: { Origin: 'http://192.168.1.5:4310' },
        })
      ).status,
    ).toBe(200);
    // TLS terminated at the proxy: the app sees http, the browser https.
    expect(
      (
        await app.request('http://dots.example.com/api/state', {
          headers: { Origin: 'https://dots.example.com' },
        })
      ).status,
    ).toBe(200);
    for (const [url, origin] of [
      ['http://localhost:4310/api/state', 'http://localhost:3000'],
      ['http://192.168.1.5:4310/api/state', 'http://localhost:4310'],
      ['http://localhost:4310/api/state', 'null'],
    ])
      expect(
        (await app.request(url, { headers: { Origin: origin } })).status,
      ).toBe(403);
  });
  it('serves an unauthenticated health check without details', async () => {
    const store = new Store(':memory:');
    const authStore = new AuthStore(':memory:');
    stores.push(store);
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      auth: new AuthService(authStore, [], false),
    });
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await app.request('/api/state')).status).toBe(401);
    authStore.close();
  });
});
