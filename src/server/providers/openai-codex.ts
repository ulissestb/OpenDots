import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type { ProviderStatus } from '../../shared/providers.js';
import { CodexReauthError, type CodexAuth } from './codex-auth.js';
import type { ModelProvider, ModelTuning } from './types.js';
import {
  fetchModelList,
  ModelListCache,
  ModelListError,
} from './model-catalog.js';

export const codexBaseUrl = 'https://chatgpt.com/backend-api/codex';
// Mirrors hermes-agent's Codex model list; the backend changes it without notice.
const suggestedModels = [
  'gpt-5.5',
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.4',
  'gpt-5.4-mini',
];
// The ChatGPT backend accepts a narrower request than the public Responses API.
const allowedFields = new Set([
  'model',
  'instructions',
  'input',
  'tools',
  'store',
  'stream',
  'reasoning',
  'include',
  'text',
  'tool_choice',
  'parallel_tool_calls',
  'prompt_cache_key',
]);
const defaultInstructions = 'You are a helpful assistant.';
type Item = Record<string, unknown>;
/** Rewrites a Responses API body into the shape the Codex backend accepts. */
export function normalizeCodexBody(
  body: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body))
    if (allowedFields.has(key)) result[key] = value;
  result.store = false;
  result.stream = true;
  if (typeof result.instructions !== 'string' || !result.instructions.trim())
    result.instructions = defaultInstructions;
  result.include = [
    ...new Set([
      ...(Array.isArray(result.include) ? (result.include as string[]) : []),
      'reasoning.encrypted_content',
    ]),
  ];
  result.prompt_cache_key ??= sessionId;
  if (Array.isArray(result.input))
    // With store=false the backend cannot resolve item ids from earlier
    // responses, and reasoning is only replayable through encrypted content.
    result.input = (result.input as Item[])
      .filter(
        (item) =>
          item.type !== 'reasoning' ||
          typeof item.encrypted_content === 'string',
      )
      .map((item) => {
        if (typeof item !== 'object' || !item || !('id' in item)) return item;
        const rest = { ...item };
        delete rest.id;
        return rest;
      });
  return result;
}
/**
 * The Codex backend streams each output item but sends `response.completed`
 * with an empty `output` (store=false). TanStack reads that array to decide
 * whether to run tools, so refill it from the streamed `output_item.done` items.
 */
