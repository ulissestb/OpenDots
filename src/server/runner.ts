import { Store } from './store.js';
import type { Result, Memory } from '../shared/types.js';
import type { Claim } from './store.js';
import { research, type Config } from './research.js';
import { defaultRunTimeoutMs } from './platform-config.js';
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private config: Config,
    private execute?: (
      claim: Claim,
      memories: Memory[],
      signal: AbortSignal,
      progress: (text: string) => void,
    ) => Promise<Result>,
  ) {}
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.safeTick(), 1000);
      void this.safeTick();
    }
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const task of this.store.tasks()) {
      if (this.active.has(task.id) && task.lease)
        this.store.release(
          { ...task, lease: task.lease },
          'Server stopping; queued for restart.',
        );
    }
    this.abortAll();
  }
  abort(id: string) {
    this.active.get(id)?.abort(new Error('Run stopped.'));
  }
  abortAll() {
    for (const controller of this.active.values())
      controller.abort(new Error('Run stopped because settings changed.'));
  }
  /** A database error must not crash the process; the next tick retries. */
  private async safeTick() {
    try {
      await this.tick();
    } catch (error) {
      console.error('Scheduler tick failed:', describe(error));
    }
  }
  async tick() {
    if (this.active.size) return;
    // The agent enforces its own budget; the runner waits a little longer so
    // the agent's error surfaces, and the lease outlives both.
    const agentTimeout = this.config.runTimeoutMs ?? defaultRunTimeoutMs;
    const timeoutMs = agentTimeout + 15_000;
    const claim = this.store.claim(Date.now(), timeoutMs + 120_000);
    if (!claim) return;
    const controller = new AbortController();
    this.active.set(claim.id, controller);
    const ownershipCheck = setInterval(() => {
      try {
        if (!this.store.owns(claim))
          controller.abort(new Error('Run permission or lease was revoked.'));
      } catch (error) {
        console.error('Scheduler ownership check failed:', describe(error));
      }
    }, 100);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Task exceeded the ${Math.round(timeoutMs / 1000)} second time limit.`,
          ),
        ),
      timeoutMs,
    );
    try {
      const settings = this.store.settings();
      // Tasks have no Dot here, so only global memories apply.
      const memories = settings.memoryAllowed
        ? this.store.promptMemories(null)
        : [];
      const progress = (text: string) => {
        if (!this.store.owns(claim))
          controller.abort(new Error('Run permission or lease was revoked.'));
        controller.signal.throwIfAborted();
        this.store.event(claim.id, claim.lease, text);
      };
      const result = this.execute
        ? await this.execute(claim, memories, controller.signal, progress)
        : await research(
            claim.prompt,
            memories,
            this.config,
            controller.signal,
            progress,
          );
      controller.signal.throwIfAborted();
      this.store.finish(claim, result);
    } catch (error) {
      try {
        this.store.fail(
          claim,
          error instanceof Error
            ? error.message
            : 'Unexpected research failure.',
        );
      } catch (storeError) {
        // The lease expires and the task is retried.
        console.error('Recording a failed run failed:', describe(storeError));
      }
    } finally {
      clearInterval(ownershipCheck);
      clearTimeout(timeout);
      this.active.delete(claim.id);
    }
  }
}
// Name and code only (e.g. ERR_SQLITE_ERROR): messages can carry provider details.
const describe = (error: unknown) => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  return error instanceof Error
    ? `${error.name}${code ? ` (${code})` : ''}`
    : 'Unknown error';
};
