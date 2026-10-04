export type Status =
  'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
import type { ProviderId, ProviderStatus } from './providers.js';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  /** Extract durable memories from finished chat turns (one extra model call). */
  autoMemory?: boolean;
  /** Default model provider; absent or null picks the first ready one. */
  modelProvider?: ProviderId | null;
  /** Default model; absent or null uses the provider's default. */
  model?: string | null;
}
export interface Task {
  id: string;
  prompt: string;
  status: Status;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
}
export interface Source {
  title: string;
  url: string;
  excerpt: string;
}
export interface Result {
  text: string;
  sources: Source[];
  sample: boolean;
  screenshot?: string;
}
export interface Run {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: Result | null;
  error: string | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}
export type MemorySource = 'user' | 'agent' | 'auto';
export interface Memory {
  id: string;
  text: string;
  /** Null is a global memory; otherwise only this Dot sees it. */
  dotId: string | null;
  source: MemorySource;
  /** Conversation the memory was learned from, if any. */
  threadId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface Detail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  mode: 'sample' | 'live';
  configured: boolean;
}
export type Action = 'run' | 'pause' | 'cancel';
export interface Space {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}
export interface Dot {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  createdAt: number;
  learningContainerId?: string | null;
  skillDeliveryEnabled?: boolean;
  /**
   * May hand tasks to other Dots. A delegated run gets only what both Dots may
   * do: Spaces, research, computer capabilities and MCP servers they share.
   */
  delegationAllowed: boolean;
  /** May create and update its own skills. */
  skillAuthoringAllowed: boolean;
  /** Overrides the workspace default provider; null uses the default. */
  provider?: ProviderId | null;
  model?: string | null;
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Frozen at creation; null means this conversation does not participate. */
  learningContainerId?: string | null;
}
export interface CallReceipt {
  anchorMessageId?: string | null;
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  transcript: string;
  error: string | null;
}
export interface SetupStatus {
  intelligence: boolean;
  model: boolean;
  browser: boolean;
  voice: boolean;
  slack: string;
  missing: string[];
  providers?: ProviderStatus[];
  defaultProvider?: { provider: ProviderId | null; model: string | null };
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  setup: SetupStatus;
  calls: CallReceipt[];
}
