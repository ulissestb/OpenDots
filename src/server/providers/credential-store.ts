import { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
}
export interface StoredCredential {
  provider: string;
  /** null when the stored payload cannot be decrypted with the current secret. */
  tokens: OAuthTokens | null;
  accountId: string | null;
  email: string | null;
  plan: string | null;
  state: 'connected' | 'needs_reauth';
  expiresAt: number | null;
  updatedAt: number;
}
interface Row {
  provider: string;
  payload: string;
  accountId: string | null;
  email: string | null;
  plan: string | null;
  state: string;
  expiresAt: number | null;
  updatedAt: number;
}
export type CredentialInput = Omit<
  StoredCredential,
  'provider' | 'state' | 'updatedAt'
> & {
  tokens: OAuthTokens;
};
/**
 * Server-side OAuth credentials. Encrypted with AES-256-GCM when
 * CREDENTIALS_SECRET is set; this protects copies of the database, not a host
 * where the secret sits next to it.
 */
export class ProviderCredentialStore {
  private db: DatabaseSync;
  private key?: Buffer;
  constructor(
    path: string,
    secret?: string,
    private now: () => number = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS provider_credentials(provider TEXT PRIMARY KEY, payload TEXT NOT NULL, accountId TEXT, email TEXT, plan TEXT, state TEXT NOT NULL DEFAULT 'connected', expiresAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`);
    if (secret) this.key = scryptSync(secret, 'opendots-credentials', 32);
  }
  close() {
    this.db.close();
  }
  private encode(tokens: OAuthTokens): string {
    if (!this.key) return JSON.stringify({ v: 0, tokens });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(tokens), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  }
  private decode(payload: string): OAuthTokens | null {
    try {
      const value = JSON.parse(payload) as {
        v: number;
        tokens?: OAuthTokens;
        iv?: string;
        tag?: string;
        data?: string;
      };
      if (value.v === 0) return value.tokens ?? null;
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
      ) as OAuthTokens;
    } catch {
      return null;
    }
  }
  get(provider: string): StoredCredential | undefined {
    const row = this.db
      .prepare('SELECT * FROM provider_credentials WHERE provider=?')
      .get(provider) as Row | undefined;
    if (!row) return undefined;
    const tokens = this.decode(row.payload);
    return {
      provider: row.provider,
      tokens,
      accountId: row.accountId,
      email: row.email,
      plan: row.plan,
      state: tokens && row.state === 'connected' ? 'connected' : 'needs_reauth',
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
    };
  }
  /**
   * Saves tokens. With `expectedUpdatedAt`, only replaces the row if no other
   * writer changed it since (refresh tokens rotate and are single-use).
   */
  save(
    provider: string,
    input: CredentialInput,
    expectedUpdatedAt?: number,
  ): boolean {
    const time = Math.max(
      this.now(),
      (expectedUpdatedAt ?? this.get(provider)?.updatedAt ?? 0) + 1,
    );
    const payload = this.encode(input.tokens);
    if (expectedUpdatedAt !== undefined)
      return (
        Number(
          this.db
            .prepare(
              "UPDATE provider_credentials SET payload=?, accountId=?, email=?, plan=?, state='connected', expiresAt=?, updatedAt=? WHERE provider=? AND updatedAt=?",
            )
            .run(
              payload,
              input.accountId,
              input.email,
              input.plan,
              input.expiresAt,
              time,
              provider,
              expectedUpdatedAt,
            ).changes,
        ) === 1
      );
    this.db
      .prepare(
        "INSERT INTO provider_credentials VALUES (?,?,?,?,?,'connected',?,?,?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload, accountId=excluded.accountId, email=excluded.email, plan=excluded.plan, state='connected', expiresAt=excluded.expiresAt, updatedAt=excluded.updatedAt",
      )
      .run(
        provider,
        payload,
        input.accountId,
        input.email,
        input.plan,
        input.expiresAt,
        time,
        time,
      );
    return true;
  }
  markNeedsReauth(provider: string) {
    this.db
      .prepare(
        "UPDATE provider_credentials SET state='needs_reauth', updatedAt=? WHERE provider=?",
      )
      .run(this.now(), provider);
  }
  delete(provider: string) {
    this.db
      .prepare('DELETE FROM provider_credentials WHERE provider=?')
      .run(provider);
  }
}
