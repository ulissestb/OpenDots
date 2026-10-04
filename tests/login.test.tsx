import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChangePasswordScreen, LoginScreen } from '../src/client/Login';
import {
  CodexConnect,
  ModelProviderFields,
} from '../src/client/ModelProviderFields';
import type { ProviderStatus } from '../src/shared/providers';
it('asks for a username and password', () => {
  const html = renderToStaticMarkup(<LoginScreen onSignedIn={() => {}} />);
  expect(html).toContain('autoComplete="username"');
  expect(html).toContain('current-password');
  expect(html).toContain('Sign in');
});
it('explains a forced password change and offers sign-out', () => {
  const html = renderToStaticMarkup(
    <ChangePasswordScreen
      username="admin"
      forced
      onChanged={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(html).toContain('initial password');
  expect(html).toContain('new-password');
  expect(html).toContain('Sign out');
});
const codex: ProviderStatus = {
  id: 'openai-codex',
  label: 'ChatGPT Plus/Pro (subscription sign-in, unofficial)',
  kind: 'oauth',
  ready: false,
  defaultModel: 'gpt-5.5',
  suggestedModels: ['gpt-5.5'],
  state: 'not_connected',
  missing: ['ChatGPT sign-in'],
  disclaimer: 'Unofficial sign-in.',
};
it('labels providers that are not ready and suggests models', () => {
  const html = renderToStaticMarkup(
    <ModelProviderFields
      providers={[codex]}
      provider="openai-codex"
      model=""
      onProvider={() => {}}
      onModel={() => {}}
      inheritLabel="Workspace default"
    />,
  );
  expect(html).toContain('not ready');
  expect(html).toContain('Default (gpt-5.5');
  expect(html).toContain('ChatGPT sign-in');
});
it('offers ChatGPT sign-in with its disclaimer, or the connected account', () => {
  expect(renderToStaticMarkup(<CodexConnect status={codex} />)).toContain(
    'Sign in with ChatGPT',
  );
  const connected = renderToStaticMarkup(
    <CodexConnect
      status={{
        ...codex,
        ready: true,
        state: 'connected',
        account: { email: 'me@example.com', plan: 'plus' },
      }}
    />,
  );
  expect(connected).toContain('me@example.com · plus');
  expect(connected).toContain('Disconnect');
  expect(connected).toContain('Unofficial sign-in.');
});