export function completedOutput(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const items: { index: number; item: unknown }[] = [];
  let buffer = '';
  const rewrite = (block: string) => {
    const lines = block.split('\n');
    const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
    if (dataIndex < 0) return block;
    let event: {
      type?: string;
      output_index?: number;
      item?: unknown;
      response?: { output?: unknown[] };
    };
    try {
      event = JSON.parse(lines[dataIndex].slice(5).trim());
    } catch {
      return block;
    }
    if (event.type === 'response.output_item.done' && event.item)
      items.push({
        index: event.output_index ?? items.length,
        item: event.item,
      });
    if (
      event.type === 'response.completed' &&
      event.response &&
      !event.response.output?.length &&
      items.length
    ) {
      event.response.output = [...items]
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.item);
      lines[dataIndex] = `data: ${JSON.stringify(event)}`;
      return lines.join('\n');
    }
    return block;
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        controller.enqueue(
          encoder.encode(`${rewrite(buffer.slice(0, end))}\n\n`),
        );
        buffer = buffer.slice(end + 2);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  });
}
/** A non-retryable error response whose message the SDK surfaces as-is. */
function codexError(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'x-should-retry': 'false' },
  });
}
function waitText(seconds: number) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}
async function usageLimitMessage(response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { resets_in_seconds?: unknown; resets_at?: unknown };
  };
  const resetsAt = Number(body.error?.resets_at);
  const seconds = [
    Number(body.error?.resets_in_seconds),
    resetsAt - Date.now() / 1000,
    Number(response.headers.get('retry-after')),
  ].find((value) => Number.isFinite(value) && value > 0);
  return `ChatGPT usage limit reached${
    seconds ? `; retry after ${waitText(seconds)}` : '; retry later'
  }.`;
}
export function codexFetch(
  auth: CodexAuth,
  sessionId: string,
  userAgent: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const isResponses = new URL(url).pathname.endsWith('/responses');
    let body = init?.body;
    if (typeof body === 'string' && isResponses)
      body = JSON.stringify(
        normalizeCodexBody(
          JSON.parse(body) as Record<string, unknown>,
          sessionId,
        ),
      );
    const send = async (force: boolean) => {
      const { token, accountId } = await auth.accessToken({ force });
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      if (accountId) headers.set('ChatGPT-Account-ID', accountId);
      headers.set('originator', 'opendots');
      headers.set('User-Agent', userAgent);
      headers.set('session_id', sessionId);
      return fetch(input, { ...init, headers, body });
    };
    let response: Response;
    try {
      response = await send(false);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        response = await send(true);
      }
    } catch (error) {
      // Errors thrown inside a custom fetch become a generic, retried
      // "Connection error." in the OpenAI SDK; answer with an HTTP error instead.
      if (error instanceof CodexReauthError)
        return codexError(401, error.message);
      if (error instanceof Error && error.message.startsWith('ChatGPT'))
        return codexError(502, error.message);
      throw error;
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      return codexError(401, new CodexReauthError().message);
    }
    if (response.status === 429)
      return codexError(429, await usageLimitMessage(response));
    // The backend streams SSE without a content-type header.
    return response.ok && response.body && isResponses
      ? new Response(response.body.pipeThrough(completedOutput()), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      : response;
  };
}
export class OpenAICodexProvider implements ModelProvider {
  readonly id = 'openai-codex' as const;
  constructor(
    private auth: CodexAuth | undefined,
    private defaultModel = 'gpt-5.5',
    private userAgent = `opendots/0.1.0 (node ${process.version})`,
    private tuning: ModelTuning = {},
  ) {}
  // Unverified: the Codex CLI lists models at {base}/models?client_version=.
  // The backend may hide models from older clients, so a high version is sent;
  // any failure falls back to the built-in list and says so in Settings.
  private catalog = new ModelListCache(
    this.id,
    (signal) => {
      if (!this.auth || this.auth.credential()?.state !== 'connected')
        throw new ModelListError('Sign in with ChatGPT to list its models.');
      return fetchModelList(
        `${codexBaseUrl}/models?client_version=99.0.0`,
        { signal },
        codexFetch(this.auth, 'models', this.userAgent),
      );
    },
    () => [...new Set([this.defaultModel, ...suggestedModels])],
  );
  models(signal?: AbortSignal) {
    return this.catalog.get(signal);
  }
  contextWindow(model: string) {
    return this.catalog.contextWindow(model);
  }
  status(): ProviderStatus {
    const credential = this.auth?.credential();
    const state = !credential
      ? 'not_connected'
      : credential.state === 'connected'
        ? 'connected'
        : 'needs_reauth';
    return {
      id: this.id,
      label: 'ChatGPT Plus/Pro (subscription sign-in, unofficial)',
      kind: 'oauth',
      ready: state === 'connected',
      defaultModel: this.defaultModel,
      suggestedModels,
      account: credential
        ? {
            ...(credential.email ? { email: credential.email } : {}),
            ...(credential.plan ? { plan: credential.plan } : {}),
          }
        : null,
      state,
      missing: state === 'connected' ? [] : ['ChatGPT sign-in'],
      disclaimer:
        "Uses your ChatGPT subscription through the Codex CLI's unofficial sign-in. OpenAI may not permit this for third-party apps; use it at your own risk. Tokens stay on this server.",
    };
  }
  createText(model: string, context: { threadId: string }) {
    if (!this.auth || this.auth.credential()?.state !== 'connected')
      throw new CodexReauthError();
    return {
      adapter: openaiCompatibleText(model, {
        // Replaced per request by codexFetch with the OAuth access token.
        apiKey: 'chatgpt-oauth',
        baseURL: codexBaseUrl,
        api: 'responses',
        maxRetries: 1,
        fetch: codexFetch(this.auth, context.threadId, this.userAgent),
      }),
      // The Codex backend rejects output token limits, so none is sent.
      modelOptions: this.tuning.reasoningEffort
        ? {
            reasoning: { effort: this.tuning.reasoningEffort, summary: 'auto' },
          }
        : {},
    };
  }
}
