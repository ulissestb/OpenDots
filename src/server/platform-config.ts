import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
import type { ProviderStatus } from '../shared/providers.js';
import type { Readiness } from './providers/registry.js';
export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  /** ChatGPT-subscription voice (unofficial): realtime model and voice. */
  voiceChatgptModel?: string;
  voiceChatgptVoice?: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  /** Bearer token the server uses to call its own runtime. */
  serviceToken?: string;
  /** Wall-clock budget for one agent turn (chat, Slack, or scheduled). */
  runTimeoutMs?: number;
  /** Output token cap for chat-completions models (MODEL_MAX_OUTPUT_TOKENS). */
  maxOutputTokens?: number;
  /** Reasoning effort for reasoning models (MODEL_REASONING_EFFORT); unset keeps the model default. */
  reasoningEffort?: ReasoningEffort;
}
export const defaultRunTimeoutMs = 300_000;
/** Parses AGENT_RUN_TIMEOUT_SECONDS, clamped to 30 s – 30 min. */
export function runTimeoutMs(value: string | undefined): number {
  const seconds = Number(value);
  if (!value?.trim() || !Number.isFinite(seconds)) return defaultRunTimeoutMs;
  return Math.min(1800, Math.max(30, Math.round(seconds))) * 1000;
}
export const defaultMaxOutputTokens = 16_000;
/** Parses MODEL_MAX_OUTPUT_TOKENS, clamped to 1,000 – 200,000. */
export function maxOutputTokens(value: string | undefined): number {
  const tokens = Number(value);
  if (!value?.trim() || !Number.isFinite(tokens)) return defaultMaxOutputTokens;
  return Math.min(200_000, Math.max(1000, Math.round(tokens)));
}
export const reasoningEfforts = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
/** Parses MODEL_REASONING_EFFORT; unset leaves the model's default. */
export function reasoningEffort(
  value: string | undefined,
): ReasoningEffort | undefined {
  const effort = value?.trim().toLowerCase();
  if (!effort) return undefined;
  if ((reasoningEfforts as readonly string[]).includes(effort))
    return effort as ReasoningEffort;
  throw new Error(
    'MODEL_REASONING_EFFORT must be minimal, low, medium, or high.',
  );
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
  model?: Readiness & { providers: ProviderStatus[] },
): SetupStatus {
  const modelMissing = model
    ? model.missing
    : [
        !config.apiKey && 'OPENAI_API_KEY',
        !config.model && 'OPENAI_MODEL',
      ].filter((item): item is string => !!item);
  // Intelligence is optional: without it, conversations are stored locally.
  const missing = [...modelMissing];
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    intelligence: !!config.intelligenceKey,
    model: model ? model.ready : !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    // Realtime voice runs on the ChatGPT sign-in, or on VOICE_API_KEY.
    voice:
      !missing.length &&
      !!(
        (config.voiceKey && config.voiceModel) ||
        model?.providers.some(
          (provider) => provider.id === 'openai-codex' && provider.ready,
        )
      ),
    slack,
    missing,
    ...(model
      ? {
          providers: model.providers,
          defaultProvider: { provider: model.provider, model: model.model },
        }
      : {}),
  };
}
