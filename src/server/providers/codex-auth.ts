import { randomUUID } from 'node:crypto';
import type {
  DeviceFlowStart,
  DeviceFlowStatus,
} from '../../shared/providers.js';
import type {
  OAuthTokens,
  ProviderCredentialStore,
  StoredCredential,
} from './credential-store.js';

// Public client and endpoints of the Codex CLI's ChatGPT sign-in, as used by
// hermes-agent. They are undocumented and may change.
export const codexClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const issuer = 'https://auth.openai.com';
const userCodeUrl = `${issuer}/api/accounts/deviceauth/usercode`;
const deviceTokenUrl = `${issuer}/api/accounts/deviceauth/token`;
const tokenUrl = `${issuer}/oauth/token`;
const redirectUri = `${issuer}/deviceauth/callback`;
export const codexVerificationUrl = `${issuer}/codex/device`;
export const codexProvider = 'openai-codex';
const flowLifetime = 15 * 60_000;
const refreshMargin = 120_000;

export class CodexReauthError extends Error {
  constructor() {
    super('ChatGPT sign-in expired. Reconnect it in Settings.');
  }
}
export function decodeJwtPayload(token?: string): Record<string, unknown> {
  try {
    const part = token?.split('.')[1];
    return part
      ? (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
          string,
          unknown
        >)
      : {};
  } catch {
    return {};
  }
}
function claims(tokens: OAuthTokens) {
  const access = decodeJwtPayload(tokens.access_token);
  const id = decodeJwtPayload(tokens.id_token);
  const auth = (payload: Record<string, unknown>) =>
    (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const pick = (key: string) =>
    (auth(access)[key] ?? auth(id)[key]) as string | undefined;
  const profile = (access['https://api.openai.com/profile'] ?? {}) as Record<
    string,
    unknown
  >;
  return {
    accountId: pick('chatgpt_account_id') ?? null,
    plan: pick('chatgpt_plan_type') ?? null,
    email: ((id.email ?? profile.email) as string | undefined) ?? null,
    expiresAt: typeof access.exp === 'number' ? access.exp * 1000 : null,
  };
}
interface Flow {
  id: string;
  deviceAuthId: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  status: DeviceFlowStatus;
  error?: string;
  controller: AbortController;
}
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
/** ChatGPT subscription sign-in through the Codex device flow. */
export class CodexAuth {
  private flow?: Flow;
  private refreshing?: Promise<{ token: string; accountId: string | null }>;
  constructor(
    private store: ProviderCredentialStore,
    private now: () => number = Date.now,
    private refreshTimeoutMs = 15_000,
  ) {}
  credential(): StoredCredential | undefined {
    return this.store.get(codexProvider);
  }
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    this.cancel();
    const response = await fetch(userCodeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: codexClientId }),
    });
    if (!response.ok)
      throw new Error(
        `ChatGPT sign-in could not start (HTTP ${response.status}).`,
      );
    const data = (await response.json()) as {
      device_auth_id?: string;
      user_code?: string;
      usercode?: string;
      interval?: string | number;
    };
    const userCode = data.user_code ?? data.usercode;
    if (!data.device_auth_id || !userCode)
      throw new Error('ChatGPT sign-in returned an unexpected response.');
    const flow: Flow = {
      id: randomUUID(),
      deviceAuthId: data.device_auth_id,
      userCode,
      interval: Math.max(1, Number(data.interval) || 5),
      expiresAt: this.now() + flowLifetime,
      status: 'pending',
      controller: new AbortController(),
    };
    this.flow = flow;
    void this.poll(flow);
    return {
      flowId: flow.id,
      userCode: flow.userCode,
      verificationUrl: codexVerificationUrl,
      expiresAt: flow.expiresAt,
      interval: flow.interval,
    };
  }
  flowStatus(flowId: string): { status: DeviceFlowStatus; error?: string } {
    if (this.flow?.id !== flowId) return { status: 'expired' };
    return { status: this.flow.status, error: this.flow.error };
  }
  cancel(flowId?: string) {
    const flow = this.flow;
    if (!flow || (flowId && flow.id !== flowId)) return;
    if (flow.status === 'pending') flow.status = 'cancelled';
    flow.controller.abort(new Error('Cancelled'));
  }
  stop() {
    this.cancel();
  }
  disconnect() {
    this.cancel();
    this.store.delete(codexProvider);
  }
  private async poll(flow: Flow) {
    const signal = flow.controller.signal;
    try {
      while (flow.status === 'pending') {
        await sleep(flow.interval * 1000, signal);
        if (this.now() >= flow.expiresAt) {
          flow.status = 'expired';
          return;
        }
        const response = await fetch(deviceTokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_auth_id: flow.deviceAuthId,
            user_code: flow.userCode,
          }),
          signal,
        });
        if (response.status === 403 || response.status === 404) continue;
        if (!response.ok)
          throw new Error(`ChatGPT sign-in failed (HTTP ${response.status}).`);
        const code = (await response.json()) as {
          authorization_code?: string;
          code_verifier?: string;
        };
        if (!code.authorization_code || !code.code_verifier)
          throw new Error('ChatGPT sign-in returned an unexpected response.');
        const tokens = await this.exchange(
          {
            grant_type: 'authorization_code',
            code: code.authorization_code,
            code_verifier: code.code_verifier,
            redirect_uri: redirectUri,
          },
          signal,
        );
        this.save(tokens);
        flow.status = 'complete';
      }
    } catch (error) {
      if (flow.status !== 'pending') return;
      flow.status = 'error';
      flow.error =
        error instanceof Error && error.message.startsWith('ChatGPT')
          ? error.message
          : 'ChatGPT sign-in failed.';
    }
  }
  private async exchange(
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OAuthTokens> {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: codexClientId }),
      signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string | { code?: string };
      };
      const code =
        typeof body.error === 'string' ? body.error : body.error?.code;
      if (
        params.grant_type === 'refresh_token' &&
        (response.status === 400 ||
          response.status === 401 ||
          code === 'invalid_grant' ||
          code === 'refresh_token_expired' ||
          code === 'refresh_token_reused')
      )
        throw new CodexReauthError();
      throw new Error(
        `ChatGPT token request failed (HTTP ${response.status}).`,
      );
    }
    const data = (await response.json()) as Partial<OAuthTokens> & {
      expires_in?: number;
    };
    if (!data.access_token)
      throw new Error('ChatGPT token response had no access token.');
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? params.refresh_token ?? '',
      id_token: data.id_token,
    };
  }
  private save(tokens: OAuthTokens, expectedUpdatedAt?: number) {
    const info = claims(tokens);
    return this.store.save(
      codexProvider,
      {
        tokens,
        accountId: info.accountId,
        email: info.email,
        plan: info.plan,
        expiresAt: info.expiresAt,
      },
      expectedUpdatedAt,
    );
  }
  /** A valid access token, refreshed when it is about to expire. */
  async accessToken(
    options: { force?: boolean } = {},
  ): Promise<{ token: string; accountId: string | null }> {
    const current = this.credential();
    if (!current?.tokens || current.state !== 'connected')
      throw new CodexReauthError();
    if (
      !options.force &&
      (current.expiresAt === null ||
        current.expiresAt - refreshMargin > this.now())
    )
      return {
        token: current.tokens.access_token,
        accountId: current.accountId,
      };
    this.refreshing ??= this.refresh(current).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async refresh(seen: StoredCredential) {
    const latest = this.credential();
    if (!latest?.tokens || latest.state !== 'connected')
      throw new CodexReauthError();
    // Another caller already rotated the tokens.
    if (latest.updatedAt !== seen.updatedAt)
      return { token: latest.tokens.access_token, accountId: latest.accountId };
    try {
      const tokens = await this.exchange(
        {
          grant_type: 'refresh_token',
          refresh_token: latest.tokens.refresh_token,
        },
        AbortSignal.timeout(this.refreshTimeoutMs),
      ).catch((error: unknown) => {
        // A slow token endpoint must not hold every caller on the shared refresh.
        if (error instanceof Error && error.name === 'TimeoutError')
          throw new Error('ChatGPT token refresh timed out. Try again.');
        if (error instanceof Error && !error.message.startsWith('ChatGPT'))
          throw new Error('ChatGPT token refresh failed. Try again.');
        throw error;
      });
      if (!this.save(tokens, latest.updatedAt)) {
        const winner = this.credential();
        if (!winner?.tokens) throw new CodexReauthError();
        return {
          token: winner.tokens.access_token,
          accountId: winner.accountId,
        };
      }
      return {
        token: tokens.access_token,
        accountId: claims(tokens).accountId,
      };
    } catch (error) {
      if (error instanceof CodexReauthError)
        this.store.markNeedsReauth(codexProvider);
      throw error;
    }
  }
}
