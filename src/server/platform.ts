import { ComputerService } from './computer-service.js';
import { PageService, type PageIntelligence } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { createSlackChannel } from './slack-channel.js';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runLocalThreadTurn, runThreadTurn } from './headless.js';
import { SqliteAgentRunner } from './sqlite-runner.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { learningSelector } from './learning.js';
import { ProviderRegistry } from './providers/registry.js';
import { MemoryExtractor } from './memory-extractor.js';
import { DotDelegation } from './delegation.js';
import type { McpService } from './mcp.js';
import type { ConversationUsage } from '../shared/providers.js';
export class Platform {
  private channelStartupFailed = false;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly intelligence?: CopilotKitIntelligence;
  /** Local conversation history, used when Intelligence is not configured. */
  readonly local?: SqliteAgentRunner;
  readonly handler: CopilotHonoApp;
  readonly delegation: DotDelegation;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    readonly providers = ProviderRegistry.fromConfig(config),
    localRunner?: SqliteAgentRunner,
    readonly mcp?: McpService,
  ) {
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    const extractor = new MemoryExtractor(store, workspace, providers);
    this.delegation = new DotDelegation(
      workspace,
      (dotId, title) => this.createConversation(dotId, title),
      (threadId, prompt, signal, metadata) =>
        this.turn(threadId, prompt, signal, metadata),
    );
    const delegation = this.delegation;
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return this.threads();
    });
    const agents = async () =>
      Object.fromEntries(
        workspace
          .dots()
          .map((dot) => [
            dot.id,
            new DotAgent(
              store,
              workspace,
              config,
              dot.id,
              false,
              providers,
              extractor,
              delegation,
              mcp,
            ),
          ]),
      );
    if (!config.intelligenceKey) {
      // Without Intelligence, conversations run and persist locally (SSE mode).
      this.local = localRunner ?? new SqliteAgentRunner(':memory:');
      this.handler = createCopilotHonoHandler({
        runtime: new CopilotRuntime({ agents, runner: this.local }),
        basePath: '/api/copilotkit',
        cors: { origin: [] },
      });
      return;
    }
    this.intelligence = new CopilotKitIntelligence({
      apiKey: config.intelligenceKey,
      apiUrl: config.intelligenceApiUrl,
      wsUrl: config.intelligenceWsUrl,
      getLearningContainerId: learningSelector(
        workspace,
        config.slackDotId ?? workspace.dots()[0]?.id,
      ),
    });
    const channels = [];
    if (config.slackChannel && config.slackTeam && config.slackUsers.length) {
      const dotId = config.slackDotId ?? workspace.dots()[0].id;
      if (!workspace.dot(dotId))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
      const slack = createSlackChannel({
        name: config.slackChannel,
        config,
        ownerId: workspace.ownerId,
        paused: () => store.settings().paused,
        agent: () =>
          new DotAgent(
            store,
            workspace,
            config,
            dotId,
            true,
            providers,
            extractor,
            delegation,
            mcp,
          ),
      });
      channels.push(slack);
    }
    const runtime = new CopilotRuntime({
      intelligence: this.intelligence,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'OpenDots owner',
      }),
      agents,
      channels,
      generateThreadNames: true,
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  private threads(): PageIntelligence {
    if (this.intelligence) return this.intelligence;
    const local = this.local!;
    return {
      getOrCreateThread: async () => undefined,
      getThreadMessages: async ({ threadId }) => ({
        messages: local.getThreadMessages(threadId),
      }),
    };
  }
  setup() {
    return setupStatus(
      this.config,
      this.handler?.channels?.status().overall ??
        (this.config.slackChannel ? 'setup_required' : 'not_configured'),
      this.channelStartupFailed,
      {
        ...this.providers.readiness(this.store.settings()),
        providers: this.providers.statuses(),
      },
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  async start() {
    if (this.handler?.channels) {
      try {
        await this.handler.channels.ready({ timeoutMs: 15000 });
        this.channelStartupFailed = false;
      } catch (error) {
        this.channelStartupFailed = true;
        throw error;
      }
    }
  }
  async stop() {
    await this.handler?.channels?.stop();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    if (this.intelligence)
      try {
        await this.intelligence.createThread({
          threadId: id,
          userId: this.workspace.ownerId,
          agentId: dotId,
          name: title,
        });
      } catch {
        throw new Error(
          'Intelligence could not create this conversation. Check the runtime key and connection.',
        );
      }
    return this.workspace.bindThread(id, dotId, title);
  }
  /** The model this conversation's Dot runs now, and its recorded token use. */
  usage(threadId: string): ConversationUsage {
    const thread = this.workspace.requireThread(threadId);
    const dot = this.workspace.dot(thread.dotId);
    const target = this.providers.readiness(this.store.settings(), dot);
    const recorded = this.workspace.usage(threadId);
    return {
      provider: target.provider,
      model: target.model,
      contextWindow:
        (target.provider &&
          target.model &&
          this.providers
            .provider(target.provider)
            ?.contextWindow(target.model)) ||
        null,
      contextTokens: recorded?.contextTokens ?? 0,
      inputTokens: recorded?.inputTokens ?? 0,
      outputTokens: recorded?.outputTokens ?? 0,
      reasoningTokens: recorded?.reasoningTokens ?? 0,
      cachedInputTokens: recorded?.cachedInputTokens ?? 0,
      calls: recorded?.calls ?? 0,
      updatedAt: recorded?.updatedAt ?? null,
    };
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const history = await this.threads().getThreadMessages({
      threadId,
      userId: this.workspace.ownerId,
    });
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  private turns = new Map<string, Promise<unknown>>();
  /**
   * Runs one server-side turn. Turns on the same conversation wait for each
   * other: a new run on a thread supersedes a streaming one, which would drop
   * the earlier turn (two voice tasks in one call, a task during a delegation).
   */
  turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const previous = this.turns.get(threadId) ?? Promise.resolve();
    const run = previous.then(() => {
      signal.throwIfAborted();
      return this.runTurn(threadId, prompt, signal, metadata);
    });
    const settled = run.catch(() => undefined);
    this.turns.set(threadId, settled);
    void settled.then(() => {
      if (this.turns.get(threadId) === settled) this.turns.delete(threadId);
    });
    return run;
  }
  private async runTurn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    const headers: Record<string, string> = this.config.serviceToken
      ? { Authorization: `Bearer ${this.config.serviceToken}` }
      : {};
    if (this.local)
      return runLocalThreadTurn(
        this.config.runtimeUrl,
        headers,
        thread.dotId,
        threadId,
        this.local.getThreadMessages(threadId),
        prompt,
        signal,
        metadata,
      );
    return runThreadTurn(
      this.config.runtimeUrl,
      headers,
      thread.dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
