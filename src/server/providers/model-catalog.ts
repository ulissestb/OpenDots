import type {
  ModelInfo,
  ProviderId,
  ProviderModels,
} from '../../shared/providers.js';

// Context windows and output limits copied from @tanstack/ai-openai 0.25.1
// model metadata, which the package does not export. Provider-reported
// values take precedence; unlisted models simply have no known window.
const known: Record<string, [contextWindow: number, maxOutput: number]> = {
  'gpt-6-sol': [1_050_000, 128_000],
  'gpt-6-luna': [1_050_000, 128_000],
  'gpt-5.6': [1_050_000, 128_000],
  'gpt-5.6-sol': [1_050_000, 128_000],
  'gpt-5.6-luna': [1_050_000, 128_000],
  'gpt-5.5': [1_050_000, 128_000],
  'gpt-5.5-pro': [1_050_000, 128_000],
  'gpt-5.4-mini': [400_000, 128_000],
  'gpt-5.4-nano': [400_000, 128_000],
  'gpt-5.2': [400_000, 128_000],
  'gpt-5.1': [400_000, 128_000],
  'gpt-5.1-codex': [400_000, 128_000],
  'gpt-5': [400_000, 128_000],
  'gpt-5-mini': [400_000, 128_000],
  'gpt-5-nano': [400_000, 128_000],
  'gpt-5-codex': [400_000, 128_000],
  'gpt-4.1': [1_047_576, 32_768],
  'gpt-4.1-mini': [1_047_576, 32_768],
  'gpt-4o': [128_000, 16_384],
  'gpt-4o-mini': [128_000, 16_384],
  o3: [200_000, 100_000],
  'o4-mini': [200_000, 100_000],
};
export function knownModel(id: string): ModelInfo {
  const entry = known[id] ?? known[id.replace(/^[\w-]+\//, '')];
  return entry
    ? { id, contextWindow: entry[0], maxOutputTokens: entry[1] }
    : { id };
}
// Ids the OpenAI /models list returns that cannot chat.
const nonChat =
  /embed|tts|whisper|dall-e|image|audio|realtime|moderation|sora|transcribe|search-preview|davinci|babbage|computer-use/i;
const positive = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
/** Parses the many /models shapes: OpenAI, OpenRouter, vLLM, and Codex. */
export function parseModelList(body: unknown): ModelInfo[] {
  const record = body as Record<string, unknown> | null;
  const items = Array.isArray(body)
    ? body
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const models = new Map<string, ModelInfo>();
  for (const raw of items as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const id = [raw.slug, raw.id, raw.model].find(
      (value): value is string => typeof value === 'string' && !!value,
    );
    if (!id || nonChat.test(id) || raw.visibility === 'hide') continue;
    const top = raw.top_provider as Record<string, unknown> | undefined;
    const fallback = knownModel(id);
    const label = [raw.display_name, raw.name].find(
      (value): value is string => typeof value === 'string' && value !== id,
    );
    const contextWindow =
      positive(raw.context_window) ??
      positive(raw.context_length) ??
      positive(raw.max_model_len) ??
      positive(top?.context_length) ??
      fallback.contextWindow;
    const maxOutputTokens =
      positive(top?.max_completion_tokens) ?? fallback.maxOutputTokens;
    models.set(id, {
      id,
      ...(label ? { label } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
/**
 * Caches one provider's model list. A failed or empty listing falls back to
 * the built-in table and is retried sooner than a successful one.
 */
export class ModelListCache {
  private cached?: { until: number; value: ProviderModels };
  constructor(
    private provider: ProviderId,
    private load: (signal: AbortSignal) => Promise<ModelInfo[]>,
    private fallback: () => string[],
    private ttlMs = 600_000,
  ) {}
  async get(signal?: AbortSignal): Promise<ProviderModels> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.value;
    let value: ProviderModels;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const models = await this.load(
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
      if (!models.length)
        throw new Error('The provider listed no chat models.');
      value = { provider: this.provider, models, source: 'provider' };
    } catch (error) {
      signal?.throwIfAborted();
      value = {
        provider: this.provider,
        models: this.fallback().map(knownModel),
        source: 'fallback',
        error:
          error instanceof ModelListError
            ? error.message
            : 'The provider model list could not be loaded.',
      };
    }
    this.cached = {
      until: Date.now() + (value.source === 'provider' ? this.ttlMs : 60_000),
      value,
    };
    return value;
  }
  /** The window from the last listing, else the built-in table. */
  contextWindow(model: string): number | undefined {
    return (
      this.cached?.value.models.find((item) => item.id === model)
        ?.contextWindow ?? knownModel(model).contextWindow
    );
  }
}
/** A user-facing reason the live list failed; never carries secrets. */
export class ModelListError extends Error {}
export async function fetchModelList(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const response = await fetcher(url, init);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ModelListError(
      `The provider model list returned HTTP ${response.status}.`,
    );
  }
  return parseModelList(await response.json().catch(() => null));
}
