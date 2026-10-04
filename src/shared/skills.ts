import { z } from 'zod';

/** Agent Skills naming: lowercase letters, digits, and hyphens. */
export const skillNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, {
    message: 'Use lowercase letters, digits, and hyphens (max 64).',
  });
export const skillLimits = {
  description: 1024,
  instructions: 50_000,
  files: 50,
  fileChars: 100_000,
  totalChars: 400_000,
};
/** Relative bundled-file paths: no leading slash and no "..". */
export const skillPathPattern = /^(?!\/)(?!.*\.\.)[\w./ -]+$/;
const skillPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(skillPathPattern, {
    message: 'Use a relative path without "..".',
  });
export const skillInputSchema = z
  .object({
    name: skillNameSchema,
    description: z.string().trim().min(1).max(skillLimits.description),
    instructions: z.string().max(skillLimits.instructions),
    files: z
      .record(skillPathSchema, z.string().max(skillLimits.fileChars))
      .default({})
      .refine((files) => Object.keys(files).length <= skillLimits.files, {
        message: `At most ${skillLimits.files} files.`,
      }),
    enabled: z.boolean().default(true),
    /** null: every Dot; otherwise only these Dots. */
    dotIds: z.array(z.string().min(1)).max(100).nullable().default(null),
  })
  .strict()
  .refine(
    (skill) =>
      skill.instructions.length +
        Object.values(skill.files).reduce(
          (sum, text) => sum + text.length,
          0,
        ) <=
      skillLimits.totalChars,
    { message: 'The skill is too large.' },
  );
export type SkillInput = z.input<typeof skillInputSchema>;
export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  files: Record<string, string>;
  enabled: boolean;
  dotIds: string[] | null;
  /** null: written by the owner; otherwise the Dot that created it. */
  author: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Splits a SKILL.md into its frontmatter name/description and body. Only the
 * two fields are read, so no YAML parser is needed; quotes are trimmed.
 */
export function parseSkillMarkdown(text: string): {
  name?: string;
  description?: string;
  instructions: string;
} {
  const match = text
    .replace(/^\uFEFF/, '')
    .match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { instructions: text.trim() };
  const field = (key: string) => {
    const line = match[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1];
    return line?.trim().replace(/^(['"])(.*)\1$/, '$2') || undefined;
  };
  return {
    name: field('name'),
    description: field('description'),
    instructions: match[2].trim(),
  };
}
