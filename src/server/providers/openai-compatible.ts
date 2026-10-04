import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type { ProviderStatus } from '../../shared/providers.js';
import { defaultMaxOutputTokens } from '../platform-config.js';
import type { ModelProvider, ModelTuning } from './types.js';
import { fetchModelList, ModelListCache } from './model-catalog.js';

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible' as const;
  constructor(
    private config: {
      apiKey?: string;
      model?: string;
      baseUrl?: string;
    } & ModelTuning,
  ) {}
  private catalog = new ModelListCache(
    this.id,
    (signal) => {
      if (!this.config.apiKey)
        throw new Error('Model provider setup required: OPENAI_API_KEY.');
      return fetchModelList(
        `${(this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`,
        {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
          signal,
        },
      );
    },
    () => (this.config.model ? [this.config.model] : []),
  );
  models(signal?: AbortSignal) {
    return this.catalog.get(signal);
  }
  contextWindow(model: string) {
    return this.catalog.contextWindow(model);
  }
  status(): ProviderStatus {
    const missing = [
      !this.config.apiKey && 'OPENAI_API_KEY',
      !this.config.model && 'OPENAI_MODEL',
    ].filter((item): item is string => !!item);
    return {
      id: this.id,
      label: 'OpenAI-compatible API key',
      kind: 'env',
      // A model chosen in Settings can stand in for OPENAI_MODEL.
      ready: !!this.config.apiKey,
      defaultModel: this.config.model || null,
      suggestedModels: this.config.model ? [this.config.model] : [],
      missing,
    };
  }
  createText(model: string) {
    if (!this.config.apiKey)
      throw new Error('Model provider setup required: OPENAI_API_KEY.');
    return {
      adapter: openaiCompatibleText(model, {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl ?? 'https://api.openai.com/v1',
        api: 'chat-completions',
        maxRetries: 1,
      }),
      modelOptions: {
        // Room for long page tool calls and hidden reasoning tokens.
        max_completion_tokens:
          this.config.maxOutputTokens ?? defaultMaxOutputTokens,
        ...(this.config.reasoningEffort
          ? { reasoning_effort: this.config.reasoningEffort }
          : {}),
      },
    };
  }
}
