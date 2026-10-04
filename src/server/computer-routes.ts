import { Hono } from 'hono';
import { z } from 'zod';
import type { ComputerService } from './computer-service.js';
import type { ComputerAction } from '../shared/computer-types.js';
export function computerRoutes(computers: ComputerService) {
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof z.ZodError || error instanceof SyntaxError
      ? c.json({ error: 'Invalid computer request.' }, 400)
      : c.json({ error: error.message }, computerErrorStatus(error.message)),
  );
  app.get('/dots/:id/computer', async (c) =>
    c.json(await computers.status(c.req.param('id'))),
  );
  app.patch('/dots/:id/computer/permissions', async (c) =>
    c.json(await computers.permissions(c.req.param('id'), await c.req.json())),
  );
  app.post('/dots/:id/computer/start', async (c) =>
    c.json(await computers.start(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/stop', async (c) =>
    c.json(await computers.stop(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/take', async (c) =>
    c.json(await computers.control(c.req.param('id'), 'take')),
  );
  app.post('/dots/:id/computer/release', async (c) =>
    c.json(await computers.control(c.req.param('id'), 'release')),
  );
  app.post('/dots/:id/computer/actions', async (c) => {
    const body = z
      .object({ action: z.string(), input: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await computers.action(
        c.req.param('id'),
        body.action as ComputerAction,
        body.input,
        'owner',
        c.req.raw.signal,
      ),
    );
  });
  return app;
}
/** Request and permission problems are 4xx; supervisor trouble is 5xx. */
function computerErrorStatus(message: string) {
  if (message === 'Dot not found.') return 404;
  if (/^(Unknown computer action|Invalid computer namespace)/.test(message))
    return 400;
  if (
    /^(Computer permission is disabled|Agents are paused|Human controls are owner-only)/.test(
      message,
    )
  )
    return 403;
  if (
    /^(There is no active control request|Start this Dot|Computer service returned HTTP 409)/.test(
      message,
    )
  )
    return 409;
  if (message === 'Computer service is not configured.') return 503;
  return 502;
}
