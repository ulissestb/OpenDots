import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { McpServerInfo } from '../src/shared/mcp';
import { skillLimits, type Skill } from '../src/shared/skills';
import {
  availabilityLabel,
  collectSkillFiles,
  computeAllowedTools,
  initialCheckedTools,
  looksBinary,
  mcpStatus,
  planSkillFolder,
  relativeTime,
  skillFilesRecord,
} from '../src/client/skills-mcp';
import { McpServerRow, SkillRow } from '../src/client/SkillsMcpView';

const now = Date.UTC(2026, 9, 4, 12);
const server = (patch: Partial<McpServerInfo> = {}): McpServerInfo => ({
  id: 'srv',
  name: 'linear',
  url: 'https://mcp.example.com/mcp?token=query-secret',
  headerNames: ['Authorization'],
  enabled: true,
  dotIds: null,
  allowedTools: null,
  tools: [],
  lastError: null,
  checkedAt: null,
  createdAt: now,
  updatedAt: now,
  ...patch,
});
const tools = [
  { name: 'search', description: 'Find issues', readOnly: true },
  { name: 'delete_issue', description: 'Delete', destructive: true },
];
const dots = [
  { id: 'd1', name: 'Researcher' },
  { id: 'd2', name: 'Writer' },
];
const entry = (path: string, size = 10, type = '') => ({ path, size, type });

