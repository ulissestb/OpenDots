import { randomBytes } from 'node:crypto';
import { AuthService, cookieSecure, envFlag } from './auth.js';
import { AuthStore, defaultAdmin, initialAdminPassword } from './auth-store.js';
import { passwordProblem } from '../shared/auth.js';
import { webSearchProvider } from './parallel.js';
import { closeHttpServer, createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import {
  type PlatformConfig,
  maxOutputTokens,
  reasoningEffort,
  runTimeoutMs,
} from './platform-config.js';
import { McpService } from './mcp.js';
import { McpStore } from './mcp-store.js';
import { ProviderCredentialStore } from './providers/credential-store.js';
import { CodexAuth } from './providers/codex-auth.js';
import { ProviderRegistry } from './providers/registry.js';
import { SqliteAgentRunner } from './sqlite-runner.js';
const host = process.env.HOST ?? '127.0.0.1';
// An empty or invalid PORT would bind a random port that self-calls miss.
const port = Number(process.env.PORT?.trim() || 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a TCP port number between 1 and 65535.');
const ownerToken = process.env.OWNER_TOKEN || undefined;
const configuredOrigin =
  process.env.APP_ORIGIN ||
  (process.env.NODE_ENV === 'development'
    ? 'http://127.0.0.1:5173'
    : undefined);
// Normalized (case, trailing slash); an invalid APP_ORIGIN stops startup.
const appOrigin = configuredOrigin
  ? new URL(configuredOrigin).origin
  : undefined;
const allowedHosts = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const external = !['127.0.0.1', '::1', 'localhost'].includes(host);
const wildcard = ['0.0.0.0', '::', '[::]', ''].includes(host);
if (ownerToken && ownerToken.length < 24)
  throw new Error('OWNER_TOKEN must be at least 24 characters.');
if (external && !process.env.APP_ORIGIN && !allowedHosts.length && !ownerToken)
  throw new Error(
    'External binding requires APP_ORIGIN, ALLOWED_HOSTS, or an OWNER_TOKEN of at least 24 characters.',
  );
// Lets the server call its own runtime (scheduled work, voice compute).
const internalToken = randomBytes(32).toString('base64url');
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const seed = initialAdminPassword(
  process.env.ADMIN_INITIAL_PASSWORD || undefined,
  external,
);
const authStore = new AuthStore(database, seed.password);
if (authStore.seeded && seed.generated)
  console.warn(
    `\n*** OpenDots created the admin user with a one-time password: ${seed.password}\n*** Sign in as ${defaultAdmin.username} with it and choose a new password. It is not shown again. ***\n`,
  );
if (process.env.ADMIN_PASSWORD_RESET) {
  const problem = passwordProblem(
    process.env.ADMIN_PASSWORD_RESET,
    defaultAdmin.username,
  );
  if (problem)
    console.error(`ADMIN_PASSWORD_RESET was not applied: ${problem}`);
  else if (
    authStore.resetPasswordOnce(
      defaultAdmin.username,
      process.env.ADMIN_PASSWORD_RESET,
    )
  )
    console.warn(
      'Admin password reset from ADMIN_PASSWORD_RESET; remove it from the environment.',
    );
  else
    console.warn(
      'ADMIN_PASSWORD_RESET was already applied and is ignored; remove it from the environment.',
    );
}
if (authStore.isDefaultPassword())
  console.warn(
    external
      ? '\n*** WARNING: OpenDots is reachable from other hosts and the admin password is still the default "admin". Sign in now and change it. ***\n'
      : 'Sign in as admin/admin and choose a new password on first use.',
  );
const trustProxy = envFlag(process.env.TRUST_PROXY);
if (appOrigin?.startsWith('https:') && !trustProxy)
  console.warn(
    'APP_ORIGIN is HTTPS but TRUST_PROXY is off: behind a reverse proxy, every client shares one sign-in rate-limit bucket. Set TRUST_PROXY=true if a single proxy you control forwards X-Forwarded-For.',
  );
const auth = new AuthService(
  authStore,
  [ownerToken, internalToken].filter((token): token is string => !!token),
  cookieSecure(process.env.COOKIE_SECURE, appOrigin),
  Date.now,
  { trustProxy },
);
const pruneTimer = setInterval(() => authStore.pruneSessions(), 3_600_000);
pruneTimer.unref();
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
);
// Live call sessions are held in memory, so calls open at startup are dead.
workspace.failOrphanedCalls();
const config: PlatformConfig = {
  intelligenceKey: process.env.INTELLIGENCE_API_KEY,
  intelligenceApiUrl: process.env.INTELLIGENCE_API_URL || undefined,
  intelligenceWsUrl: process.env.INTELLIGENCE_WS_URL || undefined,
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  voiceChatgptModel: process.env.VOICE_CHATGPT_MODEL || undefined,
  voiceChatgptVoice: process.env.VOICE_CHATGPT_VOICE || undefined,
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  // The server's own runtime: loopback for wildcard binds, else the bound host.
  runtimeUrl: `http://${wildcard ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/api/copilotkit`,
  serviceToken: internalToken,
  runTimeoutMs: runTimeoutMs(process.env.AGENT_RUN_TIMEOUT_SECONDS),
  maxOutputTokens: maxOutputTokens(process.env.MODEL_MAX_OUTPUT_TOKENS),
  reasoningEffort: reasoningEffort(process.env.MODEL_REASONING_EFFORT),
};
const credentials = new ProviderCredentialStore(
  database,
  process.env.CREDENTIALS_SECRET,
);
const codex = new CodexAuth(credentials);
const mcpStore = new McpStore(database, process.env.CREDENTIALS_SECRET);
const platform = new Platform(
  store,
  workspace,
  config,
  ProviderRegistry.fromConfig(config, codex, process.env.OPENAI_CODEX_MODEL),
  config.intelligenceKey ? undefined : new SqliteAgentRunner(database),
  new McpService(mcpStore),
);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: config.webSearchProvider,
  parallelApiKey: config.parallelApiKey,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
  runTimeoutMs: config.runTimeoutMs,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress, started) => {
    const threadId = workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no Intelligence conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its Intelligence conversation.');
    const text = await platform.turn(
      threadId,
      claim.prompt,
      signal,
      { opendotsSource: 'scheduled' },
      { onStart: started },
    );
    return { text, sources: [], sample: false };
  },
);
const wsOrigin = new URL(
  config.intelligenceWsUrl ?? 'wss://realtime.intelligence.copilotkit.ai',
).origin;
const app = createApp({
  store,
  runner,
  config: researchConfig,
  auth,
  origin: appOrigin,
  allowedHosts,
  platform,
  codex,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`OpenDots template listening on http://${host}:${info.port}`);
  runner.start();
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure(
        'Slack Channels activation failed; check setup status',
        [safeFailure(error)],
      ),
    );
});
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: async () => {
    clearInterval(pruneTimer);
    codex.stop();
    await platform.stop();
  },
  closeServer: () => closeHttpServer(server as Server),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// A stray rejection is logged, not fatal: the request or job it belonged to
// has already failed on its own path.
process.on('unhandledRejection', (error) =>
  reportChannelFailure('Unhandled promise rejection', [safeFailure(error)]),
);
// After an uncaught exception the process state is unknown: release leased
// tasks so they requeue promptly, then exit for the container to restart.
process.on('uncaughtException', (error) => {
  // The stack is the only clue to a crash; it goes to the operator's own log.
  console.error('Uncaught exception; exiting:', error.stack ?? error.name);
  try {
    runner.stop();
  } catch {
    // Leases expire and the tasks are retried after a restart.
  }
  process.exit(1);
});
