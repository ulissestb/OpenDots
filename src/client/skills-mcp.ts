import type { McpServerInfo, McpToolInfo } from '../shared/mcp';
import { skillLimits, skillPathPattern } from '../shared/skills';
// DOM-free helpers for the Skills & MCP view, unit-tested without a browser.

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function relativeTime(value: number, now = Date.now()) {
  const minutes = Math.floor((now - value) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
  return new Date(value).toLocaleDateString();
}

export function truncate(text: string, max: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** "My Skill!" → "my-skill" (Agent Skills naming). */
export function slugify(value: string, max = 64) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** "All Dots", "No Dots", or the granted Dots' names. */
export function availabilityLabel(
  dotIds: string[] | null,
  dots: { id: string; name: string }[],
) {
  if (dotIds === null) return 'All Dots';
  const names = dotIds.map(
    (id) => dots.find((dot) => dot.id === id)?.name ?? 'a deleted Dot',
  );
  return names.length ? names.join(', ') : 'No Dots';
}

export type McpStatusTone = 'untested' | 'error' | 'ok';
/**
 * Only a recorded, error-free test counts as working: an error always wins
 * (a failed test keeps the old tool list), and an untested server is a warning.
 */
export function mcpStatus(
  server: Pick<
    McpServerInfo,
    'lastError' | 'checkedAt' | 'tools' | 'allowedTools'
  >,
  now = Date.now(),
): { tone: McpStatusTone; label: string } {
  if (server.lastError)
    return { tone: 'error', label: `Error: ${server.lastError}` };
  if (server.checkedAt === null)
    return { tone: 'untested', label: 'Not tested' };
  const count = server.tools.length;
  const allowed =
    server.allowedTools === null
      ? count
      : server.tools.filter((tool) => server.allowedTools!.includes(tool.name))
          .length;
  const tools =
    allowed === count
      ? `${count} ${count === 1 ? 'tool' : 'tools'}`
      : `${allowed} of ${count} tools`;
  return {
    tone: 'ok',
    label: `${tools} · tested ${relativeTime(server.checkedAt, now)}`,
  };
}

/** The tool names the owner starts with checked. */
export function initialCheckedTools(
  server: Pick<McpServerInfo, 'tools' | 'allowedTools'>,
) {
  return server.tools
    .map((tool) => tool.name)
    .filter(
      (name) =>
        server.allowedTools === null || server.allowedTools.includes(name),
    );
}

/**
 * The allowedTools value to save: null when every reviewed tool is checked.
 * Without a reviewed list (never tested, or reset by a URL/header change)
 * there is nothing to choose from, so the stored value is kept as-is.
 */
export function computeAllowedTools(
  tools: McpToolInfo[],
  checked: string[],
  stored: string[] | null,
): string[] | null {
  if (!tools.length) return stored;
  if (tools.every((tool) => checked.includes(tool.name))) return null;
  return tools
    .map((tool) => tool.name)
    .filter((name) => checked.includes(name));
}

// ---- Skill folder import ----

const binaryExtensions = new Set(
  (
    'png jpg jpeg gif webp bmp ico tif tiff heic avif psd ' +
    'pdf zip gz tgz bz2 xz 7z rar tar jar war ' +
    'exe dll so dylib bin o a class wasm pyc ' +
    'mp3 wav ogg flac m4a aac mp4 mov avi mkv webm ' +
    'woff woff2 ttf otf eot ' +
    'doc docx xls xlsx ppt pptx odt ods odp ' +
    'sqlite db dat pkl npy npz parquet'
  ).split(' '),
);
// Browsers guess wrong for some source files (.ts → video/mp2t, .md → '').
const textExtensions = new Set(
  (
    'md markdown txt text csv tsv json jsonl yaml yml toml ini cfg conf env ' +
    'xml html htm css scss svg js mjs cjs ts tsx jsx py rb sh bash zsh ps1 ' +
    'go rs java kt swift c h cpp hpp cs php pl lua r sql graphql gql tex ' +
    'rst adoc org log diff patch'
  ).split(' '),
);
const textMime =
  /^(text\/|application\/(json|xml|javascript|ecmascript|typescript|x-sh|x-shellscript|x-yaml|yaml|toml|x-toml|x-python|sql|graphql|ld\+json|x-httpd-php)$)/;
// Mirrors the server's skill file path rule.

function extension(path: string) {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Binary by extension, or by a non-text MIME type for unknown extensions. */
export function looksBinary({ path, type }: { path: string; type: string }) {
  const ext = extension(path);
  if (binaryExtensions.has(ext)) return true;
  if (textExtensions.has(ext)) return false;
  return type !== '' && !textMime.test(type);
}

export interface FolderEntry {
  /** webkitRelativePath: always starts with the chosen folder's name. */
  path: string;
  size: number;
  type: string;
}
export interface SkippedFile {
  path: string;
  reason: string;
}
export type FolderPlan =
  | { error: string }
  | {
      /** Full path of the SKILL.md used. */
      skillMd: string;
      /** Name of the folder holding SKILL.md, for a fallback skill name. */
      folder: string;
      /** Files to read: `path` is relative to the SKILL.md folder. */
      read: { path: string; source: string }[];
      skipped: SkippedFile[];
    };

const tooLarge = `over ${skillLimits.fileChars.toLocaleString('en-US')} characters`;

/**
 * Picks the SKILL.md (top level of the chosen folder, or one folder down) and
 * the files next to it. Hidden files (.git, .DS_Store) are ignored silently;
 * binary, oversized, or unsupported names are reported as skipped.
 */
export function planSkillFolder(entries: FolderEntry[]): FolderPlan {
  const inner = (path: string) => path.split('/').slice(1);
  const candidates = entries
    .filter((entry) => {
      const parts = inner(entry.path);
      return (
        parts.length >= 1 &&
        parts.length <= 2 &&
        parts.at(-1)!.toLowerCase() === 'skill.md'
      );
    })
    .sort(
      (a, b) =>
        inner(a.path).length - inner(b.path).length ||
        a.path.localeCompare(b.path),
    );
  const chosen = candidates[0];
  if (!chosen)
    return {
      error:
        'No SKILL.md found in the chosen folder or in a folder directly inside it.',
    };
  const base = chosen.path.slice(0, chosen.path.lastIndexOf('/') + 1);
  const folder = base.slice(0, -1).split('/').pop() ?? '';
  const read: { path: string; source: string }[] = [];
  const skipped: SkippedFile[] = [];
  for (const entry of [...entries].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    if (entry === chosen || !entry.path.startsWith(base)) continue;
    const path = entry.path.slice(base.length);
    if (path.split('/').some((part) => part.startsWith('.'))) continue;
    if (looksBinary(entry)) skipped.push({ path, reason: 'binary file' });
    else if (path.length > 200 || !skillPathPattern.test(path))
      skipped.push({ path, reason: 'unsupported file name' });
    // UTF-8 never uses more than 4 bytes per character.
    else if (entry.size > skillLimits.fileChars * 4)
      skipped.push({ path, reason: tooLarge });
    else read.push({ path, source: entry.path });
  }
  return { skillMd: chosen.path, folder, read, skipped };
}

/**
 * Applies the content checks once files are read: NUL bytes mean binary, and
 * the per-file, file-count, and total-size limits are enforced in path order.
 */
export function collectSkillFiles(
  read: { path: string; text: string }[],
  instructionsLength: number,
) {
  const files: Record<string, string> = {};
  const skipped: SkippedFile[] = [];
  let total = instructionsLength;
  let count = 0;
  for (const { path, text } of [...read].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    if (text.includes('\0')) skipped.push({ path, reason: 'binary file' });
    else if (text.length > skillLimits.fileChars)
      skipped.push({ path, reason: tooLarge });
    else if (count >= skillLimits.files)
      skipped.push({
        path,
        reason: `over the ${skillLimits.files}-file limit`,
      });
    else if (total + text.length > skillLimits.totalChars)
      skipped.push({ path, reason: 'skill size limit reached' });
    else {
      files[path] = text;
      total += text.length;
      count++;
    }
  }
  return { files, skipped };
}

/** Checks the editor's file rows and turns them into the API record. */
export function skillFilesRecord(
  rows: { path: string; content: string }[],
): { files: Record<string, string> } | { error: string } {
  const files: Record<string, string> = {};
  for (const row of rows) {
    const path = row.path.trim();
    if (!path) return { error: 'Every bundled file needs a path.' };
    if (!skillPathPattern.test(path))
      return {
        error: `“${path}”: use a relative path with letters, digits, spaces, “-”, “_”, “.” and “/”, without “..”.`,
      };
    if (path in files) return { error: `“${path}” is listed twice.` };
    files[path] = row.content;
  }
  if (rows.length > skillLimits.files)
    return { error: `A skill can bundle at most ${skillLimits.files} files.` };
  return { files };
}
