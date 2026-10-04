import type { ProviderId, ProviderStatus } from '../../shared/providers.js';
import type { Dot, Settings } from '../../shared/types.js';
import type { CodexAuth } from './codex-auth.js';
import { OpenAICodexProvider } from './openai-codex.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ModelProvider, ModelTuning } from './types.js';

type Choice = Pick<Dot, 'provider' | 'model'> | undefined;
export interface Readiness {
  ready: boolean;
  missing: string[];
  provider: ProviderId | null;
  model: string | null;
}
export class ProviderRegistry {
  constructor(private providers: ModelProvider[]) {}
  static fromConfig(
    config: {
      apiKey?: string;
      model?: string;
      baseUrl?: string;
    } & ModelTuning,
    codex?: CodexAuth,
    codexModel?: string,
  ) {
    return new ProviderRegistry([
      new OpenAICompatibleProvider(config),
      new OpenAICodexProvider(codex, codexModel || undefined, undefined, {
        reasoningEffort: config.reasoningEffort,
      }),
    ]);
  }
  statuses(): ProviderStatus[] {
    return this.providers.map((provider) => provider.status());
  }
  private choose(settings: Settings, dot?: Choice) {
    const statuses = this.statuses();
    const status = (id: ProviderId) => statuses.find((item) => item.id === id)!;
    const id =
      dot?.provider ??
      settings.modelProvider ??
      // Automatic: the first provider that can run, else the API-key default.
      statuses.find((item) => item.ready && this.model(item, settings, dot))
        ?.id ??
      'openai-compatible';
    return { status: status(id), model: this.model(status(id), settings, dot) };
  }
  private model(status: ProviderStatus, settings: Settings, dot?: Choice) {
    const global =
      !settings.modelProvider || settings.modelProvider === status.id
        ? settings.model
        : undefined;
    const own =
      !dot?.provider || dot.provider === status.id ? dot?.model : undefined;
    return own || global || status.defaultModel || null;
  }
  readiness(settings: Settings, dot?: Choice): Readiness {
    const { status, model } = this.choose(settings, dot);
    const missing =
      status.ready && model
        ? []
        : status.missing.length
          ? status.missing
          : ['a model name'];
    return { ready: !missing.length, missing, provider: status.id, model };
  }
  provider(id: ProviderId): ModelProvider | undefined {
    return this.providers.find((item) => item.id === id);
  }
  /** The provider and model for a run; throws a user-facing Error when unavailable. */
  resolve(settings: Settings, dot?: Choice) {
    const result = this.readiness(settings, dot);
    if (!result.ready || !result.model)
      throw new Error(
        `Model provider setup required: ${result.missing.join(', ')}.`,
      );
    const provider = this.providers.find(
      (item) => item.id === result.provider,
    )!;
    return { provider, model: result.model };
  }
}
