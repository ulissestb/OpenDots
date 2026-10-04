import type { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type {
  ProviderId,
  ProviderModels,
  ProviderStatus,
} from '../../shared/providers.js';

// Typed through TanStack: @tanstack/ai-openai bundles its own `openai` version.
export type CompatConfig = Parameters<typeof openaiCompatibleText>[1];
export interface TextTarget {
  adapter: ReturnType<typeof openaiCompatibleText>;
  modelOptions: Record<string, unknown>;
}
export interface ModelProvider {
  id: ProviderId;
  status(): ProviderStatus;
  /** Throws a user-facing Error when the provider is not ready. */
  createText(model: string, context: { threadId: string }): TextTarget;
  /** Models this provider can run, listed live when possible. */
  models(signal?: AbortSignal): Promise<ProviderModels>;
  /** Known context window for a model, if any. */
  contextWindow(model: string): number | undefined;
}
/** Model tuning shared by providers; unset fields keep provider defaults. */
export interface ModelTuning {
  maxOutputTokens?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}
