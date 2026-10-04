import { PageReviewCard } from './PageReviewCard';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  FilePlus,
  ArrowUp,
  Clock3,
  Link2,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import {
  isCoarsePointer,
  isNearBottom,
  shouldSendOnEnter,
  usageSummary,
} from './ui-helpers';
import type { ConversationUsage } from '../shared/providers';
const CallView = lazy(() =>
  import('./CallView').then((m) => ({ default: m.CallView })),
);
const canAutoSize = () =>
  typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');
import { MemoryToolCard, isMemoryTool } from './MemoryToolCard';
import { DelegationToolCard, isDelegationTool } from './DelegationToolCard';
const noDots: Dot[] = [];
export function Chat({
  thread,
  dot,
  dots = noDots,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
}: {
  thread: Conversation;
  dot: Dot;
  /** All Dots, to name delegation targets. */
  dots?: Dot[];
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  // The agent outlives this component (it is shared per thread), so the run
  // state comes from the agent rather than local bookkeeping.
  const [agentRunning, setAgentRunning] = useState(agent.isRunning);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const running = (agentRunning || starting) && loaded;
  const [retryable, setRetryable] = useState(false);
  const stopped = useRef(false);
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const sent = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const followTail = useRef(true);
  const [usage, setUsage] = useState<ConversationUsage>();
  // Refresh after each turn and when the Dot's model choice changes.
  useEffect(() => {
    if (running) return;
    let active = true;
    api<ConversationUsage>(`/conversations/${thread.id}/usage`)
      .then((value) => active && setUsage(value))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [thread.id, running, dot.provider, dot.model]);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => setError(error.message),
    });
    setAgentRunning(agent.isRunning);
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => setError(event.message),
      onRunInitialized: () => setAgentRunning(true),
      onRunFailed: () => setAgentRunning(false),
      onRunFinalized: () => setAgentRunning(false),
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  const canRun = () =>
    !startingRef.current &&
    !agent.isRunning &&
    loaded &&
    contextReady &&
    !paused;
  const run = async () => {
    setError('');
    setRetryable(false);
    stopped.current = false;
    followTail.current = true;
    startingRef.current = true;
    setStarting(true);
    try {
      const result = await copilotkit.runAgent({ agent });
      // Stop resolves the run without a reply; that is not a failure.
      if (stopped.current) return;
      if (!result.newMessages.some((message) => message.role === 'assistant'))
        throw new Error(
          'The current turn returned no response. Check the runtime connection and retry.',
        );
      onSaved();
    } catch (e) {
      if (stopped.current) return;
      setError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
      setRetryable(true);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };
  const send = async (text: string) => {
    if (!text.trim() || !canRun()) return;
    agent.addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: contextualMessage(text, pageContext),
    });
    setDraft('');
    setSource('');
    setSourceOpen(false);
    await run();
  };
  // Retry re-runs the turn for the existing last user message.
  const canRetry =
    retryable && !running && agent.messages.at(-1)?.role === 'user';
  const retry = () => {
    if (canRetry && canRun()) void run();
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  // Follow streaming output only while the reader is already near the bottom.
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && followTail.current) element.scrollTop = element.scrollHeight;
  });
  // Grow the composer with its content where field-sizing is unsupported.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || canAutoSize()) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved],
  );
  const computerCalls = agent.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  // Polling hands over a new Dots array every few seconds; only re-register
  // the tool renderer when a name actually changes.
  const dotsKey = dots.map((item) => `${item.id}:${item.name}`).join('|');
  const delegates = useMemo(() => dots, [dotsKey]);
  useRenderTool(
    {
      name: '*',
      render: (props: ComputerToolRenderProps) =>
        isMemoryTool(props.name) ? (
          <MemoryToolCard {...props} />
        ) : isDelegationTool(props.name) ? (
          <DelegationToolCard {...props} dots={delegates} />
        ) : props.name.startsWith('computer_') ? (
          <ComputerToolCard
            {...props}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={props.toolCallId === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        ) : null,
    },
    [dot.id, dot.name, delegates, running, latestBrowserCall?.id, onComputer],
  );
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              call.function.name.startsWith('computer_') ||
              isMemoryTool(call.function.name) ||
              isDelegationTool(call.function.name) ||
              call.function.name === pageReviewTool.name,
          ))),
  );
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
          {usage && usageSummary(usage) && (
            <small
              className="chat-usage"
              title={`Provider: ${usage.provider ?? 'none'}. Context is the size of the latest model call. Tokens used: ${usage.inputTokens.toLocaleString()} in (${usage.cachedInputTokens.toLocaleString()} cached), ${usage.outputTokens.toLocaleString()} out (${usage.reasoningTokens.toLocaleString()} reasoning) over ${usage.calls} model calls.`}
            >
              {usageSummary(usage)}
            </small>
          )}
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice needs a ChatGPT sign-in, or VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div
        className="chat-transcript"
        ref={transcript}
        onScroll={(e) => {
          followTail.current = isNearBottom(e.currentTarget);
        }}
      >
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          renderTools={(message) => (
            <CopilotChatToolCallsView
              message={message}
              messages={agent.messages}
            />
          )}
        />
        {running && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error) && (
        <div className="chat-error" role="alert">
          {error || voice.error}
          {error && canRetry && (
            <button onClick={retry} disabled={paused || !loaded}>
              Retry
            </button>
          )}
          {error && (
            <button
              onClick={() => {
                setError('');
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      {voice.status !== 'idle' && (
        <Suspense fallback={null}>
          <CallView key="call" dot={dot} voice={voice} />
        </Suspense>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          <textarea
            ref={textarea}
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                shouldSendOnEnter({
                  key: e.key,
                  shiftKey: e.shiftKey,
                  isComposing: e.nativeEvent.isComposing || e.keyCode === 229,
                  coarsePointer: e.key === 'Enter' && isCoarsePointer(),
                })
              ) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => {
                stopped.current = true;
                copilotkit.stopAgent({ agent });
              }}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={!draft.trim() || !loaded || !contextReady || paused}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          {voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs a ChatGPT sign-in or a Realtime API key.'}
        </div>
      </form>
    </div>
  );
}
