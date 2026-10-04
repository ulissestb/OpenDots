import { Hono } from 'hono';
import type { Platform } from './platform.js';
import type { CodexAuth } from './providers/codex-auth.js';
import { providerIdSchema } from '../shared/providers.js';

export function providerRoutes(platform: Platform, codex?: CodexAuth) {
  const app = new Hono();
  app.get('/providers', (c) => {
    const setup = platform.setup();
    return c.json({
      providers: setup.providers ?? [],
      defaultProvider: setup.defaultProvider ?? null,
    });
  });
  app.get('/providers/:id/models', async (c) => {
    const id = providerIdSchema.safeParse(c.req.param('id'));
    const provider = id.success && platform.providers.provider(id.data);
    if (!provider) return c.json({ error: 'Unknown model provider.' }, 404);
    return c.json(await provider.models(c.req.raw.signal));
  });
  if (!codex) return app;
  app.post('/providers/openai-codex/device', async (c) => {
    try {
      return c.json(await codex.startDeviceFlow(), 201);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error && error.message.startsWith('ChatGPT')
              ? error.message
              : 'ChatGPT sign-in could not start.',
        },
        502,
      );
    }
  });
  app.get('/providers/openai-codex/device/:flowId', (c) =>
    c.json(codex.flowStatus(c.req.param('flowId'))),
  );
  app.delete('/providers/openai-codex/device/:flowId', (c) => {
    codex.cancel(c.req.param('flowId'));
    return c.json({ ok: true });
  });
  app.delete('/providers/openai-codex/credential', (c) => {
    codex.disconnect();
    return c.json({ ok: true });
  });
  return app;
}
