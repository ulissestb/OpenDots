import { openPageLink } from './page-navigation';
import { SpaceNav } from './SpaceNav';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  useRef,
} from 'react';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Clock3,
  Code2,
  Folder,
  KeyRound,
  LogOut,
  Menu,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Pause,
  PanelLeft,
  Play,
  Plus,
  Puzzle,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Conversation,
  Detail,
  Dot,
  Result,
  State,
  WorkspaceState,
} from '../shared/types';
import { api, ApiError } from './api';
import type { AuthUser } from '../shared/auth';
import { ChangePasswordScreen, LoginScreen } from './Login';
import { Mascot } from './Mascot';
import { Chat } from './Chat';
import { ThreadList } from './ThreadList';
import { TaskRow } from './TaskPresentation';
import { TaskActions } from './TaskActions';
import type { Dialog } from './WorkspaceDialog';
// Heavy, non-initial surfaces load on demand (TipTap lives behind Spaces).
const SpaceWorkspace = lazy(() =>
  import('./SpaceWorkspace').then((m) => ({ default: m.SpaceWorkspace })),
);
const WorkspaceDialog = lazy(() =>
  import('./WorkspaceDialog').then((m) => ({ default: m.WorkspaceDialog })),
);
const SkillsMcpView = lazy(() =>
  import('./SkillsMcpView').then((m) => ({ default: m.SkillsMcpView })),
);
const ResultPane = lazy(() =>
  import('./ResultPane').then((m) => ({ default: m.ResultPane })),
);
const paneFallback = (
  <aside className="result-pane" aria-busy="true">
    <div className="pane-empty">
      <p>Loading…</p>
    </div>
  </aside>
);

