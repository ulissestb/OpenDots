import { expect, it } from 'vitest';
import {
  chunkUtf8,
  delegationResultFrames,
  parseDelegation,
} from '../src/shared/voice-delegation.js';

const bytes = (text: string) => new TextEncoder().encode(text).length;

it('reads only client-targeted delegations', () => {
  const event = {
    type: 'delegation.created',
    item: {
      type: 'delegation',
      target: 'client',
      id: 'del_1',
      content: [
        { type: 'input_text', text: 'Create a page ' },
        { type: 'other', text: 'ignored' },
        { type: 'input_text', text: 'about Lisbon' },
      ],
    },
  };
  expect(parseDelegation(event)).toEqual({
    id: 'del_1',
    request: 'Create a page about Lisbon',
  });
  expect(
    parseDelegation({ ...event, item: { ...event.item, target: 'server' } }),
  ).toBeUndefined();
  expect(parseDelegation({ type: 'turn.done' })).toBeUndefined();
  expect(parseDelegation(null)).toBeUndefined();
});

it('chunks text at 500 UTF-8 bytes without splitting characters', () => {
  expect(chunkUtf8('a'.repeat(500))).toEqual(['a'.repeat(500)]);
  const text = 'é'.repeat(300) + '🙂'.repeat(10);
  const chunks = chunkUtf8(text);
  expect(chunks.join('')).toBe(text);
  for (const chunk of chunks) expect(bytes(chunk)).toBeLessThanOrEqual(500);
  expect(chunks.length).toBe(2);
});

it('builds speakable context-append frames with a bounded result', () => {
  const frames = delegationResultFrames('del_1', 'ã'.repeat(5000)).map(
    (frame) => JSON.parse(frame),
  );
  expect(frames[0]).toMatchObject({
    type: 'delegation.context.append',
    delegation_item_id: 'del_1',
    channel: 'speakable',
  });
  const text = frames.map((frame) => frame.content[0].text).join('');
  expect(bytes(text)).toBeLessThanOrEqual(4000);
  expect(text).toContain('full result is in the chat');
  expect(
    delegationResultFrames('del_2', '  ').map((frame) => JSON.parse(frame)),
  ).toMatchObject([{ content: [{ type: 'input_text', text: 'Done.' }] }]);
});
