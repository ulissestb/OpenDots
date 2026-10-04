import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthStore, User } from './auth-store.js';

export type Principal =
  { kind: 'bearer' } | { kind: 'session'; user: User; token: string };
export type CookieSecure = 'auto' | boolean;
// Per client address: a few guesses, then a 15-minute wait.
const maxIpFailures = 5;
// Per username: a much higher bar, and once reached it only blocks addresses
// that have failed themselves, so a bot sweep cannot lock the owner out.
const maxUserFailures = 50;
const failureWindow = 15 * 60_000;
const sweepThreshold = 10_000;
/**
 * COOKIE_SECURE: `true`/`false` force the flag; otherwise an https APP_ORIGIN
 * means secure, else it follows the request (HTTPS or X-Forwarded-Proto).
 */
export function cookieSecure(value?: string, appOrigin?: string): CookieSecure {
  if (value === 'true') return true;
  if (value === 'false') return false;
  try {
    if (appOrigin && new URL(appOrigin).protocol === 'https:') return true;
  } catch {
    // An invalid APP_ORIGIN is rejected elsewhere.
  }
  return 'auto';
}
/** Parses a boolean environment flag such as TRUST_PROXY. */
export function envFlag(value?: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}
export function bearerMatches(header: string | undefined, tokens: string[]) {
  const supplied = Buffer.from(header?.replace(/^Bearer /, '') ?? '');
  return tokens.some((token) => {
    const expected = Buffer.from(token);
    return (
      expected.length === supplied.length && timingSafeEqual(expected, supplied)
    );
  });
}
class FailureLimiter {
  private failures = new Map<string, number[]>();
  constructor(private now: () => number) {}
  private recent(key: string) {
    const since = this.now() - failureWindow;
    const list = (this.failures.get(key) ?? []).filter((time) => time > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
  /** Seconds until the oldest failure that keeps `list` at `max` expires. */
  private wait(list: number[], max: number) {
    if (list.length < max) return 0;
    return Math.max(
      1,
      Math.ceil((list[list.length - max] + failureWindow - this.now()) / 1000),
    );
  }
  /** Seconds until another attempt is allowed, or 0. */
  blocked(ip: string, user: string) {
    const ipFailures = this.recent(ip);
    return Math.max(
      this.wait(ipFailures, maxIpFailures),
      ipFailures.length ? this.wait(this.recent(user), maxUserFailures) : 0,
    );
  }
  fail(ip: string, user: string) {
    if (this.failures.size > sweepThreshold)
      for (const key of [...this.failures.keys()]) this.recent(key);
    this.failures.set(
      ip,
      [...this.recent(ip), this.now()].slice(-maxIpFailures),
    );
    this.failures.set(
      user,
      [...this.recent(user), this.now()].slice(-maxUserFailures),
    );
  }
  reset(ip: string, user: string) {
    this.failures.delete(ip);
    this.failures.delete(user);
  }
}
export class AuthService {
  private limiter: FailureLimiter;
  constructor(
    readonly store: AuthStore,
    readonly bearerTokens: string[] = [],
    private secure: CookieSecure = 'auto',
    now: () => number = Date.now,
    private options: { trustProxy?: boolean } = {},
  ) {
    this.limiter = new FailureLimiter(now);
  }
  private cookieName(c: Context) {
    return this.isSecure(c) ? '__Host-opendots_session' : 'opendots_session';
  }
  private isSecure(c: Context) {
    if (this.secure !== 'auto') return this.secure;
    return (
      new URL(c.req.url).protocol === 'https:' ||
      c.req.header('x-forwarded-proto') === 'https'
    );
  }
  authenticate(c: Context): Principal | null {
    if (bearerMatches(c.req.header('authorization'), this.bearerTokens))
      return { kind: 'bearer' };
    const token = getCookie(c, this.cookieName(c));
    const user = token ? this.store.session(token) : null;
    return user && token ? { kind: 'session', user, token } : null;
  }
  private startSession(c: Context, userId: string, token?: string) {
    setCookie(
      c,
      this.cookieName(c),
      token ?? this.store.createSession(userId),
      {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        secure: this.isSecure(c),
        maxAge: 30 * 24 * 60 * 60,
      },
    );
  }
  routes() {
    const app = new Hono();
    const credentials = z
      .object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(200),
      })
      .strict();
    app.post('/auth/login', async (c) => {
      const parsed = credentials.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json({ error: 'Enter your username and password.' }, 400);
      const keys = [
        `ip:${clientAddress(c, !!this.options.trustProxy)}`,
        `user:${parsed.data.username.toLowerCase()}`,
      ] as const;
      const wait = this.limiter.blocked(...keys);
      if (wait) {
        c.header('Retry-After', String(wait));
        return c.json(
          { error: 'Too many failed sign-in attempts. Try again later.' },
          429,
        );
      }
      const user = this.store.verify(
        parsed.data.username,
        parsed.data.password,
      );
      if (!user) {
        this.limiter.fail(...keys);
        return c.json({ error: 'Incorrect username or password.' }, 401);
      }
      this.limiter.reset(...keys);
      this.startSession(c, user.id);
      return c.json({ user: publicUser(user) });
    });
    app.post('/auth/logout', (c) => {
      const principal = this.authenticate(c);
      if (principal?.kind === 'session')
        this.store.deleteSession(principal.token);
      deleteCookie(c, this.cookieName(c), {
        path: '/',
        secure: this.isSecure(c),
      });
      return c.json({ ok: true });
    });
    app.get('/auth/me', (c) => {
      const principal = this.authenticate(c);
      if (!principal)
        return c.json(
          { error: 'Sign in to OpenDots.', code: 'unauthenticated' },
          401,
        );
      return principal.kind === 'bearer'
        ? c.json({ user: null, via: 'bearer' })
        : c.json({ user: publicUser(principal.user), via: 'session' });
    });
    app.post('/auth/password', async (c) => {
      const principal = this.authenticate(c);
      if (principal?.kind !== 'session')
        return c.json(
          { error: 'Sign in to OpenDots.', code: 'unauthenticated' },
          401,
        );
      const parsed = z
        .object({
          currentPassword: z.string().min(1).max(200),
          newPassword: z.string().min(1).max(400),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: 'Enter your current and new password.' }, 400);
      const result = this.store.changePassword(
        principal.user.id,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      if ('error' in result)
        return c.json({ error: result.error }, result.status);
      this.startSession(c, result.user.id, result.token);
      return c.json({ user: publicUser(result.user) });
    });
    return app;
  }
}
const publicUser = (user: User) => ({
  username: user.username,
  mustChangePassword: user.mustChangePassword,
});
/**
 * The client address for rate limiting. With TRUST_PROXY, the right-most
 * X-Forwarded-For hop (added by the one trusted reverse proxy) wins; the
 * left-hand entries are client-supplied and never trusted.
 */
function clientAddress(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const hop = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (hop) return hop;
  }
  const env = c.env as
    { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}