export function App() {
  const [state, setState] = useState<State>();
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const [selectedDot, setSelectedDot] = useState('');
  const [selectedThread, setSelectedThread] = useState<string>();
  // A #/threads/:id link, resolved once the workspace lists that conversation.
  const [routeThread, setRouteThread] = useState<string>();
  const [view, rawSetView] = useState<
    'chat' | 'tasks' | 'memories' | 'skills' | 'space'
  >('chat');
  const dirtyPage = useRef(false);
  const captureError = useRef('');
  const [spaceId, setSpaceId] = useState('');
  const [pageId, setPageId] = useState<string>();
  const setDirtyPage = useCallback((value: boolean) => {
    dirtyPage.current = value;
  }, []);
  // Ask before leaving an unsaved page draft. Call it before changing any
  // selection, so a cancelled confirm leaves everything as it was.
  const confirmLeave = () => {
    if (dirtyPage.current && !window.confirm('Leave your unsaved page draft?'))
      return false;
    dirtyPage.current = false;
    return true;
  };
  const setView = (next: typeof view) => {
    if (!confirmLeave()) return false;
    if (next !== 'space')
      history.replaceState(null, '', location.pathname + location.search);
    rawSetView(next);
    return true;
  };
  // The last #/spaces route the user actually landed on.
  const acceptedHash = useRef(
    typeof location === 'undefined' ? '' : location.hash,
  );
  useEffect(() => {
    const navigate = () => {
      const threadMatch = location.hash.match(/^#\/threads\/([^/]+)$/);
      if (threadMatch) {
        setRouteThread(threadMatch[1]);
        return;
      }
      const match = location.hash.match(
        /^#\/spaces\/([^/]+)(?:\/pages\/([^/]+))?$/,
      );
      if (!match) return;
      if (dirtyPage.current && location.hash === acceptedHash.current) return;
      if (!confirmLeave()) {
        history.replaceState(
          null,
          '',
          acceptedHash.current || location.pathname,
        );
        return;
      }
      acceptedHash.current = location.hash;
      setSpaceId(match[1]);
      setPageId(match[2]);
      rawSetView('space');
      setMobile(false);
    };
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const openPage = (space: string, page?: string) => {
    openPageLink(`#/spaces/${space}${page ? `/pages/${page}` : ''}`);
  };

  const [error, setError] = useState('');
  const [authState, setAuthState] = useState<
    'loading' | 'anonymous' | 'must_change' | 'ready'
  >('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [mobile, setMobile] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [pane, setPane] = useState(false);
  const [capture, setCapture] = useState<Result>();
  const [prompt, setPrompt] = useState('');
  // The first message of a new conversation, sent only into that thread.
  const [pendingPrompt, setPendingPrompt] = useState<{
    threadId: string;
    text: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [taskDetail, setTaskDetail] = useState<Detail>();
  const refreshSeq = useRef(0);
  const refreshError = useRef('');
  const refresh = useCallback(async () => {
    // Only the newest request may update state; older replies are stale.
    const seq = ++refreshSeq.current;
    try {
      const [s, w] = await Promise.all([
        api<State>('/state'),
        api<WorkspaceState>('/workspace'),
      ]);
      if (seq !== refreshSeq.current) return;
      setState(s);
      setWorkspace(w);
      setSelectedDot((previous) => previous || w.dots[0]?.id || '');
      // Clear a connection error this poll raised, but keep other errors.
      const stale = refreshError.current;
      refreshError.current = '';
      if (stale) setError((current) => (current === stale ? '' : current));
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      if (e instanceof ApiError && e.status === 401) {
        // Keep the workspace mounted so unsaved drafts survive re-sign-in.
        setAuthState('anonymous');
      } else if (e instanceof ApiError && e.code === 'password_change_required')
        setAuthState('must_change');
      else {
        const message =
          e instanceof Error ? e.message : 'Could not connect to the server.';
        refreshError.current = message;
        setError(message);
      }
    }
  }, []);
  const signedIn = useCallback((next: AuthUser | null) => {
    setUser(next);
    setError('');
    setAuthState(next?.mustChangePassword ? 'must_change' : 'ready');
  }, []);
  useEffect(() => {
    if (authState !== 'loading') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep retrying until the API server answers, e.g. while it is starting.
    const check = () =>
      api<{ user: AuthUser | null }>('/auth/me')
        .then(({ user }) => {
          if (active) signedIn(user);
        })
        .catch((e) => {
          if (!active) return;
          if (e instanceof ApiError && e.status === 401)
            return setAuthState('anonymous');
          setError(
            e instanceof ApiError && e.status < 500
              ? e.message
              : 'Could not reach the OpenDots server. Retrying…',
          );
          timer = setTimeout(check, 3000);
        });
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [authState, signedIn]);
  useEffect(() => {
    if (authState !== 'ready') return;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, authState]);
  const signOut = async () => {
    if (dirtyPage.current && !window.confirm('Leave your unsaved page draft?'))
      return;
    dirtyPage.current = false;
    await api('/auth/logout', 'POST', {}).catch(() => {});
    setUser(null);
    setState(undefined);
    setWorkspace(undefined);
    setChangingPassword(false);
    setAuthState('anonymous');
  };
  const showCapture = authState === 'ready' && pane;
  useEffect(() => {
    setCapture(undefined);
    if (!selectedThread || !showCapture) return;
    let active = true;
    const load = () => {
      if (document.hidden) return;
      void api<Result | null>(`/conversations/${selectedThread}/capture`)
        .then((result) => {
          if (!active) return;
          setCapture(result ?? undefined);
          // Clear an error this poll raised once the capture loads again.
          const stale = captureError.current;
          captureError.current = '';
          if (stale) setError((current) => (current === stale ? '' : current));
        })
        .catch((e) => {
          if (!active) return;
          const message =
            e instanceof Error ? e.message : 'Could not load the capture.';
          // Re-raise only when the message changes, so Dismiss sticks.
          if (captureError.current === message) return;
          captureError.current = message;
          setError(message);
        });
    };
    load();
    const timer = setInterval(load, 3000);
    document.addEventListener('visibilitychange', load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [selectedThread, showCapture]);
  const [mutating, setMutating] = useState(false);
  const mutate = async (path: string, method: string, body?: unknown) => {
    setError('');
    setMutating(true);
    try {
      await api(path, method, body);
      await refresh();
      if (taskDetail)
        setTaskDetail(await api<Detail>(`/tasks/${taskDetail.task.id}`));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      return false;
    } finally {
      setMutating(false);
    }
  };
  const dot =
    workspace?.dots.find((item) => item.id === selectedDot) ??
    workspace?.dots[0];
  const thread = workspace?.conversations.find(
    (item) => item.id === selectedThread && item.dotId === dot?.id,
  );
  const configured = !!workspace && workspace.setup.missing.length === 0;
  // Once mounted, keep the provider: unwrapping the tree when setup readiness
  // flips (e.g. a ChatGPT sign-in needing reauth) would remount everything and
  // discard unsaved page drafts and open dialogs.
  const [providerMounted, setProviderMounted] = useState(false);
  if (configured && !providerMounted) setProviderMounted(true);
  useEffect(() => {
    if (!routeThread || !workspace) return;
    const conversation = workspace.conversations.find(
      (item) => item.id === routeThread,
    );
    // A just-delegated conversation appears with the next workspace refresh.
    if (!conversation) return;
    setRouteThread(undefined);
    if (!confirmLeave()) {
      // Stay on the page and put its route back in place of #/threads/:id.
      history.replaceState(
        null,
        '',
        acceptedHash.current.startsWith('#/spaces/')
          ? acceptedHash.current
          : location.pathname + location.search,
      );
      return;
    }
    setSelectedDot(conversation.dotId);
    setSelectedThread(conversation.id);
    setView('chat');
    setMobile(false);
  }, [routeThread, workspace]);
  const chooseDot = (next: Dot) => {
    if (!setView('chat')) return;
    setSelectedDot(next.id);
    setSelectedThread(
      workspace?.conversations.find((item) => item.dotId === next.id)?.id,
    );
    setMobile(false);
    setPendingPrompt(undefined);
  };
  const newConversation = async (text?: string) => {
    if (!dot || !configured || busy) return;
    // Ask before creating, so a cancel does not leave a stray conversation.
    if (!confirmLeave()) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Conversation>('/conversations', 'POST', {
        dotId: dot.id,
        title: text?.slice(0, 80) || 'A new thought',
      });
      await refresh();
      setSelectedThread(next.id);
      setPendingPrompt(text ? { threadId: next.id, text } : undefined);
      setPrompt('');
      setView('chat');
      setMobile(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not create the conversation.',
      );
    } finally {
      setBusy(false);
    }
  };
  const sessionExpired = authState === 'anonymous' && !!state && !!workspace;
  if (authState === 'anonymous' && !sessionExpired)
    return <LoginScreen onSignedIn={signedIn} />;
  if (authState === 'must_change' || changingPassword)
    return (
      <ChangePasswordScreen
        username={user?.username ?? 'admin'}
        forced={authState === 'must_change'}
        onChanged={(next) => {
          setChangingPassword(false);
          signedIn(next);
        }}
        onCancel={() =>
          authState === 'must_change'
            ? void signOut()
            : setChangingPassword(false)
        }
      />
    );
  if (!state || !workspace || !dot)
    return (
      <main className="unlock">
        <Mascot state="working" />
        <h1>Finding your dots…</h1>
        {error && (
          <>
            <p className="chat-error">{error}</p>
            <button onClick={() => void refresh()}>Retry</button>
          </>
        )}
      </main>
    );
  const content = (
    <div
      className={`app template-app ${navCollapsed ? 'nav-collapsed' : ''}`}
      inert={sessionExpired}
    >
      <nav className="icon-rail" aria-label="Workspace navigation">
        <button
          className="rail-brand"
          aria-label="OpenDots home"
          onClick={() => {
            if (setView('chat')) setSelectedThread(undefined);
          }}
        >
          o<span>·</span>
        </button>
        <button
          aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setNavCollapsed(!navCollapsed)}
        >
          <PanelLeft size={18} />
        </button>
        <button
          aria-label="New chat"
          disabled={!configured}
          onClick={() => void newConversation()}
        >
          <Plus size={19} />
        </button>
        <button
          aria-label="Open Spaces"
          onClick={() => {
            if (workspace.spaces[0]) openPage(workspace.spaces[0].id);
          }}
        >
          <Folder size={18} />
        </button>
        <button aria-label="Open activity" onClick={() => setView('tasks')}>
          <Clock3 size={18} />
        </button>
        <button
          className="rail-settings"
          aria-label="Open settings"
          onClick={() => setDialog({ type: 'settings' })}
        >
          <Settings2 size={18} />
        </button>
        {user && (
          <button
            aria-label="Change password"
            onClick={() => {
              // The password screen replaces the workspace, like signing out.
              if (
                dirtyPage.current &&
                !window.confirm('Leave your unsaved page draft?')
              )
                return;
              dirtyPage.current = false;
              setChangingPassword(true);
            }}
          >
            <KeyRound size={18} />
          </button>
        )}
        <button aria-label="Sign out" onClick={() => void signOut()}>
          <LogOut size={18} />
        </button>
      </nav>
      <button
        className="mobile-menu icon-button"
        aria-label="Open navigation"
        aria-expanded={mobile}
        aria-controls="workspace-sidebar"
        onClick={() => setMobile(true)}
      >
        <Menu size={21} />
      </button>
      {mobile && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="workspace-sidebar"
        className={`sidebar ${mobile ? 'open' : ''}`}
      >
        <button
          className="wordmark"
          onClick={() => {
            if (setView('chat')) setSelectedThread(undefined);
          }}
        >
          <span className="dotted-logo">
            <i />
            <i />
            <i />
            <i />
          </span>
          OpenDots<span className="wordmark-dot">•</span>
        </button>
        <button
          className="new-chat nav-item"
          disabled={!configured}
          onClick={() => void newConversation()}
        >
          <Plus size={17} />
          <span>New chat</span>
        </button>
        <div className="spaces-heading nav-label">
          DOTS
          <button
            className="icon-button"
            aria-label="Create Dot"
            onClick={() =>
              setDialog({ type: 'dot', spaceId: workspace.spaces[0].id })
            }
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="dots-nav" aria-label="Dots">
          {workspace.dots.map((item) => (
            <div className="dot-nav-row" key={item.id}>
              <button
                className={`dot-nav ${dot.id === item.id && view === 'chat' ? 'active' : ''}`}
                aria-current={
                  dot.id === item.id && view === 'chat' ? 'page' : undefined
                }
                onClick={() => chooseDot(item)}
              >
                <Mascot identity={item.id} name={item.name} small decorative />
                <span>{item.name}</span>
              </button>
              <button
                className="icon-button dot-settings"
                aria-label={`Edit ${item.name} settings`}
                onClick={() =>
                  setDialog({ type: 'dot', dot: item, spaceId: item.spaceId })
                }
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          ))}
        </nav>
        <div className="spaces-heading nav-label">
          SPACES
          <button
            className="icon-button"
            aria-label="Create Space"
            onClick={() => setDialog({ type: 'space' })}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="spaces-nav" aria-label="Spaces">
          {workspace.spaces.map((space) => (
            <SpaceNav
              key={space.id}
              space={space}
              active={view === 'space' && spaceId === space.id}
              pageId={pageId}
              onOpen={(id) => openPage(space.id, id)}
            />
          ))}
        </nav>
        {configured ? (
          <ThreadList
            dotId={dot.id}
            dots={workspace.dots}
            local={workspace.conversations}
            selected={view === 'chat' ? selectedThread : undefined}
            onSelect={(id) => {
              const conversation = workspace.conversations.find(
                (item) => item.id === id,
              );
              if (!setView('chat')) return;
              if (conversation) setSelectedDot(conversation.dotId);
              setSelectedThread(id);
              setMobile(false);
            }}
            onNew={() => void newConversation()}
          />
        ) : (
          <div className="sidebar-empty">
            Set up text chat to begin a persistent conversation.
          </div>
        )}
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === 'tasks' ? 'active' : ''}`}
            onClick={() => {
              setView('tasks');
              setMobile(false);
            }}
          >
            <Clock3 size={17} />
            <span>Scheduled & activity</span>
            <small>{state.tasks.length}</small>
          </button>
          <button
            className={`nav-item ${view === 'memories' ? 'active' : ''}`}
            onClick={() => {
              setView('memories');
              setMobile(false);
            }}
          >
            <BookOpen size={17} />
            <span>Memories</span>
            <small>{state.memories.length}</small>
          </button>
          <button
            className={`nav-item ${view === 'skills' ? 'active' : ''}`}
            onClick={() => {
              setView('skills');
              setMobile(false);
            }}
          >
            <Puzzle size={17} />
            <span>Skills & MCP</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setDialog({ type: 'settings' })}
          >
            <Settings2 size={17} />
            <span>Settings & setup</span>
          </button>
          <a
            className="nav-item"
            href="https://github.com/CopilotKit/OpenDots"
            target="_blank"
            rel="noreferrer"
          >
            <Code2 size={17} />
            <span>Make it your own</span>
            <ArrowUpRight size={13} />
          </a>
          <div className="version">
            OPEN SOURCE TEMPLATE <span>v0.1</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="desktop-nav-toggle document-icon"
            aria-label={navCollapsed ? 'Show navigation' : 'Hide navigation'}
            onClick={() => setNavCollapsed(!navCollapsed)}
          >
            <PanelLeft size={18} />
          </button>
          <div className="breadcrumbs">
            <span>
              {view === 'space'
                ? workspace.spaces.find((space) => space.id === spaceId)?.name
                : 'Dots'}
            </span>
            <span>/</span>
            <strong>
              {view === 'chat'
                ? dot.name
                : view === 'tasks'
                  ? 'Activity'
                  : view === 'space'
                    ? 'Pages'
                    : view === 'skills'
                      ? 'Skills & MCP'
                      : 'Memories'}
            </strong>
          </div>
          <div className="top-actions">
            <span className="mode-badge">
              {configured ? 'SELF-HOSTED' : 'SETUP REQUIRED'}
            </span>
            <button
              className="pause-button"
              aria-label={
                state.settings.paused ? 'Resume all Dots' : 'Pause all Dots'
              }
              onClick={() =>
                void mutate('/settings', 'PATCH', {
                  paused: !state.settings.paused,
                })
              }
            >
              {state.settings.paused ? <Play size={14} /> : <Pause size={14} />}
              <span>{state.settings.paused ? 'Resume' : 'Pause'}</span>
            </button>
            <button
              className="icon-button"
              aria-label={pane ? 'Hide computer' : 'Show computer'}
              aria-expanded={pane}
              onClick={() => setPane(!pane)}
            >
              <Monitor size={18} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError('')}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {state.settings.paused && (
          <div className="notice">
            All Dots are paused. Active compute stops and scheduled tasks wait.
          </div>
        )}
        {view === 'space' ? (
          <Suspense
            fallback={
              <main className="spaces-surface library" aria-busy="true">
                <div className="library-empty">
                  <h2>Loading page…</h2>
                </div>
              </main>
            }
          >
            <SpaceWorkspace
              key={spaceId}
              space={
                workspace.spaces.find((s) => s.id === spaceId) ??
                workspace.spaces[0]
              }
              pageId={pageId}
              workspace={workspace}
              paused={state.settings.paused}
              onPage={(id) => openPage(spaceId, id)}
              onSettings={() => setDialog({ type: 'settings' })}
              onCreateDot={() => setDialog({ type: 'dot', spaceId })}
              onDirty={setDirtyPage}
              onRefresh={refresh}
              onSchedule={(threadId) =>
                setDialog({ type: 'schedule', threadId })
              }
              onThread={(id) => {
                const target = workspace.conversations.find((t) => t.id === id);
                if (target && setView('chat')) {
                  setSelectedDot(target.dotId);
                  setSelectedThread(id);
                }
              }}
            />
          </Suspense>
        ) : view === 'chat' ? (
          <div className={`chat-workspace ${pane ? 'split' : ''}`}>
            <div className="chat-column">
              {thread && configured ? (
                <Chat
                  key={thread.id}
                  thread={thread}
                  dot={dot}
                  dots={workspace.dots}
                  initialPrompt={
                    pendingPrompt?.threadId === thread.id
                      ? pendingPrompt.text
                      : undefined
                  }
                  onConsumed={() => setPendingPrompt(undefined)}
                  voiceReady={workspace.setup.voice}
                  calls={workspace.calls.filter(
                    (call) => call.threadId === thread.id,
                  )}
                  paused={state.settings.paused}
                  onSaved={refresh}
                  onComputer={() => setPane(true)}
                  onSchedule={() =>
                    setDialog({ type: 'schedule', threadId: thread.id })
                  }
                />
              ) : (
                <div className="new-conversation">
                  <div className="empty-chat-persona">
                    <Mascot
                      identity={dot.id}
                      name={dot.name}
                      state={state.settings.paused ? 'paused' : 'idle'}
                    />
                    <h2>{dot.name}</h2>
                    <p>{dot.instructions}</p>
                    <button
                      className="text-button"
                      onClick={() =>
                        setDialog({ type: 'dot', dot, spaceId: dot.spaceId })
                      }
                    >
                      Edit specialist <MoreHorizontal size={14} />
                    </button>
                  </div>
                  {!configured && (
                    <div className="setup-card">
                      <span className="setup-icon">
                        <Settings2 size={20} />
                      </span>
                      <div>
                        <strong>Connect your Dot</strong>
                        <p>
                          Connect your model and conversation service in
                          Settings to start chatting. Your Spaces and Dot
                          preferences are ready to use.
                        </p>
                        <a
                          href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open the setup guide <ArrowUpRight size={12} />
                        </a>
                      </div>
                    </div>
                  )}
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void newConversation(prompt);
                    }}
                  >
                    <textarea
                      aria-label="Start a conversation"
                      placeholder={
                        configured
                          ? `Message ${dot.name}…`
                          : 'Your first conversation starts after setup.'
                      }
                      value={prompt}
                      maxLength={4000}
                      onChange={(e) => setPrompt(e.target.value)}
                      disabled={!configured}
                    />
                    <div className="composer-bottom">
                      <span>
                        <MessageCircle size={14} />
                        Text and calls, one continuing conversation
                      </span>
                      <button
                        className="send-button"
                        aria-label="Start conversation"
                        disabled={!configured || busy || !prompt.trim()}
                      >
                        <ArrowUp size={19} />
                      </button>
                    </div>
                  </form>
                  <div className="starter-suggestions">
                    {[
                      'Help me think this through',
                      'Research a public page',
                      'Make a plan I can follow',
                    ].map((text) => (
                      <button
                        key={text}
                        disabled={!configured}
                        onClick={() => setPrompt(text)}
                      >
                        {text}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                  <div className="connection-note">
                    <span
                      className={`online-dot ${workspace.setup.slack === 'online' ? '' : 'off'}`}
                    />
                    Slack · {workspace.setup.slack.replaceAll('_', ' ')}
                    <button
                      className="text-button"
                      onClick={() => setDialog({ type: 'settings' })}
                    >
                      Setup details
                    </button>
                  </div>
                </div>
              )}
            </div>
            {pane && (
              <Suspense fallback={paneFallback}>
                <ResultPane
                  key={dot.id}
                  dots={workspace.dots}
                  defaultDotId={dot.id}
                  latest={capture}
                  dotState="idle"
                  onClose={() => setPane(false)}
                />
              </Suspense>
            )}
          </div>
        ) : view === 'skills' ? (
          <Suspense
            fallback={
              <main className="main-content" aria-busy="true">
                <p className="muted">Loading…</p>
              </main>
            }
          >
            <SkillsMcpView dots={workspace.dots} />
          </Suspense>
        ) : (
          <main className="main-content">
            <div className="page-heading">
              <div>
                <span className="eyebrow">YOUR WORKSPACE</span>
                <h1>
                  {view === 'memories'
                    ? 'Memories'
                    : 'A little follow-through.'}
                </h1>
                <p>
                  {view === 'memories'
                    ? 'What your Dots remember about you. Add, edit, or remove anything.'
                    : 'Scheduled turns run on the server in their original conversation.'}
                </p>
              </div>
              {view === 'memories' && (
                <button
                  className="primary"
                  onClick={() => setDialog({ type: 'memory' })}
                >
                  <Plus size={15} />
                  Add memory
                </button>
              )}
            </div>
            {view === 'memories' ? (
              <>
                <div className="memory-grid">
                  {state.memories.map((memory) => (
                    <article className="memory-card" key={memory.id}>
                      <BookOpen size={18} />
                      <p>{memory.text}</p>
                      <div>
                        <small>
                          {!state.settings.memoryAllowed
                            ? 'Memory use disabled'
                            : memory.dotId
                              ? `Only ${workspace?.dots.find((dot) => dot.id === memory.dotId)?.name ?? 'a deleted Dot'}`
                              : 'All permitted Dots'}
                          {' · '}
                          {memory.source === 'auto'
                            ? 'Learned automatically'
                            : memory.source === 'agent'
                              ? 'Saved by a Dot'
                              : 'Added by you'}
                        </small>
                        <button
                          className="icon-button"
                          aria-label="Edit memory"
                          onClick={() => setDialog({ type: 'memory', memory })}
                        >
                          <MoreHorizontal size={17} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Delete memory"
                          onClick={() =>
                            void mutate(`/memories/${memory.id}`, 'DELETE', {})
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {!state.memories.length && (
                  <div className="large-empty">
                    <Mascot />
                    <h2>A little context goes a long way.</h2>
                    <p>
                      Add a preference like “Keep my research briefs short,” or
                      tell a Dot “remember that…”. You can change or remove
                      memories anytime.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="Search tasks"
                    placeholder="Find a task…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="task-list">
                  {state.tasks
                    .filter((task) =>
                      task.prompt.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onClick={() =>
                          void api<Detail>(`/tasks/${task.id}`)
                            .then(setTaskDetail)
                            .catch((e) => setError(e.message))
                        }
                      />
                    ))}
                </div>
                {!state.tasks.length && (
                  <div className="large-empty">
                    <Clock3 size={32} />
                    <h2>Let a thought come back around.</h2>
                    <p>
                      Open a conversation and use the clock button to schedule a
                      server-side task.
                    </p>
                  </div>
                )}
                {taskDetail && (
                  <section className="task-detail-card">
                    <h2>{taskDetail.task.prompt}</h2>
                    <TaskActions
                      task={taskDetail.task}
                      busy={busy || mutating}
                      settings={state.settings}
                      onAction={(action) =>
                        void mutate(
                          `/tasks/${taskDetail.task.id}/actions`,
                          'POST',
                          { action },
                        )
                      }
                      onSchedule={async () => {
                        const raw = window.prompt(
                          'Repeat interval in minutes (0 removes the schedule)',
                          String((taskDetail.task.intervalSeconds ?? 0) / 60),
                        );
                        if (raw === null) return;
                        const value = Number(raw);
                        if (!Number.isFinite(value) || value < 0) {
                          setError('Enter a valid number of minutes.');
                          return;
                        }
                        await mutate(
                          `/tasks/${taskDetail.task.id}/schedule`,
                          'PUT',
                          {
                            intervalSeconds: value
                              ? Math.round(value * 60)
                              : null,
                          },
                        );
                      }}
                    />
                    {taskDetail.task.error && (
                      <p className="chat-error">{taskDetail.task.error}</p>
                    )}
                    {taskDetail.events.slice(-6).map((event) => (
                      <p className="muted" key={event.id}>
                        {event.text}
                      </p>
                    ))}
                    <small>{taskDetail.runs.length} saved runs</small>
                  </section>
                )}
              </>
            )}
          </main>
        )}
        {pane && view !== 'chat' && (
          <div className="computer-overlay">
            <Suspense fallback={paneFallback}>
              <ResultPane
                key={view === 'space' ? spaceId : dot.id}
                dots={workspace.dots}
                defaultDotId={
                  view === 'space'
                    ? (workspace.dots.find((candidate) =>
                        candidate.spaceIds.includes(spaceId),
                      )?.id ?? dot.id)
                    : dot.id
                }
                dotState="idle"
                onClose={() => setPane(false)}
              />
            </Suspense>
          </div>
        )}
      </div>
      {dialog && (
        <Suspense fallback={null}>
          <WorkspaceDialog
            dialog={dialog}
            state={state}
            workspace={workspace}
            onClose={() => setDialog(undefined)}
            mutate={mutate}
          />
        </Suspense>
      )}
    </div>
  );
  const shell = sessionExpired ? (
    <>
      {content}
      <div
        className="session-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Session expired"
      >
        <LoginScreen
          onSignedIn={signedIn}
          notice="Your session ended. Sign in again — your open drafts are still here."
        />
      </div>
    </>
  ) : (
    content
  );
  return providerMounted ? (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" credentials="same-origin">
      {shell}
    </CopilotKitProvider>
  ) : (
    shell
  );
}
