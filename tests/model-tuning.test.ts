import { describe, expect, it } from 'vitest';
import {
  maxOutputTokens,
  reasoningEffort,
} from '../src/server/platform-config.js';
import { OpenAICompatibleProvider } from '../src/server/providers/openai-compatible.js';

describe('model tuning config', () => {
  it('defaults the output cap to 16,000 and clamps overrides', () => {
    expect(maxOutputTokens(undefined)).toBe(16_000);
    expect(maxOutputTokens('')).toBe(16_000);
    expect(maxOutputTokens('abc')).toBe(16_000);
    expect(maxOutputTokens('32000')).toBe(32_000);
    expect(maxOutputTokens('10')).toBe(1000);
  });
  it('accepts only known reasoning efforts and leaves unset as default', () => {
    expect(reasoningEffort(undefined)).toBeUndefined();
    expect(reasoningEffort(' ')).toBeUndefined();
    expect(reasoningEffort('High')).toBe('high');
    expect(reasoningEffort('minimal')).toBe('minimal');
    expect(() => reasoningEffort('max')).toThrow('MODEL_REASONING_EFFORT');
  });
  it('maps tuning onto chat-completions options', () => {
    const base = { apiKey: 'key', model: 'm' };
    expect(
      new OpenAICompatibleProvider(base).createText('m').modelOptions,
    ).toEqual({ max_completion_tokens: 16_000 });
    expect(
      new OpenAICompatibleProvider({
        ...base,
        maxOutputTokens: 32_000,
        reasoningEffort: 'low',
      }).createText('m').modelOptions,
    ).toEqual({ max_completion_tokens: 32_000, reasoning_effort: 'low' });
  });
});
