import { useEffect, useState } from 'react';
import type {
  DeviceFlowStart,
  DeviceFlowStatus,
  ModelInfo,
  ProviderId,
  ProviderModels,
  ProviderStatus,
} from '../shared/providers';
import { api } from './api';
import { formatTokens } from './ui-helpers';

const customModel = '__custom';

/** Options for the model select: the listed models plus the saved choice. */
export function modelOptions(listed: ModelInfo[], saved: string): ModelInfo[] {
  return saved && !listed.some((item) => item.id === saved)
    ? [{ id: saved }, ...listed]
    : listed;
}
const describe = (item: ModelInfo) =>
  `${item.label ?? item.id}${item.contextWindow ? ` — ${formatTokens(item.contextWindow)} context` : ''}`;

/** Provider and model choice, shared by workspace Settings and each Dot. */
export function ModelProviderFields({
  providers,
  provider,
  model,
  onProvider,
  onModel,
  inheritLabel,
  inheritProvider,
  inheritModel,
  initialCatalog,
}: {
  providers: ProviderStatus[];
  provider: ProviderId | '';
  model: string;
  onProvider: (value: ProviderId | '') => void;
  onModel: (value: string) => void;
  inheritLabel: string;
  /** The provider an inherited choice resolves to, so its models can be listed. */
  inheritProvider?: ProviderId | null;
  /** The model an empty choice resolves to, when it differs from the provider's. */
  inheritModel?: string | null;
  /** Server-render and test seed; normally fetched. */
  initialCatalog?: ProviderModels;
}) {
  const selected = providers.find((item) => item.id === provider);
  const listedProvider = provider || inheritProvider || '';
  const listedStatus = providers.find((item) => item.id === listedProvider);
  const [catalog, setCatalog] = useState(initialCatalog);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    if (!listedProvider) return;
    let active = true;
    api<ProviderModels>(`/providers/${listedProvider}/models`)
      .then((value) => active && setCatalog(value))
      .catch(() => active && setCatalog(undefined));
    return () => {
      active = false;
    };
  }, [listedProvider]);
  const current = catalog?.provider === listedProvider ? catalog : undefined;
  const listed =
    current?.models ??
    (listedStatus?.suggestedModels ?? []).map((id) => ({ id }));
  const options = modelOptions(listed, custom ? '' : model);
  const defaultModel =
    (!provider && inheritModel) || listedStatus?.defaultModel;
  const defaultInfo = listed.find((item) => item.id === defaultModel);
  return (
    <>
      <label className="field-label" htmlFor="model-provider">
        Provider
      </label>
      <select
        id="model-provider"
        value={provider}
        onChange={(event) => {
          setCustom(false);
          onProvider(event.target.value as ProviderId | '');
        }}
      >
        <option value="">{inheritLabel}</option>
        {providers.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
            {item.ready ? '' : ' — not ready'}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="model-name">
        Model
      </label>
      <select
        id="model-name"
        value={custom ? customModel : model}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === customModel);
          if (value !== customModel) onModel(value);
        }}
      >
        <option value="">
          {defaultModel
            ? `Default (${defaultInfo ? describe(defaultInfo) : defaultModel})`
            : 'Provider default'}
        </option>
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {describe(item)}
          </option>
        ))}
        <option value={customModel}>Custom model…</option>
      </select>
      {custom && (
        <input
          id="model-custom"
          aria-label="Custom model name"
          value={model}
          maxLength={100}
          pattern="[\w.:/\-]+"
          placeholder="Exact model id, e.g. gpt-5.5"
          onChange={(event) => onModel(event.target.value)}
        />
      )}
      {listedProvider && (
        <small className="model-source">
          {!current
            ? 'Loading models…'
            : current.source === 'provider'
              ? `${current.models.length} models listed by the provider.`
              : `Built-in list (the provider list is unavailable${current.error ? `: ${current.error}` : ''}).`}
        </small>
      )}
      {selected && !selected.ready && (
        <p className="chat-error">
          {selected.label} is not ready: {selected.missing.join(', ')}.
        </p>
      )}
    </>
  );
}

/** ChatGPT subscription sign-in through the Codex device flow. */
export function CodexConnect({ status }: { status?: ProviderStatus }) {
  const [flow, setFlow] = useState<DeviceFlowStart>();
  const [flowStatus, setFlowStatus] = useState<DeviceFlowStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!flow) return;
    let active = true;
    const timer = setInterval(() => {
      api<{ status: DeviceFlowStatus; error?: string }>(
        `/providers/openai-codex/device/${flow.flowId}`,
      )
        .then((result) => {
          if (!active) return;
          setFlowStatus(result.status);
          if (result.status === 'pending') return;
          setFlow(undefined);
          if (result.status !== 'complete')
            setError(result.error ?? `Sign-in ${result.status}.`);
        })
        .catch((e) => active && setError(e.message));
    }, flow.interval * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [flow]);
  if (!status) return null;
  const start = async () => {
    setBusy(true);
    setError('');
    setFlowStatus(undefined);
    try {
      setFlow(
        await api<DeviceFlowStart>(
          '/providers/openai-codex/device',
          'POST',
          {},
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start sign-in.');
    } finally {
      setBusy(false);
    }
  };
  const account = [status.account?.email, status.account?.plan]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="config-note">
      <strong>ChatGPT subscription</strong>
      <p>{status.disclaimer}</p>
      {flow ? (
        <>
          <p>
            Open{' '}
            <a href={flow.verificationUrl} target="_blank" rel="noreferrer">
              {flow.verificationUrl.replace('https://', '')} ↗
            </a>{' '}
            and enter this code:
          </p>
          <p>
            <code className="device-code">{flow.userCode}</code>{' '}
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(flow.userCode)}
            >
              Copy
            </button>
          </p>
          <p className="muted">Waiting for you to approve the sign-in…</p>
          <button
            type="button"
            onClick={() => {
              void api(
                `/providers/openai-codex/device/${flow.flowId}`,
                'DELETE',
              ).catch(() => {});
              setFlow(undefined);
            }}
          >
            Cancel
          </button>
        </>
      ) : status.state === 'connected' ? (
        <>
          <p>
            Connected{account ? ` as ${account}` : ''}.
            {flowStatus === 'complete' ? ' Sign-in complete.' : ''}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Disconnect your ChatGPT subscription?'))
                return;
              setBusy(true);
              await api('/providers/openai-codex/credential', 'DELETE').catch(
                (e) => setError(e.message),
              );
              setBusy(false);
            }}
          >
            Disconnect
          </button>
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => void start()}>
          {status.state === 'needs_reauth'
            ? 'Reconnect ChatGPT'
            : 'Sign in with ChatGPT'}
        </button>
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
