import { Hono } from 'hono';
import { mcpServerInputSchema } from '../shared/mcp.js';
import type { McpService } from './mcp.js';
import { publicServer } from './mcp-store.js';
import type { WorkspaceStore } from './workspace.js';

export function mcpRoutes(mcp: McpService, workspace: WorkspaceStore) {
  const app = new Hono();
  app.get('/mcp/servers', (c) => c.json(mcp.store.list().map(publicServer)));
  const save = async (body: unknown, id?: string) => {
    const parsed = mcpServerInputSchema.safeParse(body);
    if (!parsed.success)
      return {
        status: 400 as const,
        body: {
          error: parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join('.') || 'server'}: ${issue.message}`,
            )
            .join(' '),
        },
      };
    if ((parsed.data.dotIds ?? []).some((dotId) => !workspace.dot(dotId)))
      return { status: 400 as const, body: { error: 'Unknown Dot.' } };
    try {
      return {
        status: id ? (200 as const) : (201 as const),
        body: publicServer(mcp.store.save(parsed.data, id)),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not save.';
      return {
        status: (message === 'MCP server not found.'
          ? 404
          : message.startsWith('Enter a value')
            ? 400
            : 409) as 400 | 404 | 409,
        body: { error: message },
      };
    }
  };
  app.post('/mcp/servers', async (c) => {
    const result = await save(await c.req.json());
    return c.json(result.body, result.status);
  });
  app.put('/mcp/servers/:id', async (c) => {
    const result = await save(await c.req.json(), c.req.param('id'));
    return c.json(result.body, result.status);
  });
  app.post('/mcp/servers/:id/test', async (c) => {
    if (!mcp.store.get(c.req.param('id')))
      return c.json({ error: 'MCP server not found.' }, 404);
    return c.json(
      publicServer(await mcp.test(c.req.param('id'), c.req.raw.signal)),
    );
  });
  app.delete('/mcp/servers/:id', (c) =>
    mcp.store.delete(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'MCP server not found.' }, 404),
  );
  return app;
}
