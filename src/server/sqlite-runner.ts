import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReplaySubject, type Observable } from 'rxjs';
import {
  EventType,
  compactEvents,
  type AbstractAgent,
  type BaseEvent,
  type Message,
} from '@ag-ui/client';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from '@copilotkit/runtime/v2';

interface Live {
  runId: string;
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
  finalize: { stopRequested: boolean };
}
interface Row {
  threadId: string;
  agentId: string;
  events: string;
  messages: string;
  createdAt: number;
  updatedAt: number;
}
const messageId = (event: BaseEvent) =>
  'messageId' in event && typeof event.messageId === 'string'
    ? event.messageId
    : undefined;
/**
 * Durable local conversation history for runtimes without CopilotKit
 * Intelligence. Mirrors the SDK's InMemoryAgentRunner, but keeps each thread's
 * compacted AG-UI events and message snapshot in SQLite so conversations
 * survive restarts.
 */
export class SqliteAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private db: DatabaseSync;
  private live = new Map<string, Live>();
  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_threads(threadId TEXT PRIMARY KEY, agentId TEXT NOT NULL, events TEXT NOT NULL, messages TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  private row(threadId: string) {
    return this.db
      .prepare('SELECT * FROM local_threads WHERE threadId=?')
      .get(threadId) as Row | undefined;
  }
  private events(threadId: string): BaseEvent[] {
    const row = this.row(threadId);
    return row ? (JSON.parse(row.events) as BaseEvent[]) : [];
  }
  private save(
    threadId: string,
    agentId: string,
    events: BaseEvent[],
    messages: Message[],
  ) {
    const previous = this.row(threadId);
    const time = Date.now();
    const all = compactEvents([
      ...(previous ? (JSON.parse(previous.events) as BaseEvent[]) : []),
      ...events,
    ]);
    this.db
      .prepare(
        'INSERT INTO local_threads VALUES (?,?,?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET agentId=excluded.agentId, events=excluded.events, messages=excluded.messages, updatedAt=excluded.updatedAt',
      )
      .run(
        threadId,
        agentId,
        JSON.stringify(all),
        JSON.stringify(
          messages.length
            ? messages
            : previous
              ? (JSON.parse(previous.messages) as Message[])
              : [],
        ),
        previous?.createdAt ?? time,
        time,
      );
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const prior = this.live.get(request.threadId);
    if (prior) {
      // Supersede: a new message replaces a run that is still streaming.
      prior.finalize.stopRequested = true;
      try {
        prior.agent.abortRun();
      } catch (error) {
        console.error('Failed to abort superseded run', error);
      }
    }
    const historic = new Set<string>();
    for (const event of this.events(request.threadId)) {
      const id = messageId(event);
      if (id) historic.add(id);
      if (event.type === EventType.RUN_STARTED)
        for (const message of (
          event as BaseEvent & { input?: { messages?: Message[] } }
        ).input?.messages ?? [])
          historic.add(message.id);
    }
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const finalize = { stopRequested: false };
    const live: Live = {
      runId: request.input.runId,
      agent: request.agent,
      subject,
      finalize,
    };
    this.live.set(request.threadId, live);
    const current: BaseEvent[] = [];
    const finish = (interruptionMessage?: string) => {
      const before = current.length;
      for (const event of finalizeRunEvents(current, {
        stopRequested: finalize.stopRequested,
        ...(interruptionMessage === undefined ? {} : { interruptionMessage }),
      })) {
        current.push(event);
        subject.next(event);
      }
      const owns = this.live.get(request.threadId) === live;
      if (owns && (interruptionMessage === undefined || before > 0))
        try {
          this.save(
            request.threadId,
            request.agent.agentId ?? 'default',
            current,
            Array.isArray(request.agent.messages)
              ? [...request.agent.messages]
              : [],
          );
        } catch (error) {
          console.error('Failed to persist conversation', error);
        }
      if (owns) this.live.delete(request.threadId);
      subject.complete();
    };
    void (async () => {
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            if (event.type === EventType.RUN_STARTED) {
              const started = event as BaseEvent & { input?: unknown };
              if (!started.input)
                started.input = {
                  ...request.input,
                  messages: request.input.messages?.filter(
                    (message) => !historic.has(message.id),
                  ),
                };
            }
            current.push(event);
            subject.next(event);
          },
        });
        finish();
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
      }
    })();
    return subject.asObservable();
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connection = new ReplaySubject<BaseEvent>(Infinity);
    const emitted = new Set<string>();
    for (const event of this.events(request.threadId)) {
      connection.next(event);
      const id = messageId(event);
      if (id) emitted.add(id);
    }
    const live = this.live.get(request.threadId);
    if (live)
      live.subject.subscribe({
        next: (event) => {
          const id = messageId(event);
          if (!id || !emitted.has(id)) connection.next(event);
        },
        complete: () => connection.complete(),
        error: (error) => connection.error(error),
      });
    else connection.complete();
    return connection.asObservable();
  }
  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.live.has(request.threadId));
  }
  stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const live = this.live.get(request.threadId);
    if (
      !live ||
      live.finalize.stopRequested ||
      (request.runId !== undefined && request.runId !== live.runId)
    )
      return Promise.resolve(false);
    live.finalize.stopRequested = true;
    try {
      live.agent.abortRun();
      return Promise.resolve(true);
    } catch (error) {
      console.error('Failed to abort agent run', error);
      live.finalize.stopRequested = false;
      return Promise.resolve(false);
    }
  }
  listThreads(): LocalThreadEndpointRecord[] {
    return (
      this.db
        .prepare(
          'SELECT threadId, agentId, createdAt, updatedAt FROM local_threads ORDER BY updatedAt DESC',
        )
        .all() as unknown as Pick<
        Row,
        'threadId' | 'agentId' | 'createdAt' | 'updatedAt'
      >[]
    ).map((row) => ({
      id: row.threadId,
      name: null,
      agentId: row.agentId,
      organizationId: '',
      createdById: '',
      archived: false,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }
  getThreadMessages(threadId: string): Message[] {
    const row = this.row(threadId);
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }
  getThreadEvents(threadId: string): BaseEvent[] {
    return this.events(threadId);
  }
  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.events(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as BaseEvent & { snapshot?: unknown };
      if (event.type === EventType.STATE_SNAPSHOT)
        return event.snapshot &&
          typeof event.snapshot === 'object' &&
          !Array.isArray(event.snapshot)
          ? { ...(event.snapshot as Record<string, unknown>) }
          : null;
    }
    return null;
  }
  clearThreads() {
    // Conversations are durable workspace data; never wipe them from a route.
  }
}
