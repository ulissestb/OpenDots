import { computerRoutes } from './computer-routes.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bearerMatches, type AuthService } from './auth.js';
import { z } from 'zod';
import { Store, settingsInterruptRuns } from './store.js';
import { Runner } from './runner.js';
import { configured, type Config } from './research.js';
import type { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import { workspaceRoutes } from './workspace-routes.js';
import { providerRoutes } from './provider-routes.js';
import type { CodexAuth } from './providers/codex-auth.js';
import { modelIdSchema, providerIdSchema } from '../shared/providers.js';
const interval = z.number().int().min(60).max(31_536_000).nullable();
/** Agent runs carry the whole conversation; other API bodies stay small. */
export const runtimeBodyLimit = 32 * 1024 * 1024;
export const apiBodyLimit = 1_000_000;
const isRuntimePath = (path: string) =>
  path === '/api/copilotkit' || path.startsWith('/api/copilotkit/');
export interface AppOptions {
  store: Store;
  runner: Runner;
  config: Config;
  /** Session sign-in; `false` disables it (Bearer tokens only, for tests). */
  auth: AuthService | false;
  /** Tokens accepted as `Authorization: Bearer`; `ownerToken` is an alias. */
  bearerTokens?: string[];
  ownerToken?: string;
  origin?: string;
  /** Extra host names accepted for browser requests. */
  allowedHosts?: string[];
  platform?: Platform;
  codex?: CodexAuth;
}
export function createApp({
  store,
  runner,
  config,
  auth,
  bearerTokens = [],
  ownerToken,
  origin,
  allowedHosts = [],
  platform,
  codex,
}: AppOptions) {
  const app = new Hono();
  // Normalizes case and a trailing slash, e.g. `HTTPS://Example.com/`.
  const appOrigin = origin ? new URL(origin).origin : undefined;
  const tokens = [
    ...new Set([
      ...bearerTokens,
      ...(auth ? auth.bearerTokens : []),
      ...(ownerToken ? [ownerToken] : []),
    ]),
  ];
  const hosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...(appOrigin ? [new URL(appOrigin).hostname] : []),
    ...allowedHosts,
  ]);
  const tooLarge = (c: Context) =>
    c.json({ error: 'Request is too large.' }, 413);
  const runtimeLimit = bodyLimit({
    maxSize: runtimeBodyLimit,
    onError: tooLarge,
  });
  const apiLimit = bodyLimit({ maxSize: apiBodyLimit, onError: tooLarge });
  app.use('/api/*', (c, next) =>
    (isRuntimePath(c.req.path) ? runtimeLimit : apiLimit)(c, next),
  );
  // Unauthenticated liveness probe for containers and proxies; no details.
  app.get('/api/health', (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      store.settings();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  /**
   * The exact APP_ORIGIN, or a same-host page (scheme may differ behind a
   * TLS-terminating proxy) on an allowed host such as a LAN address. Other
   * ports on the same host are rejected: SameSite treats them as same-site.
   */
  const originAllowed = (value: string, requestUrl: URL) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    if (parsed.origin === (appOrigin ?? requestUrl.origin)) return true;
    return parsed.host === requestUrl.host && hosts.has(parsed.hostname);
  };
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const bearer = bearerMatches(c.req.header('authorization'), tokens);
    const requestUrl = new URL(c.req.url);
    // Applies to every browser request so a DNS-rebinding page cannot reach the
    // sign-in form; only a valid Bearer token may use another host name.
    if (!bearer && !hosts.has(requestUrl.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const requestOrigin = c.req.header('origin');
    if (requestOrigin && !originAllowed(requestOrigin, requestUrl))
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !c.req.header('content-type')?.includes('application/json')
    )
      return c.json({ error: 'Use application/json.' }, 415);
    if (requestUrl.pathname.startsWith('/api/auth/')) return next();
    if (!auth) {
      if (tokens.length && !bearer)
        return c.json(
          { error: 'Enter your owner access token to unlock OpenDots.' },
          401,
        );
      return next();
    }
    const principal = auth.authenticate(c);
    if (!principal)
      return c.json(
        { error: 'Sign in to OpenDots.', code: 'unauthenticated' },
        401,
      );
    if (principal.kind === 'session' && principal.user.mustChangePassword)
      return c.json(
        {
          error: 'Change your password to continue.',
          code: 'password_change_required',
        },
        403,
      );
    await next();
  });
  if (auth) app.route('/api', auth.routes());
  if (platform) app.route('/api', computerRoutes(platform.computers));
  const voice = platform ? new VoiceService(platform, fetch, codex) : undefined;
  if (platform && voice) app.route('/api', workspaceRoutes(platform, voice));
  if (platform) app.route('/api', providerRoutes(platform, codex));
  app.get('/api/state', (c) =>
    c.json({
      settings: store.settings(),
      tasks: store.tasks(),
      memories: store.memories(),
      mode: config.mode,
      configured: configured(config),
    }),
  );
  app.post('/api/tasks', async (c) => {
    const parsed = z
      .object({
        prompt: z.string().trim().min(3).max(4000),
        intervalSeconds: interval.optional(),
        threadId: z.string().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.',
        },
        400,
      );
    if (!store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    if (platform) {
      if (platform.setup().missing.length)
        return c.json(
          { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
          503,
        );
      if (!parsed.data.threadId)
        return c.json(
          { error: 'Select a conversation for this scheduled task.' },
          400,
        );
      try {
        platform.workspace.requireThread(parsed.data.threadId);
      } catch {
        return c.json(
          { error: 'Conversation is not owned by this workspace.' },
          403,
        );
      }
    }
    const task = store.createTask(
      parsed.data.prompt,
      parsed.data.intervalSeconds,
    );
    if (platform && parsed.data.threadId)
      platform.workspace.bindTask(task.id, parsed.data.threadId);
    return c.json(task, 201);
  });
  app.get('/api/tasks/:id', (c) => {
    const detail = store.detail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Task not found.' }, 404);
  });
  app.post('/api/tasks/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['run', 'pause', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown task action.' }, 400);
    if (parsed.data.action === 'run' && !store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    const task = store.action(c.req.param('id'), parsed.data.action);
    if (parsed.data.action !== 'run') runner.abort(c.req.param('id'));
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.put('/api/tasks/:id/schedule', async (c) => {
    const parsed = z
      .object({ intervalSeconds: interval })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Repeat interval must be 60 seconds to one year, or null.' },
        400,
      );
    const task = store.schedule(c.req.param('id'), parsed.data.intervalSeconds);
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.patch('/api/settings', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        paused: z.boolean().optional(),
        researchAllowed: z.boolean().optional(),
        memoryAllowed: z.boolean().optional(),
        autoMemory: z.boolean().optional(),
        modelProvider: providerIdSchema.nullable().optional(),
        model: modelIdSchema.nullable().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings.' }, 400);
    const previous = store.settings();
    const settings = store.updateSettings(parsed.data);
    if (settingsInterruptRuns(previous, settings)) runner.abortAll();
    if (settings.paused) voice?.abortAll();
    else void voice?.resumePending();
    return c.json(settings);
  });
  const memoryBody = z
    .object({
      text: z.string().trim().min(1).max(2000),
      dotId: z.string().min(1).max(200).nullable().optional(),
    })
    .strict();
  const readMemory = async (request: Request) => {
    const parsed = memoryBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return { error: 'Memory must be between 1 and 2,000 characters.' };
    if (parsed.data.dotId && !platform?.workspace.dot(parsed.data.dotId))
      return { error: 'Unknown Dot for this memory.' };
    return { value: parsed.data };
  };
  app.post('/api/memories', async (c) => {
    const body = await readMemory(c.req.raw);
    if (!body.value) return c.json({ error: body.error }, 400);
    try {
      return c.json(store.saveMemory(body.value), 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }
  });
  app.put('/api/memories/:id', async (c) => {
    const body = await readMemory(c.req.raw);
    if (!body.value) return c.json({ error: body.error }, 400);
    if (!store.memory(c.req.param('id')))
      return c.json({ error: 'Memory not found.' }, 404);
    return c.json(store.saveMemory(body.value, c.req.param('id')));
  });
  app.delete('/api/memories/:id', (c) =>
    store.deleteMemory(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found.' }, 404),
  );
  app.onError((error, c) => {
    console.error(
      'API request failed:',
      error.name,
      error.message.slice(0, 500),
    );
    return c.json(
      {
        error:
          'The server could not complete this request. Check server logs and database access.',
      },
      500,
    );
  });
  return app;
}
