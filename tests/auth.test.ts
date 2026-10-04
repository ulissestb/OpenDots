import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService, cookieSecure, envFlag } from '../src/server/auth.js';
import { AuthStore, initialAdminPassword } from '../src/server/auth-store.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const closers: { close(): void }[] = [];
afterEach(() => closers.splice(0).forEach((item) => item.close()));
function fixture(options: { seed?: string; bearer?: string[] } = {}) {
  let time = 1_000_000;
  const now = () => time;
  const store = new Store(':memory:');
  const authStore = new AuthStore(':memory:', options.seed, now);
  closers.push(store, authStore);
  const auth = new AuthService(authStore, options.bearer ?? [], false, now);
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    auth,
  });
  return {
    app,
    authStore,
    advance: (ms: number) => (time += ms),
  };
}
const post = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: JSON.stringify(body),
});
const cookieOf = (response: Response) =>
  response.headers.get('set-cookie')?.split(';')[0] ?? '';
async function login(
  app: ReturnType<typeof fixture>['app'],
  password = 'admin',
) {
  const response = await app.request(
    '/api/auth/login',
    post({ username: 'admin', password }),
  );
  return { response, cookie: cookieOf(response) };
}
async function signInChanged(app: ReturnType<typeof fixture>['app']) {
  const { cookie } = await login(app);
  const changed = await app.request(
    '/api/auth/password',
    post(
      { currentPassword: 'admin', newPassword: 'a-much-better-secret' },
      cookie,
    ),
  );
  return { changed, cookie: cookieOf(changed), old: cookie };
}
describe('sign-in', () => {
  it('seeds admin/admin once, stored as a scrypt hash', () => {
    const { authStore } = fixture();
    expect(authStore.verify('admin', 'admin')?.mustChangePassword).toBe(true);
    expect(authStore.verify('admin', 'wrong')).toBeNull();
    expect(authStore.verify('nobody', 'admin')).toBeNull();
    expect(authStore.isDefaultPassword()).toBe(true);
  });
  it('honours ADMIN_INITIAL_PASSWORD', () => {
    const { authStore } = fixture({ seed: 'initial-secret-123' });
    expect(authStore.verify('admin', 'admin')).toBeNull();
    expect(authStore.verify('admin', 'initial-secret-123')).not.toBeNull();
    expect(authStore.isDefaultPassword()).toBe(false);
  });
  it('requires a session for the API', async () => {
    const { app } = fixture();
    const response = await app.request('/api/state');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
  });
  it('sets an HttpOnly strict cookie and forces a password change', async () => {
    const { app } = fixture();
    const { response, cookie } = await login(app);
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(await response.json()).toEqual({
      user: { username: 'admin', mustChangePassword: true },
    });
    const blocked = await app.request('/api/state', {
      headers: { Cookie: cookie },
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      code: 'password_change_required',
    });
    const me = await app.request('/api/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
  });
  it('rejects wrong credentials', async () => {
    const { app } = fixture();
    expect((await login(app, 'nope')).response.status).toBe(401);
  });
  it('validates and applies a password change, rotating the session', async () => {
    const { app } = fixture();
    const { cookie } = await login(app);
    const wrong = await app.request(
      '/api/auth/password',
      post(
        { currentPassword: 'x', newPassword: 'a-much-better-secret' },
        cookie,
      ),
    );
    expect(wrong.status).toBe(401);
    for (const weak of ['short', 'admin', 'ADMIN'])
      expect(
        (
          await app.request(
            '/api/auth/password',
            post({ currentPassword: 'admin', newPassword: weak }, cookie),
          )
        ).status,
      ).toBe(400);
    const { changed, cookie: fresh, old } = await signInChanged(app);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({
      user: { username: 'admin', mustChangePassword: false },
    });
    expect(fresh).not.toBe(old);
    expect(
      (await app.request('/api/state', { headers: { Cookie: old } })).status,
    ).toBe(401);
    expect(
      (await app.request('/api/state', { headers: { Cookie: fresh } })).status,
    ).toBe(200);
    expect((await login(app, 'a-much-better-secret')).response.status).toBe(
      200,
    );
  });
  it('signs out', async () => {
    const { app } = fixture();
    const { cookie } = await signInChanged(app);
    expect(
      (await app.request('/api/auth/logout', post({}, cookie))).status,
    ).toBe(200);
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie } })).status,
    ).toBe(401);
  });
  it('expires idle and old sessions', async () => {
    const { app, advance } = fixture();
    const { cookie } = await signInChanged(app);
    advance(6 * 24 * 60 * 60_000);
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie } })).status,
    ).toBe(200);
    advance(7 * 24 * 60 * 60_000 + 1);
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie } })).status,
    ).toBe(401);
  });
  it('rate-limits repeated failures', async () => {
    const { app } = fixture();
    for (let i = 0; i < 5; i++)
      expect((await login(app, 'bad')).response.status).toBe(401);
    const limited = (await login(app)).response;
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
  it('revokes sessions on reset', async () => {
    const { app, authStore } = fixture();
    const { cookie } = await signInChanged(app);
    authStore.resetPassword('admin', 'reset-secret-123');
    expect(
      (await app.request('/api/state', { headers: { Cookie: cookie } })).status,
    ).toBe(401);
    expect(authStore.verify('admin', 'reset-secret-123')).toMatchObject({
      mustChangePassword: true,
    });
  });
  it('rate-limits wrong current passwords on password change', async () => {
    const { app } = fixture();
    const { cookie } = await signInChanged(app);
    const attempt = (currentPassword: string) =>
      app.request(
        '/api/auth/password',
        post({ currentPassword, newPassword: 'yet-another-secret-1' }, cookie),
      );
    for (let i = 0; i < 5; i++)
      expect((await attempt('wrong-guess')).status).toBe(401);
    expect((await attempt('a-much-better-secret')).status).toBe(429);
  });
  it('applies an environment reset once per value', () => {
    const { authStore } = fixture();
    expect(authStore.resetPasswordOnce('admin', 'reset-secret-123')).toBe(true);
    authStore.resetPassword('admin', 'owner-chosen-456', false);
    // A restart with the same value still set must keep the owner's password.
    expect(authStore.resetPasswordOnce('admin', 'reset-secret-123')).toBe(
      false,
    );
    expect(authStore.verify('admin', 'owner-chosen-456')).toBeTruthy();
    expect(authStore.resetPasswordOnce('admin', 'another-reset-789')).toBe(
      true,
    );
    expect(authStore.verify('admin', 'another-reset-789')).toBeTruthy();
  });
  it('lets Bearer tokens bypass sign-in, from any host', async () => {
    const { app } = fixture({ bearer: ['service-token'] });
    const headers = { Authorization: 'Bearer service-token' };
    expect((await app.request('/api/state', { headers })).status).toBe(200);
    expect(
      (await app.request('http://evil.example/api/state', { headers })).status,
    ).toBe(200);
  });
  it('rejects unknown hosts, foreign origins and form posts at sign-in', async () => {
    const { app } = fixture();
    expect(
      (
        await app.request(
          'http://evil.example/api/auth/login',
          post({ username: 'admin', password: 'admin' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/auth/login', {
          ...post({ username: 'admin', password: 'admin' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'username=admin&password=admin',
        })
      ).status,
    ).toBe(415);
  });
});
describe('deployment hardening', () => {
  function proxied(trustProxy: boolean) {
    const store = new Store(':memory:');
    const authStore = new AuthStore(':memory:');
    closers.push(store, authStore);
    const auth = new AuthService(authStore, [], false, Date.now, {
      trustProxy,
    });
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      auth,
    });
    // Every request reaches the app from the proxy's socket address.
    const attempt = (
      password: string,
      forwardedFor?: string,
      cookie?: string,
    ) =>
      app.request(
        '/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ username: 'admin', password }),
        },
        { incoming: { socket: { remoteAddress: '172.18.0.1' } } },
      );
    return attempt;
  }
  it('seeds a random admin password on an external first start', () => {
    expect(initialAdminPassword(undefined, false)).toEqual({
      generated: false,
    });
    expect(initialAdminPassword('chosen-secret', true)).toEqual({
      password: 'chosen-secret',
      generated: false,
    });
    const seed = initialAdminPassword(undefined, true);
    expect(seed.generated).toBe(true);
    expect(seed.password?.length).toBeGreaterThanOrEqual(24);
    expect(initialAdminPassword(undefined, true).password).not.toBe(
      seed.password,
    );
    const authStore = new AuthStore(':memory:', seed.password);
    closers.push(authStore);
    expect(authStore.seeded).toBe(true);
    expect(authStore.verify('admin', 'admin')).toBeNull();
    expect(authStore.isDefaultPassword()).toBe(false);
    expect(authStore.verify('admin', seed.password!)).toMatchObject({
      mustChangePassword: true,
    });
  });
  it('reports seeding only on the first start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-auth-'));
    try {
      const path = join(dir, 'auth.sqlite');
      const first = new AuthStore(path, 'first-secret-123');
      expect(first.seeded).toBe(true);
      first.close();
      const second = new AuthStore(path, 'other-secret-456');
      expect(second.seeded).toBe(false);
      expect(second.verify('admin', 'first-secret-123')).not.toBeNull();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keys the address limit on the right-most X-Forwarded-For hop with TRUST_PROXY', async () => {
    const attempt = proxied(true);
    for (let i = 0; i < 5; i++)
      expect(
        (await attempt('bad', `1.1.1.1, 203.0.113.${i}, 198.51.100.7`)).status,
      ).toBe(401);
    expect((await attempt('admin', '198.51.100.7')).status).toBe(429);
    // A different client behind the same proxy is unaffected.
    expect((await attempt('admin', '198.51.100.8')).status).toBe(200);
  });
  it('ignores X-Forwarded-For without TRUST_PROXY', async () => {
    const attempt = proxied(false);
    for (let i = 0; i < 5; i++)
      expect((await attempt('bad', `198.51.100.${i}`)).status).toBe(401);
    expect((await attempt('admin', '198.51.100.99')).status).toBe(429);
  });
  const deviceOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((item) => item.startsWith('opendots_device='))
      ?.split(';')[0];
  it('limits a concurrent burst of guesses from one address', async () => {
    const attempt = proxied(true);
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () => attempt('bad', '203.0.113.9')),
    );
    expect(statuses.filter((r) => r.status === 429).length).toBe(5);
  }, 30_000);
  it('caps a distributed guesser without locking out a known device', async () => {
    const attempt = proxied(true);
    const device = deviceOf(await attempt('admin', '198.51.100.1'));
    expect(device).toBeTruthy();
    for (let i = 0; i < 50; i++)
      expect((await attempt('bad', `203.0.113.${i}`)).status).toBe(401);
    // Rotating addresses no longer buys more guesses...
    expect((await attempt('admin', '192.0.2.77')).status).toBe(429);
    // ...while the owner's browser, which signed in before, still can.
    expect((await attempt('admin', '192.0.2.78', device)).status).toBe(200);
  }, 30_000);
  it('keeps a known device signing in when a proxy hides client addresses', async () => {
    const attempt = proxied(false);
    const device = deviceOf(await attempt('admin'));
    for (let i = 0; i < 5; i++) expect((await attempt('bad')).status).toBe(401);
    expect((await attempt('admin')).status).toBe(429);
    expect((await attempt('admin', undefined, device)).status).toBe(200);
    // A forged device cookie counts as no device.
    expect((await attempt('admin', undefined, `${device}x`)).status).toBe(429);
  }, 30_000);
  it('treats COOKIE_SECURE=auto with an https APP_ORIGIN as secure', () => {
    expect(cookieSecure(undefined, 'https://dots.example.com')).toBe(true);
    expect(cookieSecure('auto', 'https://dots.example.com')).toBe(true);
    expect(cookieSecure('', 'http://localhost:4310')).toBe('auto');
    expect(cookieSecure('false', 'https://dots.example.com')).toBe(false);
    expect(cookieSecure('true')).toBe(true);
    expect(envFlag('true')).toBe(true);
    expect(envFlag('1')).toBe(true);
    expect(envFlag('')).toBe(false);
    expect(envFlag(undefined)).toBe(false);
  });
  it('sets a __Host- Secure cookie when secure', async () => {
    const store = new Store(':memory:');
    const authStore = new AuthStore(':memory:');
    closers.push(store, authStore);
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      auth: new AuthService(
        authStore,
        [],
        cookieSecure('auto', 'https://dots.example.com'),
      ),
    });
    const response = await app.request(
      '/api/auth/login',
      post({ username: 'admin', password: 'admin' }),
    );
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^__Host-opendots_session=/);
    expect(header).toMatch(/Secure/);
  });
});
