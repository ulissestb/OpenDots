import type { CodexAuth } from './providers/codex-auth.js';

/** A created provider call, with what is needed to hang it up later. */
export interface VoiceCall {
  backend: 'chatgpt' | 'api-key';
  /** Provider call id, from the Location header. */
  providerId: string;
  sdp: string;
  hangup: (signal: AbortSignal) => Promise<Response>;
}

/**
 * The provider call id is the last `rtc_…` or UUID path segment. Backends
 * return different Location shapes, e.g. `/v1/realtime/calls/rtc_x`,
 * `/v1/realtime/calls/calls/rtc_x`, or `/v1/live/<uuid>`.
 */
export function callIdFromLocation(location: string | null) {
  if (!location) return undefined;
  let path: string;
  try {
    path = new URL(location, 'https://provider.invalid').pathname;
  } catch {
    return undefined;
  }
  return path
    .split('/')
    .filter(Boolean)
    .reverse()
    .find(
      (segment) =>
        /^rtc_[A-Za-z0-9_-]{1,200}$/.test(segment) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          segment,
        ),
    );
}

export class VoiceProviderError extends Error {
  constructor(
    message: string,
    /** Quota is per account, so other endpoints would fail the same way. */
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

const sanitize = (text: string) =>
  text.replace(/\s+/g, ' ').trim().slice(0, 200);

async function readAnswer(
  response: Response,
  label: string,
  hangup: (providerId: string) => Promise<unknown>,
) {
  if (!response.ok) {
    const detail = await response.text().then(sanitize, () => '');
    throw new VoiceProviderError(
      `${label}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
    );
  }
  const providerId = callIdFromLocation(response.headers.get('location'));
  if (!providerId)
    throw new VoiceProviderError(
      `${label}: no controllable call id in the response.`,
    );
  const sdp = await response.text();
  if (
    sdp.length > 100_000 ||
    !sdp.startsWith('v=0') ||
    !sdp.includes('m=audio')
  ) {
    // The provider already holds a call; release it before failing.
    await hangup(providerId).catch(() => {});
    throw new VoiceProviderError(`${label}: invalid SDP answer.`);
  }
  return { providerId, sdp };
}

// ChatGPT-subscription calls follow the Codex CLI's realtime client
// (codex-rs/codex-api/src/endpoint/realtime_call.rs). This path is
// undocumented and may change; the API-key path is the official one.
// The ChatGPT backend accepts only the "frameless" protocol (Codex realtime
// v3): a JSON {sdp, session} body with OpenAI-Alpha: quicksilver=v2.
// api.openai.com rejects subscription tokens ("Voice session access denied").
const chatgptCandidates = [
  {
    label: 'ChatGPT realtime',
    base: 'https://chatgpt.com/backend-api/codex',
    body: (sdp: string, session: object) => ({
      body: JSON.stringify({ sdp, session }),
      headers: { 'Content-Type': 'application/json' } as Record<string, string>,
    }),
  },
];

export async function chatgptHeaders(auth: CodexAuth, force = false) {
  const { token, accountId } = await auth.accessToken({ force });
  return {
    Authorization: `Bearer ${token}`,
    ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
    originator: 'opendots',
    'openai-alpha': 'quicksilver=v2',
  };
}

/** Creates a call on the ChatGPT subscription, trying each known endpoint. */
export async function createChatgptCall(
  auth: CodexAuth,
  sdp: string,
  session: object,
  signal: AbortSignal,
  transport: typeof fetch,
): Promise<VoiceCall> {
  const failures: string[] = [];
  for (const candidate of chatgptCandidates) {
    try {
      const send = async (force: boolean) => {
        const { body, headers } = candidate.body(sdp, session);
        return transport(
          `${candidate.base}/realtime/calls?intent=quicksilver&architecture=avas`,
          {
            method: 'POST',
            headers: { ...(await chatgptHeaders(auth, force)), ...headers },
            body,
            signal,
            redirect: 'error',
          },
        );
      };
      let response = await send(false);
      if (response.status === 401) response = await send(true);
      if (response.status === 429)
        throw new VoiceProviderError(
          `${candidate.label}: ChatGPT voice usage limit reached (HTTP 429).`,
          true,
        );
      // Frameless sessions have no HTTP hangup (it returns 403): the Codex
      // client ends them with `session.close` on the realtime channel, which
      // the browser sends over the data channel before closing the peer.
      const released = async () => new Response(null, { status: 204 });
      const { providerId, sdp: answer } = await readAnswer(
        response,
        candidate.label,
        released,
      );
      return {
        backend: 'chatgpt',
        providerId,
        sdp: answer,
        hangup: released,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(
        error instanceof VoiceProviderError
          ? error.message
          : `${candidate.label}: ${error instanceof Error ? error.message : 'request failed'}`,
      );
      if (error instanceof VoiceProviderError && error.rateLimited) break;
    }
  }
  throw new VoiceProviderError(failures.join(' | '));
}

/** Creates a call on the official Realtime API with VOICE_API_KEY. */
export async function createApiKeyCall(
  key: string,
  sdp: string,
  session: object,
  signal: AbortSignal,
  transport: typeof fetch,
): Promise<VoiceCall> {
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(session));
  const headers = { Authorization: `Bearer ${key}` };
  const response = await transport('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers,
    body: form,
    signal,
    redirect: 'error',
  });
  const hangup = (providerId: string, hangupSignal: AbortSignal) =>
    transport(`https://api.openai.com/v1/realtime/calls/${providerId}/hangup`, {
      method: 'POST',
      headers,
      signal: hangupSignal,
      redirect: 'error',
    });
  const { providerId, sdp: answer } = await readAnswer(
    response,
    'Realtime API key',
    (id) => hangup(id, AbortSignal.timeout(5000)),
  );
  return {
    backend: 'api-key',
    providerId,
    sdp: answer,
    hangup: (hangupSignal) => hangup(providerId, hangupSignal),
  };
}
