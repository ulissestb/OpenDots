import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { toolDefinition } from '@tanstack/ai';
import type { JSONSchema } from '@tanstack/ai';
import type { McpToolInfo } from '../shared/mcp.js';
import type { McpServerRecord, McpStore } from './mcp-store.js';

const listTtlMs = 5 * 60_000;
const connectTimeoutMs = 15_000;
const callTimeoutMs = 120_000;
const resultLimit = 40_000;
const descriptionLimit = 1_000;

interface LiveTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}
/** Builds a transport for a server; tests replace it with an in-memory pair. */
export type McpConnect = (
  server: McpServerRecord,
  kind: 'streamable' | 'sse',
) => Transport;

/** Bytes one MCP connection may receive; larger replies are refused. */
export const mcpResponseLimit = 16 * 1024 * 1024;
/**
 * fetch for MCP transports. Redirects are followed only within the server's
 * origin, so its header credentials never reach another host, and response
 * bodies are capped instead of being buffered without limit.
 */
export function guardedFetch(
  server: Pick<McpServerRecord, 'url' | 'headers'>,
  transport: typeof fetch = fetch,
  limit = mcpResponseLimit,
) {
  const origin = new URL(server.url).origin;
  return async (input: string | URL, init?: RequestInit) => {
    // The SDK passes a Headers instance, which object spread drops.
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(server.headers))
      headers.set(name, value);
    let url = new URL(String(input));
    let response: Response | undefined;
    for (let hop = 0; hop < 5; hop += 1) {
      response = await transport(url, {
        ...init,
        headers,
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status > 399 || !location) break;
      const next = new URL(location, url);
      if (next.origin !== origin)
        throw new Error(
          'The MCP server redirected to another address; update its URL.',
        );
      url = next;
    }
    if (!response?.body || [204, 205, 304].includes(response.status))
      return response!;
    let received = 0;
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > limit)
            controller.error(
              new Error('The MCP server response is too large.'),
            );
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(capped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
const defaultConnect: McpConnect = (server, kind) => {
  const guarded = guardedFetch(server);
  return kind === 'streamable'
    ? new StreamableHTTPClientTransport(new URL(server.url), {
        fetch: guarded,
      })
    : new SSEClientTransport(new URL(server.url), {
        fetch: guarded,
        // SSE opens with GET; EventSource takes its own fetch.
        eventSourceInit: { fetch: guarded },
      });
};
/** A tool name the model APIs accept: ^[A-Za-z0-9_-]{1,64}$. */
export function mcpToolName(server: string, tool: string, taken: Set<string>) {
  const base = `mcp_${server}_${tool}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64);
  let name = base;
  for (let index = 2; taken.has(name); index += 1)
    name = `${base.slice(0, 60)}_${index}`;
  taken.add(name);
  return name;
}
const toolInfo = (tool: LiveTool): McpToolInfo => ({
  name: tool.name,
  description: (tool.description ?? '').slice(0, descriptionLimit),
  ...(tool.annotations?.readOnlyHint !== undefined
    ? { readOnly: tool.annotations.readOnlyHint }
    : {}),
  ...(tool.annotations?.destructiveHint !== undefined
    ? { destructive: tool.annotations.destructiveHint }
    : {}),
});
/** Text of an MCP tool result; non-text parts become short markers. */
export function mcpResultText(result: Record<string, unknown>) {
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((part: { type?: string; text?: string; uri?: string }) =>
      part?.type === 'text'
        ? (part.text ?? '')
        : part?.type === 'resource_link' || part?.type === 'resource'
          ? `[resource ${part.uri ?? ''}]`
          : `[${part?.type ?? 'unknown'} content omitted]`,
    )
    .join('\n')
    .trim();
  const value =
    text ||
    // structuredContent (current spec) or toolResult (older servers).
    [result.structuredContent, result.toolResult]
      .filter((item) => item !== undefined)
      .map((item) => JSON.stringify(item))[0] ||
    '';
  return value.length > resultLimit
    ? `${value.slice(0, resultLimit)}\n…[truncated ${value.length - resultLimit} characters]`
    : value;
}

/**
 * Connects Dots to the owner's remote MCP servers. Only remote (HTTP) servers
 * are supported: stdio servers would run commands on the host.
 */
export class McpService {
  private lists = new Map<string, { until: number; tools: LiveTool[] }>();
  constructor(
    readonly store: McpStore,
    private connectTransport: McpConnect = defaultConnect,
  ) {}
  private async connect(server: McpServerRecord, signal?: AbortSignal) {
    const failures: string[] = [];
    for (const kind of ['streamable', 'sse'] as const) {
      const client = new Client({ name: 'opendots', version: '0.1.0' });
      try {
        await client.connect(this.connectTransport(server, kind), {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(connectTimeoutMs)])
            : AbortSignal.timeout(connectTimeoutMs),
          timeout: connectTimeoutMs,
        });
        return client;
      } catch (error) {
        failures.push(
          `${kind === 'sse' ? 'SSE' : 'Streamable HTTP'}: ${error instanceof Error ? error.message : 'failed'}`,
        );
        await client.close().catch(() => undefined);
        signal?.throwIfAborted();
      }
    }
    throw new Error(failures.join('; '));
  }
  private async listTools(client: Client, signal?: AbortSignal) {
    const tools: LiveTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: connectTimeoutMs,
      });
      tools.push(...(page.tools as LiveTool[]));
      cursor = page.nextCursor;
      // A server that repeats a cursor would otherwise page forever.
      if (cursor && seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    } while (cursor && tools.length < 1000 && seen.size < 50);
    return tools;
  }
  /** Connects, lists tools, and stores them for the owner to review. */
  async test(id: string, signal?: AbortSignal) {
    const server = this.store.get(id);
    if (!server) throw new Error('MCP server not found.');
    let client: Client | undefined;
    try {
      client = await this.connect(server, signal);
      const tools = await this.listTools(client, signal);
      this.lists.set(`${server.id}@${server.updatedAt}`, {
        until: Date.now() + listTtlMs,
        tools,
      });
      return this.store.recordTest(
        id,
        { tools: tools.map(toolInfo) },
        server.updatedAt,
      );
    } catch (error) {
      signal?.throwIfAborted();
      return this.store.recordTest(
        id,
        { error: safeMessage(error) },
        server.updatedAt,
      );
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
  /**
   * Tools for one run of one Dot: the live list, limited to tools the owner
   * reviewed (and allowed). Servers that fail are skipped and reported.
   * Call close() when the run ends.
   */
  async toolsFor(
    dotId: string,
    signal: AbortSignal,
    check: () => void,
    /** Dots that must also have each server (a delegated run's delegators). */
    sharedWith: string[] = [],
  ) {
    const shared = sharedWith.map(
      (id) => new Set(this.store.forDot(id).map((server) => server.id)),
    );
    const clients = new Map<string, Promise<Client>>();
    const client = (server: McpServerRecord) => {
      let pending = clients.get(server.id);
      if (!pending) {
        pending = this.connect(server, signal);
        // A failed connection is retried on the next call.
        pending.catch(() => clients.delete(server.id));
        clients.set(server.id, pending);
      }
      return pending;
    };
    const close = async () => {
      await Promise.all(
        [...clients.values()].map((pending) =>
          pending.then((item) => item.close()).catch(() => undefined),
        ),
      );
    };
    const unavailable: string[] = [];
    const tools = [];
    const taken = new Set<string>();
    // An abort while listing must not leave the opened connections behind.
    signal.addEventListener('abort', () => void close(), { once: true });
    for (const server of this.store
      .forDot(dotId)
      .filter((item) => shared.every((ids) => ids.has(item.id)))) {
      const reviewed = new Set(
        server.allowedTools ?? server.tools.map((tool) => tool.name),
      );
      if (!reviewed.size) {
        unavailable.push(`${server.name} (not tested yet)`);
        continue;
      }
      let live: LiveTool[];
      try {
        const cached = this.lists.get(`${server.id}@${server.updatedAt}`);
        if (cached && cached.until > Date.now()) live = cached.tools;
        else {
          live = await this.listTools(await client(server), signal);
          this.lists.set(`${server.id}@${server.updatedAt}`, {
            until: Date.now() + listTtlMs,
            tools: live,
          });
        }
      } catch (error) {
        signal.throwIfAborted();
        unavailable.push(`${server.name} (${safeMessage(error)})`);
        continue;
      }
      for (const tool of live.filter((item) => reviewed.has(item.name))) {
        const schema = (
          tool.inputSchema?.type === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} }
        ) as JSONSchema;
        tools.push(
          toolDefinition({
            name: mcpToolName(server.name, tool.name, taken),
            description: `[MCP ${server.name}] ${(tool.description ?? tool.name).slice(0, descriptionLimit)}`,
            inputSchema: schema,
          }).server(async (input) => {
            check();
            const result = await (
              await client(server)
            ).callTool(
              {
                name: tool.name,
                arguments: (input ?? {}) as Record<string, unknown>,
              },
              undefined,
              { signal, timeout: callTimeoutMs },
            );
            check();
            const text = mcpResultText(result);
            if (result.isError)
              throw new Error(text || `${tool.name} reported an error.`);
            return text || '(no output)';
          }),
        );
      }
    }
    return {
      tools,
      unavailable,
      close,
    };
  }
}
/** A short failure reason that cannot echo header values back. */
function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : 'Connection failed.';
  return message.replace(/(bearer|token|key)\s+\S+/gi, '$1 …').slice(0, 300);
}
