import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  type Skill,
  type SkillInput,
  skillInputSchema,
} from '../shared/skills.js';

interface Row {
  id: string;
  name: string;
  description: string;
  instructions: string;
  files: string;
  enabled: number;
  allDots: number;
  author: string | null;
  createdAt: number;
  updatedAt: number;
}
/** Owner-authored skills in the Agent Skills (SKILL.md) format. */
export class Skills {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, instructions TEXT NOT NULL, files TEXT NOT NULL, enabled INTEGER NOT NULL, allDots INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dot_skills(dotId TEXT NOT NULL, skillId TEXT NOT NULL, PRIMARY KEY(dotId, skillId));`);
    if (
      !db
        .prepare('PRAGMA table_info(skills)')
        .all()
        .some((column) => column.name === 'author')
    )
      db.exec('ALTER TABLE skills ADD COLUMN author TEXT');
  }
  private read(row: Row): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      files: JSON.parse(row.files) as Record<string, string>,
      enabled: !!row.enabled,
      dotIds: row.allDots
        ? null
        : this.db
            .prepare(
              'SELECT dotId FROM dot_skills WHERE skillId=? ORDER BY dotId',
            )
            .all(row.id)
            .map((grant) => String(grant.dotId)),
      author: row.author ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  list(): Skill[] {
    return (
      this.db
        .prepare('SELECT * FROM skills ORDER BY name')
        .all() as unknown as Row[]
    ).map((row) => this.read(row));
  }
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM skills WHERE id=?').get(id);
    return row ? this.read(row as unknown as Row) : undefined;
  }
  /** Enabled skills this Dot may use, in name order. */
  forDot(dotId: string): Skill[] {
    return this.list().filter(
      (skill) =>
        skill.enabled &&
        (skill.dotIds === null || skill.dotIds.includes(dotId)),
    );
  }
  /** Cheap fingerprint of a Dot's usable skills, for the run watcher. */
  signature(dotId: string): string {
    return this.db
      .prepare(
        `SELECT id FROM skills WHERE enabled=1 AND (allDots=1 OR id IN (SELECT skillId FROM dot_skills WHERE dotId=?)) ORDER BY name`,
      )
      .all(dotId)
      .map((row) => String(row.id))
      .join(',');
  }
  /**
   * Saves a skill. Owner edits keep the original author; a Dot passes its id
   * as author when it creates a skill.
   */
  save(input: SkillInput, id?: string, author?: string): Skill {
    const skill = skillInputSchema.parse(input);
    const now = Date.now();
    const current = id ? this.get(id) : undefined;
    if (id && !current) throw new Error('Skill not found.');
    const taken = this.db
      .prepare('SELECT id FROM skills WHERE name=?')
      .get(skill.name);
    if (taken && taken.id !== id)
      throw new Error(`A skill named ${skill.name} already exists.`);
    const skillId = id ?? randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO skills (id, name, description, instructions, files, enabled, allDots, createdAt, updatedAt, author)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
            instructions=excluded.instructions, files=excluded.files, enabled=excluded.enabled,
            allDots=excluded.allDots, updatedAt=excluded.updatedAt`,
        )
        .run(
          skillId,
          skill.name,
          skill.description,
          skill.instructions,
          JSON.stringify(skill.files),
          +skill.enabled,
          +(skill.dotIds === null),
          current?.createdAt ?? now,
          now,
          current ? current.author : (author ?? null),
        );
      this.db.prepare('DELETE FROM dot_skills WHERE skillId=?').run(skillId);
      for (const dotId of new Set(skill.dotIds ?? []))
        this.db
          .prepare('INSERT INTO dot_skills VALUES (?, ?)')
          .run(dotId, skillId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(skillId)!;
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM dot_skills WHERE skillId=?').run(id);
    return this.db.prepare('DELETE FROM skills WHERE id=?').run(id).changes > 0;
  }
}

