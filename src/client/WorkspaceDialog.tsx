import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
import type { ProviderId } from '../shared/providers';
import { CodexConnect, ModelProviderFields } from './ModelProviderFields';
import { isCoarsePointer } from './ui-helpers';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  const [memoryDot, setMemoryDot] = useState(
    dialog.type === 'memory' ? (dialog.memory?.dotId ?? '') : '',
  );
  const [autoMemory, setAutoMemory] = useState(
    state.settings.autoMemory !== false,
  );
  const [learningContainer, setLearningContainer] = useState(
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
  );
  const [delegation, setDelegation] = useState(
    dialog.type === 'dot' ? (dialog.dot?.delegationAllowed ?? true) : true,
  );
  const [skillAuthoring, setSkillAuthoring] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillAuthoringAllowed ?? true) : true,
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
  );
  const [provider, setProvider] = useState<ProviderId | ''>(
    (dialog.type === 'dot'
      ? dialog.dot?.provider
      : state.settings.modelProvider) ?? '',
  );
  const [model, setModel] = useState(
    (dialog.type === 'dot' ? dialog.dot?.model : state.settings.model) ?? '',
  );
  const providers = workspace.setup.providers ?? [];
  const defaultProvider = providers.find(
    (item) => item.id === workspace.setup.defaultProvider?.provider,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // On touch devices focusing would pop the keyboard over the dialog.
    if (!isCoarsePointer())
      container.current
        ?.querySelector<HTMLElement>('input,textarea,select')
        ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Your workspace, your rules.'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : 'Let your Dot keep time.';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">OPENDOTS TEMPLATE</span>
        <h2 id="dialog-title">{title}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = '/spaces';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                learningContainerId: learningContainer.trim() || null,
                skillDeliveryEnabled: skillDelivery,
                delegationAllowed: delegation,
                skillAuthoringAllowed: skillAuthoring,
                provider: provider || null,
                model: model.trim() || null,
              };
            }
            if (dialog.type === 'settings') {
              path = '/settings';
              method = 'PATCH';
              body = {
                researchAllowed: research,
                memoryAllowed: memory,
                autoMemory,
                modelProvider: provider || null,
                model: model.trim() || null,
              };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text, dotId: memoryDot || null };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              body = {
                prompt: text,
                threadId: dialog.threadId,
                intervalSeconds: Number(interval),
              };
            }
            if (await mutate(path, method, body)) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'memory' && (
            <>
              <label className="field-label" htmlFor="memory-scope">
                Who can use it
              </label>
              <select
                id="memory-scope"
                value={memoryDot}
                onChange={(event) => setMemoryDot(event.target.value)}
              >
                <option value="">Every Dot</option>
                {workspace.dots.map((dot) => (
                  <option key={dot.id} value={dot.id}>
                    Only {dot.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(space.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...spaceIds, space.id]
                        : spaceIds.filter((id) => id !== space.id);
                      setSpaceIds(next);
                      if (!next.includes(defaultSpace))
                        setDefaultSpace(next[0] ?? '');
                    }}
                  />
                  <span>{space.name}</span>
                </label>
              ))}
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
              >
                <option value="" disabled>
                  Choose a Space
                </option>
                {workspace.spaces
                  .filter((space) => spaceIds.includes(space.id))
                  .map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
              </select>
            </fieldset>
          )}
          {(dialog.type === 'dot' || dialog.type === 'settings') && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>
                    Allow the server-side read-only browser tool. Global
                    settings always take precedence.
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>Use saved memories</strong>
                  <small>
                    Include saved memories in new turns and let the Dot save,
                    update, or forget them. Changing permission stops active
                    work.
                  </small>
                </span>
              </label>
              {dialog.type === 'dot' && (
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={delegation}
                    onChange={(e) => setDelegation(e.target.checked)}
                  />
                  <span>
                    <strong>Delegate to other Dots</strong>
                    <small>
                      Let this Dot hand sub-tasks to other Dots on its own. Each
                      delegate works in its own conversation under its own
                      permissions, so it may use tools this Dot lacks.
                    </small>
                  </span>
                </label>
              )}
              {dialog.type === 'dot' && (
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={skillAuthoring}
                    onChange={(e) => setSkillAuthoring(e.target.checked)}
                  />
                  <span>
                    <strong>Create skills</strong>
                    <small>
                      Let this Dot save new skills and improve the ones it
                      wrote. Its skills stay private to it until you share them
                      in Skills &amp; MCP.
                    </small>
                  </span>
                </label>
              )}
              {dialog.type === 'settings' && (
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={autoMemory}
                    disabled={!memory}
                    onChange={(e) => setAutoMemory(e.target.checked)}
                  />
                  <span>
                    <strong>Learn memories automatically</strong>
                    <small>
                      After each chat turn, ask the model for lasting facts
                      about you and save them. Uses one extra model call per
                      turn.
                    </small>
                  </span>
                </label>
              )}
            </>
          )}
          {(dialog.type === 'dot' || dialog.type === 'settings') &&
            providers.length > 0 && (
              <fieldset className="space-access-fields">
                <legend>
                  {dialog.type === 'dot' ? 'Model' : 'Model provider'}
                </legend>
                <ModelProviderFields
                  providers={providers}
                  provider={provider}
                  model={model}
                  onProvider={setProvider}
                  onModel={setModel}
                  inheritProvider={workspace.setup.defaultProvider?.provider}
                  inheritModel={
                    dialog.type === 'dot'
                      ? workspace.setup.defaultProvider?.model
                      : undefined
                  }
                  inheritLabel={
                    dialog.type === 'dot'
                      ? `Workspace default${defaultProvider ? ` (${defaultProvider.label})` : ''}`
                      : 'Automatic (first ready provider)'
                  }
                />
                {dialog.type === 'settings' && (
                  <CodexConnect
                    status={providers.find(
                      (item) => item.id === 'openai-codex',
                    )}
                  />
                )}
              </fieldset>
            )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Automatic Learning</legend>
              <label className="field-label" htmlFor="learning-container">
                Learning container ID
              </label>
              <input
                id="learning-container"
                value={learningContainer}
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="research-workflow"
                aria-describedby="learning-help"
                onChange={(event) => {
                  setLearningContainer(event.target.value);
                  if (!event.target.value.trim()) setSkillDelivery(false);
                }}
              />
              <p className="muted" id="learning-help">
                Create this container in your Intelligence project first. New
                conversations will contribute evidence to it. Leave blank to
                keep new conversations out of Learning. Existing conversations
                retain their original assignment.
              </p>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={skillDelivery}
                  disabled={!learningContainer.trim()}
                  onChange={(event) => setSkillDelivery(event.target.checked)}
                />
                <span>
                  <strong>Use published skills</strong>
                  <small>
                    Load reviewed skills from each conversation’s assigned
                    container. Enable delivery in Intelligence too. Turning this
                    off stops skill loading; it does not stop evidence
                    collection.
                  </small>
                </span>
              </label>
              <a
                href="https://docs.copilotkit.ai/learning"
                target="_blank"
                rel="noreferrer"
              >
                Set up Learning and review skills ↗
              </a>
            </fieldset>
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-interval">
                Repeat after each successful run
              </label>
              <select
                id="schedule-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="60">Every minute (testing)</option>
                <option value="3600">Every hour</option>
                <option value="86400">Every day</option>
                <option value="604800">Every week</option>
              </select>
              <p className="muted">
                Runs on the server in this same conversation, even with the tab
                closed. Failed runs wait for manual retry.
              </p>
            </>
          )}
          {dialog.type === 'settings' && (
            <div className="config-note">
              <strong>Service setup</strong>
              <p>
                {workspace.setup.missing.length
                  ? workspace.setup.missing.includes('ChatGPT sign-in')
                    ? `Missing: ${workspace.setup.missing.join(', ')}. Sign in with ChatGPT above, or add the variables to the server environment and restart.`
                    : `Add ${workspace.setup.missing.join(', ')} to the server environment, then restart${providers.some((item) => item.id === 'openai-codex') ? ', or sign in with ChatGPT above and choose it as the provider' : ''}.`
                  : 'Text configuration is present. A successful conversation confirms connectivity.'}
              </p>
              <p>
                Slack: {workspace.setup.slack.replaceAll('_', ' ')}. Voice:{' '}
                {workspace.setup.voice
                  ? 'configuration present'
                  : 'needs VOICE_API_KEY and VOICE_MODEL'}
                .
              </p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md"
                target="_blank"
                rel="noreferrer"
              >
                Template setup guide ↗
              </a>
            </div>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">
              Dots also save memories when you ask them to remember something,
              and can learn them automatically if enabled in Settings. Avoid
              secrets; enabled memories go to your model provider.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>
    </div>
  );
}
