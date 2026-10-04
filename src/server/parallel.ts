import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

export type WebSearchProvider = 'parallel' | 'browser' | 'disabled';
export interface WebConfig {
  webSearchProvider?: WebSearchProvider;
  parallelApiKey?: string;
}
export function webSearchProvider(value?: string): WebSearchProvider {
  if (!value) return 'parallel';
  if (value === 'parallel' || value === 'browser' || value === 'disabled')
    return value;
  throw new Error(
    'WEB_SEARCH_PROVIDER must be parallel, browser, or disabled.',
  );
}
const source = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    }),
  title: z.string().nullable().optional(),
  excerpts: z.array(z.string()).default([]),
});
export interface WebSource {
  title: string;
  url: string;
  text: string;
}
/** Sources read per call; with the excerpt cap this keeps a result near 36k chars. */
export const maxSources = 8;
const maxExcerptChars = 4500;
const maxFetchObjective = 200;
/** Shortens an objective at a word boundary for web_fetch's 200-char limit. */
export function shortObjective(objective: string, limit = maxFetchObjective) {
  const text = objective.replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
export function sourcesFromResult(
  result: unknown,
  warn: (message: string) => void = () => {},
  limit = maxSources,
): WebSource[] {
  const envelope = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    })
    .parse(result);
  if (envelope.isError)
    throw new Error(
      'Parallel could not complete the web request. Retry later or check the provider quota.',
    );
  let data = envelope.structuredContent;
  if (!data) {
    const text = envelope.content?.find((item) => item.type === 'text')?.text;
    try {
      data = JSON.parse(text ?? '');
    } catch {
      throw new Error('Parallel returned an invalid response.');
    }
  }
  const parsed = z
    .object({
      results: z.array(z.unknown()),
      errors: z.array(z.unknown()).optional(),
      warnings: z.array(z.unknown()).nullable().optional(),
    })
    .parse(data);
  if (parsed.errors?.length)
    warn(
      `The provider reported ${parsed.errors.length} source extraction error(s); coverage is incomplete.`,
    );
  if (parsed.warnings?.length)
    warn(
      'The provider returned warnings; some source evidence may be incomplete.',
    );
  let discarded = 0;
  const seen = new Set<string>();
  const sources = parsed.results
    .flatMap((item) => {
      const parsedSource = source.safeParse(item);
      if (!parsedSource.success) {
        discarded++;
        return [];
      }
      const value = parsedSource.data;
      if (seen.has(value.url)) return [];
      if (!value.excerpts.some((text) => text.trim())) {
        discarded++;
        return [];
      }
      seen.add(value.url);
      return [
        {
          title: value.title || value.url,
          url: value.url,
          text: value.excerpts.join('\n').slice(0, maxExcerptChars),
        },
      ];
    })
    .slice(0, limit);
  if (discarded)
    warn(
      `Skipped ${discarded} malformed or empty source result(s); coverage is incomplete.`,
    );
  return sources;
}
export async function parallelSources(
  request: {
    objective: string;
    urls?: string[];
    sessionId?: string;
    searchQueries?: string[];
    onWarning?: (message: string) => void;
  },
  config: WebConfig,
  signal: AbortSignal,
): Promise<WebSource[]> {
  signal.throwIfAborted();
  if ((config.webSearchProvider ?? 'parallel') !== 'parallel')
    throw new Error('Parallel web research is disabled.');
  const client = new Client({ name: 'opendots', version: '0.1.0' });
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const transport = new StreamableHTTPClientTransport(
    new URL('https://search.parallel.ai/mcp'),
    {
      requestInit: config.parallelApiKey
        ? { headers: { Authorization: `Bearer ${config.parallelApiKey}` } }
        : undefined,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.any([
            boundedSignal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    },
  );
  const session_id = request.sessionId ?? randomUUID();
  // Send only the requested research objective and URLs, never memories or the full transcript.
  const objective = request.objective;
  const search_queries = request.searchQueries ?? [objective];
  const warn = request.onWarning ?? (() => {});
  try {
    await client.connect(transport);
    let urls = request.urls;
    let found: WebSource[] = [];
    if (!urls?.length) {
      found = sourcesFromResult(
        await client.callTool(
          {
            name: 'web_search',
            arguments: { objective, search_queries, session_id },
          },
          undefined,
          { signal: boundedSignal },
        ),
        warn,
      );
      urls = found.map((page) => page.url);
      if (!urls.length)
        throw new Error(
          'Parallel found no usable sources. Try a more specific research request.',
        );
    }
    for (const url of urls) source.shape.url.parse(url);
    let pages: WebSource[];
    try {
      pages = sourcesFromResult(
        await client.callTool(
          {
            name: 'web_fetch',
            arguments: {
              urls: urls.slice(0, maxSources),
              // Keep the start of a long objective rather than a generic one.
              objective: shortObjective(objective),
              search_queries,
              session_id,
            },
          },
          undefined,
          { signal: boundedSignal },
        ),
        warn,
      );
      if (!pages.length)
        throw new Error('Parallel could not extract usable source evidence.');
    } catch (error) {
      // Search excerpts still ground an answer when full extraction fails.
      if (boundedSignal.aborted || !found.length) throw error;
      warn(
        'Full page extraction failed, so these are shorter search excerpts; verify key claims with read_public_page.',
      );
      return found;
    }
    if (urls.length > maxSources)
      warn(`Only the first ${maxSources} URLs were read; coverage is limited.`);
    if (pages.length < Math.min(urls.length, maxSources))
      warn('Some requested sources could not be read; coverage is incomplete.');
    boundedSignal.throwIfAborted();
    return pages;
  } finally {
    await client.close().catch(() => {});
  }
}
