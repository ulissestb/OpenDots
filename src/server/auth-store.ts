import { DatabaseSync } from 'node:sqlite';
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { passwordProblem } from '../shared/auth.js';

export interface User {
  id: string;
  username: string;
  mustChangePassword: boolean;
}
interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  mustChangePassword: number;
}
export const defaultAdmin = { username: 'admin', password: 'admin' };
/**
 * The password used if this start seeds the admin user. Loopback keeps the
 * documented admin/admin; an externally reachable binding gets a random one
 * so a fresh deployment cannot be taken over before its owner signs in.
 */
export function initialAdminPassword(
  configured: string | undefined,
  external: boolean,
): { password?: string; generated: boolean } {
  if (configured) return { password: configured, generated: false };
  if (!external) return { generated: false };
  return { password: randomBytes(18).toString('base64url'), generated: true };
}
const sessionLifetime = 30 * 24 * 60 * 60_000;
const sessionIdle = 7 * 24 * 60 * 60_000;
const touchInterval = 60_000;
const scryptParams = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, scryptParams);
  const { N, r, p } = scryptParams;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), 64, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: scryptParams.maxmem,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const sessionId = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  mustChangePassword: !!row.mustChangePassword,
});
export class AuthStore {
  private db: DatabaseSync;
  /** True when this instance created the admin user (first start). */
  readonly seeded: boolean;
  // Verified for unknown usernames so response timing does not reveal accounts.
  private dummyHash = hashPassword(randomUUID());
  constructor(
    path: string,
    seedPassword?: string,
    private now: () => number = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, passwordHash TEXT NOT NULL, mustChangePassword INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, userId TEXT NOT NULL, createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);`);
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM users')
      .get() as { count: number };
    this.seeded = !count.count;
    if (this.seeded) {
      const time = this.now();
      this.db
        .prepare('INSERT INTO users VALUES (?,?,?,1,?,?)')
        .run(
          randomUUID(),
          defaultAdmin.username,
          hashPassword(seedPassword || defaultAdmin.password),
          time,
          time,
        );
    }
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
  private row(username: string) {
    return this.db
      .prepare('SELECT * FROM users WHERE username=?')
      .get(username) as UserRow | undefined;
  }
  private rowById(id: string) {
    return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as
      UserRow | undefined;
  }
  verify(username: string, password: string): User | null {
    const row = this.row(username);
    const valid = verifyPassword(password, row?.passwordHash ?? this.dummyHash);
    return row && valid ? toUser(row) : null;
  }
  isDefaultPassword(): boolean {
    const row = this.row(defaultAdmin.username);
    return !!row && verifyPassword(defaultAdmin.password, row.passwordHash);
  }
  createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    const time = this.now();
    this.db
      .prepare('INSERT INTO sessions VALUES (?,?,?,?,?)')
      .run(sessionId(token), userId, time, time, time + sessionLifetime);
    return token;
  }
  session(token: string): User | null {
    const id = sessionId(token);
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as
      { userId: string; lastSeenAt: number; expiresAt: number } | undefined;
    if (!row) return null;
    const time = this.now();
    if (row.expiresAt <= time || row.lastSeenAt + sessionIdle <= time) {
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      return null;
    }
    const user = this.rowById(row.userId);
    if (!user) return null;
    if (time - row.lastSeenAt >= touchInterval)
      this.db
        .prepare('UPDATE sessions SET lastSeenAt=? WHERE id=?')
        .run(time, id);
    return toUser(user);
  }
  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId(token));
  }
  /** Returns an error message, or a new session token after revoking all others. */
  changePassword(
    userId: string,
    current: string,
    next: string,
  ): { error: string; status: 400 | 401 } | { token: string; user: User } {
    const row = this.rowById(userId);
    if (!row || !verifyPassword(current, row.passwordHash))
      return { error: 'Current password is incorrect.', status: 401 };
    const problem =
      passwordProblem(next, row.username) ??
      (current === next
        ? 'Choose a password different from the current one.'
        : undefined);
    if (problem) return { error: problem, status: 400 };
    const hash = hashPassword(next);
    return this.transaction(() => {
      this.db
        .prepare(
          'UPDATE users SET passwordHash=?, mustChangePassword=0, updatedAt=? WHERE id=?',
        )
        .run(hash, this.now(), userId);
      this.db.prepare('DELETE FROM sessions WHERE userId=?').run(userId);
      const token = this.createSession(userId);
      return { token, user: toUser(this.rowById(userId)!) };
    });
  }
  resetPassword(username: string, next: string, mustChange = true) {
    const row = this.row(username);
    if (!row) throw new Error(`User ${username} not found.`);
    const hash = hashPassword(next);
    this.transaction(() => {
      this.db
        .prepare(
          'UPDATE users SET passwordHash=?, mustChangePassword=?, updatedAt=? WHERE id=?',
        )
        .run(hash, mustChange ? 1 : 0, this.now(), row.id);
      this.db.prepare('DELETE FROM sessions WHERE userId=?').run(row.id);
    });
  }
  pruneSessions() {
    const time = this.now();
    this.db
      .prepare('DELETE FROM sessions WHERE expiresAt<=? OR lastSeenAt<=?')
      .run(time, time - sessionIdle);
  }
}
