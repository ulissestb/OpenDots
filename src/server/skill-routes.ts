import { Hono } from 'hono';
import { skillInputSchema } from '../shared/skills.js';
import type { WorkspaceStore } from './workspace.js';

export function skillRoutes(workspace: WorkspaceStore) {
  const app = new Hono();
  app.get('/skills', (c) => c.json(workspace.skills.list()));
  const save = async (body: unknown, id?: string) => {
    const parsed = skillInputSchema.safeParse(body);
    if (!parsed.success)
      return {
        status: 400 as const,
        body: {
          error: parsed.error.issues
            .map(
              (issue) => `${issue.path.join('.') || 'skill'}: ${issue.message}`,
            )
            .join(' '),
        },
      };
    const unknown = (parsed.data.dotIds ?? []).filter(
      (dotId) => !workspace.dot(dotId),
    );
    if (unknown.length)
      return { status: 400 as const, body: { error: 'Unknown Dot.' } };
    try {
      return {
        status: id ? (200 as const) : (201 as const),
        body: workspace.skills.save(parsed.data, id),
      };
    } catch (error) {
      return {
        status: (error instanceof Error && error.message === 'Skill not found.'
          ? 404
          : 409) as 404 | 409,
        body: {
          error: error instanceof Error ? error.message : 'Could not save.',
        },
      };
    }
  };
  app.post('/skills', async (c) => {
    const result = await save(await c.req.json());
    return c.json(result.body, result.status);
  });
  app.put('/skills/:id', async (c) => {
    const result = await save(await c.req.json(), c.req.param('id'));
    return c.json(result.body, result.status);
  });
  app.delete('/skills/:id', (c) =>
    workspace.skills.delete(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Skill not found.' }, 404),
  );
  return app;
}