describe('skill folder import', () => {
  it('finds a top-level SKILL.md and keeps paths relative to it', () => {
    const plan = planSkillFolder([
      entry('my-skill/SKILL.md'),
      entry('my-skill/references/guide.md'),
      entry('my-skill/scripts/run.ts', 10, 'video/mp2t'),
      entry('my-skill/.git/config'),
      entry('my-skill/.DS_Store'),
    ]);
    expect(plan).toEqual({
      skillMd: 'my-skill/SKILL.md',
      folder: 'my-skill',
      read: [
        { path: 'references/guide.md', source: 'my-skill/references/guide.md' },
        { path: 'scripts/run.ts', source: 'my-skill/scripts/run.ts' },
      ],
      skipped: [],
    });
  });

  it('finds SKILL.md one folder down and ignores sibling folders', () => {
    const plan = planSkillFolder([
      entry('repo/README.md'),
      entry('repo/pdf-tools/skill.md'),
      entry('repo/pdf-tools/forms.md'),
      entry('repo/other/notes.md'),
      entry('repo/a/b/SKILL.md'),
    ]);
    expect(plan).toMatchObject({
      skillMd: 'repo/pdf-tools/skill.md',
      folder: 'pdf-tools',
      read: [{ path: 'forms.md', source: 'repo/pdf-tools/forms.md' }],
    });
  });

  it('prefers the shallowest SKILL.md and reports a missing one', () => {
    expect(
      planSkillFolder([entry('x/sub/SKILL.md'), entry('x/SKILL.md')]),
    ).toMatchObject({ skillMd: 'x/SKILL.md' });
    expect(
      planSkillFolder([entry('x/a/b/SKILL.md'), entry('x/readme.md')]),
    ).toHaveProperty('error');
  });

  it('skips binary, oversized, and unsupported files and says why', () => {
    const plan = planSkillFolder([
      entry('s/SKILL.md'),
      entry('s/logo.png', 10, 'image/png'),
      entry('s/spec.pdf'),
      entry('s/blob', 10, 'application/octet-stream'),
      entry('s/huge.txt', skillLimits.fileChars * 4 + 1),
      entry('s/weird(1).md'),
    ]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.read).toEqual([]);
    expect(plan.skipped).toEqual([
      { path: 'blob', reason: 'binary file' },
      { path: 'huge.txt', reason: 'over 100,000 characters' },
      { path: 'logo.png', reason: 'binary file' },
      { path: 'spec.pdf', reason: 'binary file' },
      { path: 'weird(1).md', reason: 'unsupported file name' },
    ]);
  });

  it('classifies by extension before MIME type', () => {
    expect(looksBinary({ path: 'a.ts', type: 'video/mp2t' })).toBe(false);
    expect(looksBinary({ path: 'a.md', type: '' })).toBe(false);
    expect(looksBinary({ path: 'a.zip', type: '' })).toBe(true);
    expect(looksBinary({ path: 'LICENSE', type: '' })).toBe(false);
    expect(looksBinary({ path: 'x.unknown', type: 'application/json' })).toBe(
      false,
    );
  });

  it('applies content checks after reading', () => {
    const big = 'x'.repeat(skillLimits.fileChars + 1);
    const result = collectSkillFiles(
      [
        { path: 'b.md', text: 'hello' },
        { path: 'a.bin', text: 'PK\0\0' },
        { path: 'c.md', text: big },
      ],
      0,
    );
    expect(result.files).toEqual({ 'b.md': 'hello' });
    expect(result.skipped).toEqual([
      { path: 'a.bin', reason: 'binary file' },
      { path: 'c.md', reason: 'over 100,000 characters' },
    ]);
    const many = Array.from({ length: skillLimits.files + 1 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}.md`,
      text: 'x',
    }));
    const limited = collectSkillFiles(many, 0);
    expect(Object.keys(limited.files)).toHaveLength(skillLimits.files);
    expect(limited.skipped).toEqual([
      { path: 'f050.md', reason: 'over the 50-file limit' },
    ]);
    const total = collectSkillFiles(
      [{ path: 'a.md', text: 'x'.repeat(20) }],
      skillLimits.totalChars - 10,
    );
    expect(total.skipped[0].reason).toBe('skill size limit reached');
  });

  it('validates edited file rows', () => {
    expect(skillFilesRecord([{ path: ' a.md ', content: 'x' }])).toEqual({
      files: { 'a.md': 'x' },
    });
    expect(
      skillFilesRecord([
        { path: 'a.md', content: '' },
        { path: 'a.md', content: '' },
      ]),
    ).toHaveProperty('error');
    expect(skillFilesRecord([{ path: '../x', content: '' }])).toHaveProperty(
      'error',
    );
    expect(skillFilesRecord([{ path: ' ', content: '' }])).toHaveProperty(
      'error',
    );
  });
});

describe('MCP status', () => {
  it('is a warning until tested', () => {
    expect(mcpStatus(server(), now)).toEqual({
      tone: 'untested',
      label: 'Not tested',
    });
  });

  it('shows errors even with an older tool list or no test time', () => {
    expect(
      mcpStatus(
        server({ tools, checkedAt: now, lastError: 'Unauthorized' }),
        now,
      ),
    ).toEqual({ tone: 'error', label: 'Error: Unauthorized' });
    expect(mcpStatus(server({ lastError: 'Cannot decrypt' }), now).tone).toBe(
      'error',
    );
  });

  it('counts tools and the test time after a successful test', () => {
    expect(
      mcpStatus(server({ tools, checkedAt: now - 5 * 60000 }), now),
    ).toEqual({ tone: 'ok', label: '2 tools · tested 5m ago' });
    expect(
      mcpStatus(
        server({ tools, checkedAt: now, allowedTools: ['search'] }),
        now,
      ).label,
    ).toBe('1 of 2 tools · tested just now');
    expect(relativeTime(now - 3 * 86400000, now)).toBe('3d ago');
  });
});

describe('allowed tools', () => {
  it('sends null when every reviewed tool is checked', () => {
    expect(
      computeAllowedTools(tools, ['delete_issue', 'search'], ['search']),
    ).toBeNull();
    expect(computeAllowedTools(tools, ['search'], null)).toEqual(['search']);
    expect(computeAllowedTools(tools, [], null)).toEqual([]);
  });

  it('keeps the stored choice when there is no reviewed list', () => {
    expect(computeAllowedTools([], [], ['search'])).toEqual(['search']);
    expect(computeAllowedTools([], [], null)).toBeNull();
  });

  it('starts from the stored choice', () => {
    expect(initialCheckedTools(server({ tools }))).toEqual([
      'search',
      'delete_issue',
    ]);
    expect(
      initialCheckedTools(server({ tools, allowedTools: ['search', 'gone'] })),
    ).toEqual(['search']);
  });
});

describe('rows', () => {
  it('never renders header values or URL query secrets', () => {
    const html = renderToStaticMarkup(
      <McpServerRow
        server={
          {
            ...server({ tools, checkedAt: now }),
            headers: [{ name: 'Authorization', value: 'Bearer SECRET' }],
          } as never
        }
        dots={dots}
        now={now}
      />,
    );
    expect(html).toContain('Authorization');
    expect(html).toContain('https://mcp.example.com/mcp');
    expect(html).not.toContain('SECRET');
    expect(html).not.toContain('query-secret');
    expect(html).toContain('2 tools · tested just now');
    expect(html).toContain('All Dots');
  });

  it('does not render a working state for an untested or failing server', () => {
    const untested = renderToStaticMarkup(
      <McpServerRow server={server()} dots={dots} now={now} />,
    );
    expect(untested).toContain('Not tested');
    expect(untested).not.toContain('completed');
    const failed = renderToStaticMarkup(
      <McpServerRow
        server={server({ tools, checkedAt: now, lastError: 'Timed out' })}
        dots={dots}
        now={now}
      />,
    );
    expect(failed).toContain('Error: Timed out');
    expect(failed).not.toContain('completed');
  });

  it('labels skill availability', () => {
    const skill: Skill = {
      id: 's',
      name: 'weekly-report',
      description: 'Formats the weekly report.',
      instructions: '',
      files: { 'a.md': 'x' },
      author: null,
      enabled: false,
      dotIds: ['d2'],
      createdAt: now,
      updatedAt: now,
    };
    const html = renderToStaticMarkup(<SkillRow skill={skill} dots={dots} />);
    expect(html).toContain('weekly-report');
    expect(html).toContain('Writer · 1 bundled file');
    expect(html).toContain('Disabled');
    expect(availabilityLabel([], dots)).toBe('No Dots');
    expect(availabilityLabel(['zz'], dots)).toBe('a deleted Dot');
  });
});
