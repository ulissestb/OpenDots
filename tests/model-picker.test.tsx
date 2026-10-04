import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  ModelProviderFields,
  modelOptions,
} from '../src/client/ModelProviderFields';
import { formatTokens, usageSummary } from '../src/client/ui-helpers';
import type { ProviderStatus } from '../src/shared/providers';

const providers: ProviderStatus[] = [
  {
    id: 'openai-codex',
    label: 'ChatGPT',
    kind: 'oauth',
    ready: true,
    defaultModel: 'gpt-5.5',
    suggestedModels: ['gpt-5.5'],
    missing: [],
  },
];
const picker = (model: string) =>
  renderToStaticMarkup(
    <ModelProviderFields
      providers={providers}
      provider=""
      model={model}
      onProvider={() => undefined}
      onModel={() => undefined}
      inheritLabel="Workspace default"
      inheritProvider="openai-codex"
      inheritModel="gpt-6-sol"
      initialCatalog={{
        provider: 'openai-codex',
        source: 'provider',
        models: [
          { id: 'gpt-5.5', contextWindow: 1_050_000 },
          { id: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 1_050_000 },
        ],
      }}
    />,
  );

it('lists the provider models with their context windows', () => {
  const html = picker('');
  expect(html).toContain('<select id="model-name"');
  expect(html).toContain('gpt-5.5 — 1.05M context');
  expect(html).toContain('Default (GPT-6 Sol — 1.05M context)');
  expect(html).toContain('2 models listed by the provider.');
  expect(html).not.toContain('datalist');
});

it('keeps a saved model that the provider no longer lists', () => {
  expect(picker('my-finetune')).toContain('value="my-finetune"');
  expect(modelOptions([{ id: 'a' }], 'a')).toEqual([{ id: 'a' }]);
});

it('formats token counts and the usage line', () => {
  expect(formatTokens(1_050_000)).toBe('1.05M');
  expect(formatTokens(400_000)).toBe('400k');
  expect(formatTokens(12_345)).toBe('12.3k');
  expect(formatTokens(950)).toBe('950');
  const base = {
    provider: 'openai-codex' as const,
    model: 'gpt-5.5',
    contextWindow: 1_050_000,
    contextTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    calls: 0,
    updatedAt: null,
  };
  expect(usageSummary(base)).toBe('gpt-5.5 · 1.05M context');
  expect(
    usageSummary({
      ...base,
      contextTokens: 12_300,
      inputTokens: 40_000,
      outputTokens: 5_000,
      calls: 3,
    }),
  ).toBe('gpt-5.5 · 12.3k / 1.05M context (1%) · 45k tokens used');
  expect(
    usageSummary({
      ...base,
      contextWindow: null,
      contextTokens: 500,
      calls: 1,
    }),
  ).toBe('gpt-5.5 · 500 context · 0 tokens used');
});
