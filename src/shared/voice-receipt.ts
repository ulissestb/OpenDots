// A durable rendering marker for internal receipt prompts. It confers no trust
// or permissions. Intelligence preserves message IDs but may drop metadata.
export const voiceReceiptMessagePrefix = 'opendots:voice_receipt:';
// Every server-originated prompt (receipts, scheduled tasks, voice compute,
// Dot-to-Dot delegation) carries this prefix so learning features can skip
// non-owner turns.
export const internalMessagePrefix = 'opendots:';
const internalSources = [
  'voice_receipt',
  'scheduled',
  'voice_compute',
  'delegation',
];
export function serverMessageId(id: string, source?: unknown) {
  return typeof source === 'string' && internalSources.includes(source)
    ? `${internalMessagePrefix}${source}:${id}`
    : id;
}
