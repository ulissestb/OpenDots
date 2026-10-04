import { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type McpServerInfo,
  type McpServerInput,
  type McpToolInfo,
  mcpServerInputSchema,
} from '../shared/mcp.js';

export interface McpServerRecord extends McpServerInfo {
  headers: Record<string, string>;
}
interface Row {
  id: string;
  name: string;
  url: string;
  headers: string;
  enabled: number;
  allDots: number;
  allowedTools: string | null;
  tools: string;
  lastError: string | null;
  checkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
/**
 * Remote MCP servers. Header values (API keys, tokens) are encrypted with
 * AES-256-GCM when CREDENTIALS_SECRET is set and never returned to the browser.
 */
export class McpStore {
  private db: DatabaseSync;
  private key?: Buffer;
  constructor(path: string, secret?: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mcp_servers(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, url TEXT NOT NULL, headers TEXT NOT NULL, enabled INTEGER NOT NULL, allDots INTEGER NOT NULL, allowedTools TEXT, tools TEXT NOT NULL, lastError TEXT, checkedAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dot_mcp_servers(dotId TEXT NOT NULL, serverId TEXT NOT NULL, PRIMARY KEY(dotId, serverId));`);
    if (secret) this.key = scryptSync(secret, 'opendots-mcp-headers', 32);
  }
  close() {
    this.db.close();
  }
  private seal(headers: Record<string, string>) {
    if (!this.key) return JSON.stringify({ v: 0, headers });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(headers), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  }
  /** null when the stored headers cannot be decrypted with the current secret. */
  private open(payload: string): Record<string, string> | null {
    try {
      const value = JSON.parse(payload) as {
        v: number;
        headers?: Record<string, string>;
        iv?: string;
        tag?: string;
        data?: string;
      };
      if (value.v === 0) return value.headers ?? {};
      if (!this.key || !value.iv || !value.tag || !value.data) return null;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(value.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.data, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      ) as Record<string, string>;
    } catch {
      return null;
    }
  }
  private read(row: Row): McpServerRecord {
    const headers = this.open(row.headers);
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      headers: headers ?? {},
      headerNames: Object.keys(headers ?? {}),
      enabled: !!row.enabled,
      dotIds: row.allDots
        ? null
        : this.db
            .prepare(
              'SELECT dotId FROM dot_mcp_servers WHERE serverId=? ORDER BY dotId',
            )
            .all(row.id)
            .map((grant) => String(grant.dotId)),
      allowedTools: row.allowedTools
        ? (JSON.parse(row.allowedTools) as string[])
        : null,
      tools: JSON.parse(row.tools) as McpToolInfo[],
      lastError:
        headers === null
          ? 'Stored headers cannot be decrypted: check CREDENTIALS_SECRET and re-enter them.'
          : row.lastError,
      checkedAt: row.checkedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  list(): McpServerRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM mcp_servers ORDER BY name')
        .all() as unknown as Row[]
    ).map((row) => this.read(row));
  }
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);
    return row ? this.read(row as unknown as Row) : undefined;
  }
  /** Enabled servers this Dot may use. */
  forDot(dotId: string) {
    return this.list().filter(
      (server) =>
        server.enabled &&
        (server.dotIds === null || server.dotIds.includes(dotId)),
    );
  }
  /** Cheap fingerprint of a Dot's usable servers, for the run watcher. */
  signature(dotId: string): string {
    return this.db
      .prepare(
        `SELECT id, updatedAt FROM mcp_servers WHERE enabled=1 AND (allDots=1 OR id IN (SELECT serverId FROM dot_mcp_servers WHERE dotId=?)) ORDER BY name`,
      )
      .all(dotId)
      .map((row) => `${String(row.id)}@${String(row.updatedAt)}`)
      .join(',');
  }
  save(input: McpServerInput, id?: string): McpServerRecord {
    const server = mcpServerInputSchema.parse(input);
    const current = id ? this.get(id) : undefined;
    if (id && !current) throw new Error('MCP server not found.');
    const taken = this.db
      .prepare('SELECT id FROM mcp_servers WHERE name=?')
      .get(server.name);
    if (taken && taken.id !== id)
      throw new Error(`An MCP server named ${server.name} already exists.`);
    const headers: Record<string, string> = {};
    for (const header of server.headers) {
      const value = header.value ?? current?.headers[header.name];
      if (value === undefined)
        throw new Error(`Enter a value for the ${header.name} header.`);
      headers[header.name] = value;
    }
    // A new address or credentials invalidate the reviewed tool list.
    const reset =
      !current ||
      current.url !== server.url ||
      JSON.stringify(current.headers) !== JSON.stringify(headers);
    // "All tools" means all tools the owner reviewed. When a new address or
    // credentials clear that review, keep the old approval as an explicit list
    // so the next test cannot approve tools the owner never saw.
    const allowedTools =
      reset && current && server.allowedTools === null
        ? current.tools.map((tool) => tool.name)
        : server.allowedTools;
    const now = Date.now();
    const serverId = id ?? randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO mcp_servers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, headers=excluded.headers,
            enabled=excluded.enabled, allDots=excluded.allDots, allowedTools=excluded.allowedTools,
            tools=excluded.tools, lastError=excluded.lastError, checkedAt=excluded.checkedAt,
            updatedAt=excluded.updatedAt`,
        )
        .run(
          serverId,
          server.name,
          server.url,
          this.seal(headers),
          +server.enabled,
          +(server.dotIds === null),
          allowedTools ? JSON.stringify(allowedTools) : null,
          JSON.stringify(reset ? [] : current!.tools),
          reset ? null : current!.lastError,
          reset ? null : current!.checkedAt,
          current?.createdAt ?? now,
          now,
        );
      this.db
        .prepare('DELETE FROM dot_mcp_servers WHERE serverId=?')
        .run(serverId);
      for (const dotId of new Set(server.dotIds ?? []))
        this.db
          .prepare('INSERT INTO dot_mcp_servers VALUES (?, ?)')
          .run(dotId, serverId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(serverId)!;
  }
  /** Records a connection test: the reviewed tool list, or the failure. */
  recordTest(id: string, result: { tools: McpToolInfo[] } | { error: string }) {
    this.db
      .prepare(
        'tools' in result
          ? 'UPDATE mcp_servers SET tools=?, lastError=NULL, checkedAt=? WHERE id=?'
          : 'UPDATE mcp_servers SET lastError=?, checkedAt=? WHERE id=?',
      )
      .run(
        'tools' in result ? JSON.stringify(result.tools) : result.error,
        Date.now(),
        id,
      );
    return this.get(id)!;
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM dot_mcp_servers WHERE serverId=?').run(id);
    return (
      this.db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id).changes > 0
    );
  }
}
/** The browser view of a server: header names only. */
export function publicServer(server: McpServerRecord): McpServerInfo {
  const { headers, ...rest } = server;
  void headers;
  return rest;
}
