import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Memory } from '../shared/types.js';

export const memoryToolNames = [
  'save_memory',
  'update_memory',
  'forget_memory',
] as const;

// A coarse guard; the prompt also forbids saving credentials.
const secretPattern =
  /\b(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|xox[abprs]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|\b(password|passcode|senha|api[ _-]?key|secret|token)\s*[:=]/i;
// 13–19 digits, optionally grouped by spaces or dashes.
const digitRun = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
/** Luhn checksum, so phone numbers and IDs are not mistaken for cards. */
export function passesLuhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
export function looksSecret(text: string) {
  return (
    secretPattern.test(text) ||
    [...text.matchAll(digitRun)].some((match) =>
      passesLuhn(match[0].replace(/\D/g, '')),
    )
  );
}

const memoryText = z.string().trim().min(1).max(500);

export function promptMemory(memory: Memory) {
  return {
    id: memory.id,
    text: memory.text,
    scope: memory.dotId ? 'dot' : 'global',
  };
}

/** Memory tools for one Dot. Callers gate on both memory permissions. */
export function memoryTools(
  store: Store,
  dotId: string,
  threadId: string,
  check: () => void,
) {
  const guard = () => {
    check();
    if (!store.settings().memoryAllowed)
      throw new Error('Memory permission is disabled.');
  };
  const visible = (id: string) => {
    const memory = store.memory(id);
    if (!memory || (memory.dotId !== null && memory.dotId !== dotId))
      throw new Error('Memory not found.');
    return memory;
  };
  const safe = (text: string) => {
    if (looksSecret(text))
      throw new Error(
        'Refused: memories must not contain passwords, keys, tokens, or card numbers.',
      );
    return text;
  };
  return [
    defineTool({
      name: 'save_memory',
      description:
        'Save a durable fact or preference about the owner for future conversations. Use when the owner asks you to remember something, or shares a lasting preference, fact, or goal. Never save credentials or one-off details. Use update_memory instead of saving a duplicate.',
      parameters: z.object({
        text: memoryText.describe(
          'One short, self-contained statement, e.g. "Prefers answers in Portuguese."',
        ),
        scope: z
          .enum(['global', 'dot'])
          .describe(
            'global: useful to every Dot. dot: only relevant to this Dot.',
          ),
      }),
      execute: async ({ text, scope }) => {
        guard();
        const memory = store.saveMemory({
          text: safe(text),
          dotId: scope === 'dot' ? dotId : null,
          source: 'agent',
          threadId,
        });
        return { saved: promptMemory(memory) };
      },
    }),
    defineTool({
      name: 'update_memory',
      description:
        'Replace the text of an existing saved memory, by id, when a fact changed or should be refined.',
      parameters: z.object({
        id: z.string().min(1).max(200),
        text: memoryText,
      }),
      execute: async ({ id, text }) => {
        guard();
        visible(id);
        return {
          updated: promptMemory(store.saveMemory({ text: safe(text) }, id)),
        };
      },
    }),
    defineTool({
      name: 'forget_memory',
      description:
        'Delete a saved memory, by id, when the owner asks you to forget it or it is no longer true.',
      parameters: z.object({ id: z.string().min(1).max(200) }),
      execute: async ({ id }) => {
        guard();
        const memory = visible(id);
        store.deleteMemory(id);
        return { forgotten: { id, text: memory.text } };
      },
    }),
  ];
}
