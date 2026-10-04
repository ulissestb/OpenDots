import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Conversation, Dot } from '../shared/types.js';
import { WorkspaceStore } from './workspace.js';

/** A Dot may delegate, and its delegate may delegate once more. */
export const maxDelegationDepth = 2;
/** Delegations one run may start, so a confused model cannot fan out forever. */
export const maxDelegationsPerRun = 4;
/** Time a child turn needs to be worth starting. */
export const minDelegationMs = 30_000;
/** Time the parent keeps after its child's deadline to write the answer. */
export const delegationMarginMs = 15_000;
const replyLimit = 20_000;

export interface DelegationContext {
  depth: number;
  /** Dots already working on this request, the delegating Dot last. */
  chain: string[];
  /** Wall-clock deadline the child turn must finish within. */
  deadline: number;
  fromDotId: string;
  fromDotName: string;
  parentThreadId: string;
  /**
   * The delegating run's signal. The child run watches it directly: closing
   * the child's HTTP stream alone does not stop a server-side run.
   */
  signal: AbortSignal;
}
export interface DelegationRequest {
  from: Dot;
  parentThreadId: string;
  targetDotId: string;
  task: string;
  context?: string;
  deadline: number;
  signal: AbortSignal;
}
export interface DelegationResult {
  dotId: string;
  dotName: string;
  threadId: string;
  reply: string;
}
export interface Delegation {
  /** Set while this thread is running a task another Dot handed to it. */
  context(threadId: string): DelegationContext | undefined;
  delegate(request: DelegationRequest): Promise<DelegationResult>;
}

export function delegationPrompt(task: string, from: string, context?: string) {
  return `Task delegated by the Dot ${from}:\n${task}${context?.trim() ? `\n\nContext from ${from}:\n${context.trim()}` : ''}`;
}

/**
 * Runs a task as another Dot in a conversation of its own, through the same
 * server-side turn path as scheduled tasks. The in-process registry carries
 * depth, cycle, and deadline data to the child run: it runs in this process
 * in both runtime modes, while message metadata may be dropped in transit.
 */
export class DotDelegation implements Delegation {
  private active = new Map<string, DelegationContext>();
  constructor(
    private workspace: WorkspaceStore,
    private createConversation: (
      dotId: string,
      title: string,
    ) => Promise<Conversation>,
    private turn: (
      threadId: string,
      prompt: string,
      signal: AbortSignal,
      metadata?: Record<string, unknown>,
    ) => Promise<string>,
  ) {}
  context(threadId: string) {
    return this.active.get(threadId);
  }
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    request.signal.throwIfAborted();
    const target = this.workspace.dot(request.targetDotId);
    if (!target) throw new Error('That Dot no longer exists.');
    const parent = this.active.get(request.parentThreadId);
    const chain = [...(parent?.chain ?? []), request.from.id];
    if (target.id === request.from.id)
      throw new Error('A Dot cannot delegate to itself.');
    if (chain.includes(target.id))
      throw new Error(
        `${target.name} is already working on this request; finish the task yourself.`,
      );
    if (chain.length > maxDelegationDepth)
      throw new Error(
        'Delegation depth limit reached; finish the task yourself.',
      );
    if (request.deadline - Date.now() < minDelegationMs)
      throw new Error(
        'Not enough time left in this turn to delegate; finish the task yourself.',
      );
    const threadId =
      this.workspace.delegationThread(request.parentThreadId, target.id) ??
      (
        await this.createConversation(
          target.id,
          `${request.from.name} → ${target.name}`.slice(0, 120),
        )
      ).id;
    // Creating the conversation may await Intelligence; honour a stop meanwhile.
    request.signal.throwIfAborted();
    this.workspace.bindDelegationThread(
      request.parentThreadId,
      target.id,
      threadId,
    );
    if (this.active.has(threadId))
      throw new Error(
        `${target.name} is still working on an earlier task from this conversation.`,
      );
    this.active.set(threadId, {
      depth: chain.length,
      chain,
      deadline: request.deadline,
      fromDotId: request.from.id,
      fromDotName: request.from.name,
      parentThreadId: request.parentThreadId,
      signal: request.signal,
    });
    try {
      const reply = await this.turn(
        threadId,
        delegationPrompt(request.task, request.from.name, request.context),
        request.signal,
        {
          opendotsSource: 'delegation',
          parentThreadId: request.parentThreadId,
          fromDotId: request.from.id,
        },
      );
      return {
        dotId: target.id,
        dotName: target.name,
        threadId,
        reply,
      };
    } finally {
      this.active.delete(threadId);
    }
  }
}

/** The delegate_to_dot tool for one run of one Dot. */
export function delegationTools(options: {
  delegation: Delegation;
  from: Dot;
  dots: Dot[];
  parentThreadId: string;
  /** The child's deadline: the parent's deadline minus its answer margin. */
  deadline: number;
  signal: AbortSignal;
  check: () => void;
}): ToolDefinition[] {
  const chain = options.delegation.context(options.parentThreadId)?.chain ?? [];
  const targets = options.dots.filter(
    (dot) => dot.id !== options.from.id && !chain.includes(dot.id),
  );
  if (!targets.length) return [];
  const ids = targets.map((dot) => dot.id) as [string, ...string[]];
  let started = 0;
  return [
    defineTool({
      name: 'delegate_to_dot',
      description: `Hand a self-contained sub-task to another specialist Dot and wait for its answer. The Dot works in its own conversation with its own tools and permissions and cannot see this conversation, so put everything it needs in task and context. Delegate on your own initiative when another Dot's specialty fits a sub-task better than yours; do the rest yourself. At most ${maxDelegationsPerRun} delegations per turn. Available Dots:\n${targets
        .map(
          (dot) =>
            `- ${dot.id}: ${dot.name}. ${dot.instructions.replace(/\s+/g, ' ').slice(0, 200)}`,
        )
        .join('\n')}`,
      parameters: z.object({
        dot_id: z.enum(ids).describe('The id of the Dot to delegate to.'),
        task: z
          .string()
          .min(1)
          .max(8000)
          .describe('What the Dot should do and what result to return.'),
        context: z
          .string()
          .max(8000)
          .optional()
          .describe('Facts, constraints, or prior findings the Dot needs.'),
      }),
      execute: async ({ dot_id, task, context }) => {
        options.check();
        if (started >= maxDelegationsPerRun)
          throw new Error(
            'Delegation limit for this turn reached; finish the task yourself.',
          );
        started += 1;
        const result = await options.delegation.delegate({
          from: options.from,
          parentThreadId: options.parentThreadId,
          targetDotId: dot_id,
          task,
          context,
          deadline: options.deadline,
          signal: options.signal,
        });
        options.check();
        return {
          dot: result.dotName,
          conversationId: result.threadId,
          reply:
            result.reply.length > replyLimit
              ? `${result.reply.slice(0, replyLimit)}\n…[truncated ${result.reply.length - replyLimit} characters]`
              : result.reply,
        };
      },
    }),
  ];
}
