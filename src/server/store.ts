import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Action,
  Detail,
  Memory,
  MemorySource,
  Result,
  Run,
  Settings,
  Task,
  TaskEvent,
} from '../shared/types.js';

export type Claim = Task & { lease: string };
const defaults: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
  autoMemory: true,
};
export const memoryLimit = 500;
// History kept per task; older runs and events are pruned after each run.
export const runHistoryLimit = 200;
export const eventHistoryLimit = 1000;
// First retry of a failed recurring task; doubles per consecutive failure,
// never later than the task's own interval.
const retryBaseMs = 60_000;
// Prompt budget: newest memories first, until either cap is reached.
const promptMemoryCount = 100;
const promptMemoryChars = 8000;
type MemoryRow = Omit<Memory, 'updatedAt'> & { updatedAt: number | null };
const memoryRow = (row: MemoryRow): Memory => ({
  ...row,
  dotId: row.dotId ?? null,
  threadId: row.threadId ?? null,
  updatedAt: row.updatedAt ?? row.createdAt,
});
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);`);
    for (const [column, definition] of [
      ['dotId', 'TEXT'],
      ['source', "TEXT NOT NULL DEFAULT 'user'"],
      ['threadId', 'TEXT'],
      ['updatedAt', 'INTEGER'],
    ]) {
      if (
        !this.db
          .prepare('PRAGMA table_info(memories)')
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${column} ${definition}`);
    }
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)')
      .run(JSON.stringify(defaults));
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE id=1')
      .get() as { value: string };
    return { ...defaults, ...(JSON.parse(row.value) as Settings) };
  }
  updateSettings(patch: Partial<Settings>): Settings {
    return this.transaction(() => {
      const previous = this.settings();
      const settings = { ...previous, ...patch };
      this.db
        .prepare('UPDATE settings SET value=? WHERE id=1')
        .run(JSON.stringify(settings));
      if (settingsInterruptRuns(previous, settings)) {
        const running = this.tasks().filter((t) => t.status === 'running');
        for (const task of running) {
          this.invalidate(
            task,
            'queued',
            'Run stopped because settings changed.',
          );
        }
      }
      return settings;
    });
  }
  tasks(): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
      .all() as unknown as Task[];
  }
  task(id: string): Task | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE id=?')
      .get(id) as unknown as Task | undefined;
  }
  createTask(prompt: string, intervalSeconds: number | null = null): Task {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?, ?, 'queued', ?, NULL, ?, ?, NULL, NULL, NULL)",
      )
      .run(id, prompt, intervalSeconds, now, now);
    this.event(id, null, 'Task added to the research queue.');
    return this.task(id)!;
  }
  detail(id: string): Detail | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const rows = this.db
      .prepare(
        'SELECT * FROM runs WHERE taskId=? ORDER BY startedAt DESC, rowid DESC',
      )
      .all(id) as unknown as (Omit<Run, 'result'> & {
      result: string | null;
    })[];
    return {
      task,
      runs: rows.map((row) => ({
        ...row,
        result: row.result ? (JSON.parse(row.result) as Result) : null,
      })),
      events: this.db
        .prepare('SELECT * FROM events WHERE taskId=? ORDER BY id')
        .all(id) as unknown as TaskEvent[],
    };
  }
  event(taskId: string, runId: string | null, text: string) {
    this.db
      .prepare(
        'INSERT INTO events (taskId, runId, text, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(taskId, runId, text, Date.now());
  }
  private invalidate(task: Task, status: string, reason: string) {
    const now = Date.now();
    if (task.lease)
      this.db
        .prepare(
          "UPDATE runs SET status='interrupted', finishedAt=?, error=? WHERE id=? AND status='running'",
        )
        .run(now, reason, task.lease);
    this.db
      .prepare(
        'UPDATE tasks SET status=?, lease=NULL, leaseUntil=NULL, updatedAt=? WHERE id=?',
      )
      .run(status, now, task.id);
    this.event(task.id, task.lease, reason);
  }
  action(id: string, action: Action): Task | undefined {
    return this.transaction(() => {
      const task = this.task(id);
      if (!task) return undefined;
      if (action === 'run' && task.status === 'running') return task;
      const status =
        action === 'run'
          ? 'queued'
          : action === 'pause'
            ? 'paused'
            : 'cancelled';
      this.invalidate(
        task,
        status,
        action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
      );
      this.db
        .prepare('UPDATE tasks SET error=NULL, nextRunAt=NULL WHERE id=?')
        .run(id);
      return this.task(id);
    });
  }
  schedule(id: string, intervalSeconds: number | null): Task | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const next =
      intervalSeconds && ['completed', 'failed'].includes(task.status)
        ? Date.now() + intervalSeconds * 1000
        : null;
    this.db
      .prepare(
        'UPDATE tasks SET intervalSeconds=?, nextRunAt=?, updatedAt=? WHERE id=?',
      )
      .run(intervalSeconds, next, Date.now(), id);
    this.event(
      id,
      null,
      intervalSeconds
        ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
        : 'Repeat schedule removed.',
    );
    return this.task(id);
  }
  claim(now = Date.now(), leaseMs = 180_000): Claim | null {
    return this.transaction(() => {
      const settings = this.settings();
      if (settings.paused || !settings.researchAllowed) return null;
      const expired = this.db
        .prepare("SELECT * FROM tasks WHERE status='running' AND leaseUntil<=?")
        .all(now) as unknown as Task[];
      for (const task of expired)
        this.invalidate(
          task,
          'queued',
          'Previous worker lease expired; safely retrying.',
        );
      const task = this.db
        .prepare(
          "SELECT * FROM tasks WHERE status='queued' OR (status IN ('completed','failed') AND nextRunAt IS NOT NULL AND nextRunAt<=?) ORDER BY createdAt LIMIT 1",
        )
        .get(now) as unknown as Task | undefined;
      if (!task) return null;
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE tasks SET status='running', lease=?, leaseUntil=?, nextRunAt=NULL, error=NULL, updatedAt=? WHERE id=?",
        )
        .run(lease, now + leaseMs, now, task.id);
      this.db
        .prepare(
          "INSERT INTO runs VALUES (?, ?, 'running', ?, NULL, NULL, NULL)",
        )
        .run(lease, task.id, now);
      this.event(task.id, lease, 'Research worker started.');
      return { ...this.task(task.id)!, lease };
    });
  }
  /** Extends a held lease; false once the claim is no longer owned. */
  renew(claim: Claim, until: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE tasks SET leaseUntil=? WHERE id=? AND lease=? AND status='running'",
        )
        .run(until, claim.id, claim.lease).changes > 0
    );
  }
  owns(claim: Claim): boolean {
    const task = this.task(claim.id);
    return task?.status === 'running' && task.lease === claim.lease;
  }
  finish(claim: Claim, result: Result, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.owns(claim)) return false;
      const task = this.task(claim.id)!;
      this.db
        .prepare(
          "UPDATE runs SET status='completed', finishedAt=?, result=? WHERE id=?",
        )
        .run(now, JSON.stringify(result), claim.lease);
      this.db
        .prepare(
          "UPDATE tasks SET status='completed', lease=NULL, leaseUntil=NULL, updatedAt=?, nextRunAt=? WHERE id=?",
        )
        .run(
          now,
          task.intervalSeconds ? now + task.intervalSeconds * 1000 : null,
          claim.id,
        );
      this.event(
        claim.id,
        claim.lease,
        result.sample
          ? 'Fictional sample brief ready.'
          : 'Research brief ready.',
      );
      this.prune(claim.id);
      return true;
    });
  }
  release(claim: Claim, reason: string) {
    this.transaction(() => {
      if (this.owns(claim)) this.invalidate(claim, 'queued', reason);
    });
  }
  /**
   * Records a failed run. A recurring task stays scheduled: it retries after
   * a backoff that doubles per consecutive failure, capped at its interval.
   */
  fail(claim: Claim, error: string, now = Date.now()) {
    this.transaction(() => {
      if (!this.owns(claim)) return;
      const task = this.task(claim.id)!;
      this.db
        .prepare(
          "UPDATE runs SET status='failed', finishedAt=?, error=? WHERE id=?",
        )
        .run(now, error, claim.lease);
      let nextRunAt: number | null = null;
      if (task.intervalSeconds) {
        const failures = this.consecutiveFailures(claim.id);
        const backoff = retryBaseMs * 2 ** Math.min(failures - 1, 20);
        nextRunAt = now + Math.min(task.intervalSeconds * 1000, backoff);
      }
      this.db
        .prepare(
          "UPDATE tasks SET status='failed', lease=NULL, leaseUntil=NULL, error=?, nextRunAt=?, updatedAt=? WHERE id=?",
        )
        .run(error, nextRunAt, now, claim.id);
      this.event(claim.id, claim.lease, error);
      if (nextRunAt)
        this.event(
          claim.id,
          claim.lease,
          `Retrying in ${Math.round((nextRunAt - now) / 60_000)} minutes.`,
        );
      this.prune(claim.id);
    });
  }
  private consecutiveFailures(taskId: string) {
    const statuses = this.db
      .prepare(
        'SELECT status FROM runs WHERE taskId=? ORDER BY startedAt DESC, rowid DESC LIMIT 32',
      )
      .all(taskId) as { status: string }[];
    const index = statuses.findIndex((run) => run.status !== 'failed');
    return Math.max(1, index === -1 ? statuses.length : index);
  }
  /** Keeps only the newest runs and events of a task. */
  private prune(taskId: string) {
    this.db
      .prepare(
        'DELETE FROM runs WHERE taskId=? AND id NOT IN (SELECT id FROM runs WHERE taskId=? ORDER BY startedAt DESC, rowid DESC LIMIT ?)',
      )
      .run(taskId, taskId, runHistoryLimit);
    this.db
      .prepare(
        'DELETE FROM events WHERE taskId=? AND id NOT IN (SELECT id FROM events WHERE taskId=? ORDER BY id DESC LIMIT ?)',
      )
      .run(taskId, taskId, eventHistoryLimit);
  }
  memories(): Memory[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM memories ORDER BY COALESCE(updatedAt, createdAt) DESC',
        )
        .all() as unknown as MemoryRow[]
    ).map(memoryRow);
  }
  memory(id: string): Memory | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as
      MemoryRow | undefined;
    return row && memoryRow(row);
  }
  /** Global memories plus those scoped to the Dot; never another Dot's. */
  memoriesFor(dotId: string | null): Memory[] {
    return this.memories().filter(
      (memory) => memory.dotId === null || memory.dotId === dotId,
    );
  }
  /** The newest visible memories that fit the prompt budget. */
  promptMemories(dotId: string | null): Memory[] {
    const selected: Memory[] = [];
    let chars = 0;
    for (const memory of this.memoriesFor(dotId)) {
      if (selected.length >= promptMemoryCount) break;
      chars += memory.text.length;
      if (chars > promptMemoryChars) break;
      selected.push(memory);
    }
    return selected;
  }
  saveMemory(
    value: {
      text: string;
      dotId?: string | null;
      source?: MemorySource;
      threadId?: string | null;
    },
    id: string = randomUUID(),
  ): Memory {
    const existing = this.memory(id);
    if (!existing && this.memories().length >= memoryLimit)
      throw new Error(
        `Memory is full (${memoryLimit} items). Delete some memories first.`,
      );
    const now = Date.now();
    if (existing)
      this.db
        .prepare('UPDATE memories SET text=?, dotId=?, updatedAt=? WHERE id=?')
        .run(
          value.text,
          value.dotId === undefined ? existing.dotId : value.dotId,
          now,
          id,
        );
    else
      this.db
        .prepare(
          'INSERT INTO memories (id, text, createdAt, dotId, source, threadId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          value.text,
          now,
          value.dotId ?? null,
          value.source ?? 'user',
          value.threadId ?? null,
          now,
        );
    return this.memory(id)!;
  }
  deleteMemory(id: string): boolean {
    return (
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0
    );
  }
}
/**
 * Settings changes that stop running work. The store requeues running tasks
 * for these, so the runner's abort is a restart rather than a failure.
 */
export function settingsInterruptRuns(previous: Settings, next: Settings) {
  return (
    (!previous.paused && next.paused) ||
    (previous.researchAllowed && !next.researchAllowed) ||
    previous.memoryAllowed !== next.memoryAllowed ||
    (previous.modelProvider ?? null) !== (next.modelProvider ?? null) ||
    (previous.model ?? null) !== (next.model ?? null)
  );
}
