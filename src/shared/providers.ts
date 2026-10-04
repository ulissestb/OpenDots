import { z } from 'zod';

export const providerIds = ['openai-compatible', 'openai-codex'] as const;
export type ProviderId = (typeof providerIds)[number];
export const providerIdSchema = z.enum(providerIds);
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w.:/-]+$/);
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  ready: boolean;
  /** env: configured in the server environment; oauth: signed in from Settings. */
  kind: 'env' | 'oauth';
  defaultModel: string | null;
  suggestedModels: string[];
  account?: { email?: string; plan?: string } | null;
  state?: 'not_connected' | 'connected' | 'needs_reauth';
  missing: string[];
  disclaimer?: string;
}
export interface DeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  interval: number;
}
export type DeviceFlowStatus =
  'pending' | 'complete' | 'error' | 'expired' | 'cancelled';
export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}
export interface ProviderModels {
  provider: ProviderId;
  models: ModelInfo[];
  /** provider: listed live by the provider; fallback: the built-in table. */
  source: 'provider' | 'fallback';
  error?: string;
}
/** Token use of one conversation, as reported by the model provider. */
export interface ConversationUsage {
  provider: ProviderId | null;
  model: string | null;
  contextWindow: number | null;
  /** Prompt + completion of the latest model call: what the next call carries. */
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  /** Model calls counted, several per tool-using turn. */
  calls: number;
  updatedAt: number | null;
}
