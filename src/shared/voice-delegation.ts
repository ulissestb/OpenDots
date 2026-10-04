// ChatGPT-subscription voice calls use the Codex "frameless" protocol: the
// voice model hands tasks to the client with `delegation.created`, and the
// client answers with `delegation.context.append` frames
// (codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs).

// The provider rejects context appends over 500 bytes of text.
const appendMaxBytes = 500;
// Codex caps a spoken backend result at about 1000 tokens.
const resultMaxBytes = 4000;
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

export interface VoiceDelegation {
  id: string;
  request: string;
}

/** Reads a client-targeted delegation from a frameless realtime event. */
export function parseDelegation(data: unknown): VoiceDelegation | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const event = data as { type?: unknown; item?: unknown };
  if (event.type !== 'delegation.created') return undefined;
  const item = event.item as
    | { type?: unknown; target?: unknown; id?: unknown; content?: unknown }
    | undefined;
  if (
    item?.type !== 'delegation' ||
    item.target !== 'client' ||
    typeof item.id !== 'string' ||
    !Array.isArray(item.content)
  )
    return undefined;
  const request = item.content
    .filter(
      (part: { type?: unknown; text?: unknown }) =>
        part?.type === 'input_text' && typeof part.text === 'string',
    )
    .map((part: { text: string }) => part.text)
    .join('')
    .trim();
  return request ? { id: item.id, request } : undefined;
}

/** Splits text into pieces of at most `max` UTF-8 bytes on code points. */
export function chunkUtf8(text: string, max = appendMaxBytes) {
  const chunks: string[] = [];
  let current = '';
  let size = 0;
  for (const char of text) {
    const bytes = byteLength(char);
    if (size + bytes > max) {
      chunks.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Builds the frames that return a delegation's result to the voice model. */
export function delegationResultFrames(
  delegationId: string,
  text: string,
  channel: 'speakable' | 'commentary' = 'speakable',
) {
  let result = text.trim() || 'Done.';
  if (byteLength(result) > resultMaxBytes) {
    const marker = ' […truncated; the full result is in the chat]';
    result =
      chunkUtf8(result, resultMaxBytes - byteLength(marker))[0]! + marker;
  }
  return chunkUtf8(result).map((piece) =>
    JSON.stringify({
      type: 'delegation.context.append',
      delegation_item_id: delegationId,
      channel,
      content: [{ type: 'input_text', text: piece }],
    }),
  );
}