/** The skill catalog for the system prompt: names and descriptions only. */
export function skillCatalog(skills: Skill[]) {
  return skills.length
    ? `Skills (owner-provided playbooks; call load_skill with the name before doing a matching task, then follow its instructions and read_skill_file for any file it references):\n${skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n')}`
    : '';
}
/** Progressive disclosure: load a skill's instructions, then its files. */
export function skillTools(
  skills: Skill[],
  check: () => void,
): ToolDefinition[] {
  if (!skills.length) return [];
  const names = skills.map((skill) => skill.name) as [string, ...string[]];
  const find = (name: string) => {
    check();
    const skill = skills.find((item) => item.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}.`);
    return skill;
  };
  return [
    defineTool({
      name: 'load_skill',
      description:
        'Load the full instructions of one of your skills. Call it before a task that matches the skill description.',
      parameters: z.object({ name: z.enum(names) }),
      execute: async ({ name }) => {
        const skill = find(name);
        return {
          name: skill.name,
          instructions: skill.instructions,
          files: Object.keys(skill.files),
        };
      },
    }),
    defineTool({
      name: 'read_skill_file',
      description:
        'Read a file bundled with a skill, such as a template, reference, or script, by its path from load_skill.',
      parameters: z.object({
        name: z.enum(names),
        path: z.string().min(1).max(200),
      }),
      execute: async ({ name, path }) => {
        const skill = find(name);
        const file = skill.files[path.replace(/^\.\//, '')];
        if (file === undefined)
          throw new Error(
            `No file ${path} in ${name}. Files: ${Object.keys(skill.files).join(', ') || 'none'}.`,
          );
        return { name, path, content: file };
      },
    }),
  ];
}

/**
 * Lets a Dot write skills: new skills are its own (available to that Dot
 * only until the owner shares them), and it may update only skills it wrote.
 */
export function skillAuthoringTools(options: {
  skills: Skills;
  dotId: string;
  check: () => void;
  /** Called after a write, so the run does not treat it as a permission change. */
  onChange: () => void;
}): ToolDefinition[] {
  const fields = {
    description: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        'When to use the skill: what it does and the requests that should trigger it.',
      ),
    instructions: z
      .string()
      .max(50_000)
      .describe('The SKILL.md body: Markdown steps, rules, and examples.'),
    files: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Optional bundled text files by relative path, e.g. {"templates/report.md": "..."}.',
      ),
  };
  const saved = (skill: Skill) => ({
    name: skill.name,
    description: skill.description,
    files: Object.keys(skill.files),
    availableTo: skill.dotIds === null ? 'all Dots' : 'only you',
  });
  return [
    defineTool({
      name: 'create_skill',
      description:
        'Save a new skill (Agent Skills SKILL.md format) that you can load later with load_skill. Use it when the owner asks you to create or capture a skill or reusable procedure. When a skill such as skill-creator tells you to write SKILL.md files to disk, package them, or run scripts to create a skill, call this tool instead. The new skill is available only to you until the owner shares it.',
      parameters: z.object({
        name: z
          .string()
          .describe(
            'Lowercase letters, digits, and hyphens, e.g. java-developer.',
          ),
        ...fields,
      }),
      execute: async ({ name, description, instructions, files }) => {
        options.check();
        const skill = options.skills.save(
          {
            name,
            description,
            instructions,
            files: files ?? {},
            enabled: true,
            dotIds: [options.dotId],
          },
          undefined,
          options.dotId,
        );
        options.onChange();
        return { created: saved(skill) };
      },
    }),
    defineTool({
      name: 'update_skill',
      description:
        'Improve a skill you created earlier: replace its description, instructions, or bundled files. Skills written by the owner cannot be changed.',
      parameters: z.object({
        name: z.string().describe('The name of a skill you created.'),
        description: fields.description.optional(),
        instructions: fields.instructions.optional(),
        files: fields.files,
      }),
      execute: async ({ name, description, instructions, files }) => {
        options.check();
        const current = options.skills
          .list()
          .find((skill) => skill.name === name);
        if (!current) throw new Error(`No skill named ${name}.`);
        if (current.author !== options.dotId)
          throw new Error(
            `${name} was not created by you; ask the owner to change it.`,
          );
        // Once the owner shares a skill with other Dots, its author may no
        // longer rewrite instructions those Dots load.
        if (
          current.dotIds === null ||
          current.dotIds.some((dotId) => dotId !== options.dotId)
        )
          throw new Error(
            `${name} is shared with other Dots; ask the owner to change it.`,
          );
        const skill = options.skills.save(
          {
            name,
            description: description ?? current.description,
            instructions: instructions ?? current.instructions,
            files: files ?? current.files,
            enabled: current.enabled,
            dotIds: current.dotIds,
          },
          current.id,
        );
        options.onChange();
        return { updated: saved(skill) };
      },
    }),
  ];
}
