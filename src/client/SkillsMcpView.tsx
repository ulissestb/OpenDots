import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  FileText,
  FolderOpen,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { McpServerInfo } from '../shared/mcp';
import { parseSkillMarkdown, skillLimits, type Skill } from '../shared/skills';
import type { Dot } from '../shared/types';
import { api } from './api';
import {
  backdropHandlers,
  isCoarsePointer,
  sessionOverlayOpen,
} from './ui-helpers';
import {
  availabilityLabel,
  collectSkillFiles,
  computeAllowedTools,
  initialCheckedTools,
  mcpStatus,
  planSkillFolder,
  skillFilesRecord,
  slugify,
  truncate,
  type SkippedFile,
} from './skills-mcp';

type DotRef = Pick<Dot, 'id' | 'name'>;
type Editing =
  { kind: 'skill'; skill?: Skill } | { kind: 'mcp'; server?: McpServerInfo };

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';
// Drops grants for deleted Dots so a save is not rejected as "Unknown Dot."
const knownDots = (dotIds: string[] | null, dots: DotRef[]) =>
  dotIds && dotIds.filter((id) => dots.some((dot) => dot.id === id));
let rowKey = 0;
const nextKey = () => ++rowKey;

export function SkillsMcpView({ dots }: { dots: DotRef[] }) {
  const [skills, setSkills] = useState<Skill[]>();
  const [servers, setServers] = useState<McpServerInfo[]>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Editing>();
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<Skill[]>('/skills', 'GET', undefined, controller.signal),
      api<McpServerInfo[]>('/mcp/servers', 'GET', undefined, controller.signal),
    ])
      .then(([skillList, serverList]) => {
        setSkills(skillList);
        setServers(serverList);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, []);
  const upsert = <T extends { id: string; name: string }>(
    list: T[] | undefined,
    item: T,
  ) =>
    [...(list ?? []).filter((entry) => entry.id !== item.id), item].sort(
      (a, b) => a.name.localeCompare(b.name),
    );
  const remove = async (path: string, label: string, done: () => void) => {
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await api(path, 'DELETE', {});
      done();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <main className="main-content integrations">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>Skills & MCP</h1>
          <p>
            Playbooks your Dots load when a task calls for them, and remote tool
            servers you have reviewed.
          </p>
        </div>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')}>Dismiss</button>
        </p>
      )}
      <section aria-labelledby="skills-heading">
        <div className="integration-heading">
          <div>
            <h2 id="skills-heading">Skills</h2>
            <p>
              SKILL.md playbooks. A Dot sees each skill’s name and description
              and loads the instructions and files only when needed.
            </p>
          </div>
          <button
            className="primary"
            onClick={() => setEditing({ kind: 'skill' })}
          >
            <Plus size={15} />
            Add skill
          </button>
        </div>
        {!skills ? (
          <p className="muted">{error ? 'Not loaded.' : 'Loading…'}</p>
        ) : skills.length ? (
          <div className="integration-list">
            {skills.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                dots={dots}
                onEdit={() => setEditing({ kind: 'skill', skill })}
                onDelete={() =>
                  void remove(
                    `/skills/${skill.id}`,
                    `skill ${skill.name}`,
                    () =>
                      setSkills((list) =>
                        list?.filter((entry) => entry.id !== skill.id),
                      ),
                  )
                }
              />
            ))}
          </div>
        ) : (
          <div className="integration-empty">
            <Puzzle size={22} />
            <p>
              No skills yet. Write one, or import a SKILL.md or a skill folder.
            </p>
          </div>
        )}
      </section>
      <section aria-labelledby="mcp-heading">
        <div className="integration-heading">
          <div>
            <h2 id="mcp-heading">MCP servers</h2>
            <p>
              Dots only get tools from a server’s last successful test, limited
              to the tools you allow.
            </p>
          </div>
          <button
            className="primary"
            onClick={() => setEditing({ kind: 'mcp' })}
          >
            <Plus size={15} />
            Add MCP server
          </button>
        </div>
        <p className="help-note">
          Remote MCP servers only (Streamable HTTP or SSE). For stdio servers,
          run them behind an HTTP bridge — see docs/SETUP.md.
        </p>
        {!servers ? (
          <p className="muted">{error ? 'Not loaded.' : 'Loading…'}</p>
        ) : servers.length ? (
          <div className="integration-list">
            {servers.map((server) => (
              <McpServerRow
                key={server.id}
                server={server}
                dots={dots}
                onEdit={() => setEditing({ kind: 'mcp', server })}
                onDelete={() =>
                  void remove(
                    `/mcp/servers/${server.id}`,
                    `MCP server ${server.name}`,
                    () =>
                      setServers((list) =>
                        list?.filter((entry) => entry.id !== server.id),
                      ),
                  )
                }
              />
            ))}
          </div>
        ) : (
          <div className="integration-empty">
            <Plug size={22} />
            <p>No MCP servers yet.</p>
          </div>
        )}
      </section>
      {editing?.kind === 'skill' && (
        <SkillDialog
          skill={editing.skill}
          dots={dots}
          onClose={() => setEditing(undefined)}
          onSaved={(skill) => setSkills((list) => upsert(list, skill))}
        />
      )}
      {editing?.kind === 'mcp' && (
        <McpDialog
          server={editing.server}
          dots={dots}
          onClose={() => setEditing(undefined)}
          onSaved={(server) => setServers((list) => upsert(list, server))}
        />
      )}
    </main>
  );
}

export function SkillRow({
  skill,
  dots,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  dots: DotRef[];
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const fileCount = Object.keys(skill.files).length;
  return (
    <article className="integration-card">
      <div className="integration-card-top">
        <Puzzle size={18} aria-hidden="true" />
        <strong>{skill.name}</strong>
        <span className={`status ${skill.enabled ? 'completed' : 'paused'}`}>
          <span />
          {skill.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p>{truncate(skill.description, 240)}</p>
      <div className="integration-card-bottom">
        <small>
          {availabilityLabel(skill.dotIds, dots)}
          {skill.author
            ? ` · Created by ${dots.find((dot) => dot.id === skill.author)?.name ?? 'a Dot'}`
            : ''}
          {fileCount
            ? ` · ${fileCount} bundled ${fileCount === 1 ? 'file' : 'files'}`
            : ''}
        </small>
        <button
          className="icon-button"
          aria-label={`Edit skill ${skill.name}`}
          onClick={onEdit}
        >
          <Pencil size={15} />
        </button>
        <button
          className="icon-button"
          aria-label={`Delete skill ${skill.name}`}
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}

/** URL without query or fragment: a token in the query stays off the list. */
function displayUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function McpStatusPill({
  server,
  now,
}: {
  server: McpServerInfo;
  now?: number;
}) {
  const status = mcpStatus(server, now);
  const tone =
    status.tone === 'ok'
      ? 'completed'
      : status.tone === 'error'
        ? 'failed'
        : 'paused';
  return (
    <span className={`status wrap ${tone}`} data-tone={status.tone}>
      <span />
      {status.label}
    </span>
  );
}

export function McpServerRow({
  server,
  dots,
  now,
  onEdit,
  onDelete,
}: {
  server: McpServerInfo;
  dots: DotRef[];
  now?: number;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <article className="integration-card">
      <div className="integration-card-top">
        <Plug size={18} aria-hidden="true" />
        <strong>{server.name}</strong>
        {!server.enabled && (
          <span className="status paused">
            <span />
            Disabled
          </span>
        )}
      </div>
      <p className="integration-url">{displayUrl(server.url)}</p>
      <McpStatusPill server={server} now={now} />
      <div className="integration-card-bottom">
        <small>
          {availabilityLabel(server.dotIds, dots)}
          {server.headerNames.length
            ? ` · Headers: ${server.headerNames.join(', ')}`
            : ''}
        </small>
        <button
          className="icon-button"
          aria-label={`Edit MCP server ${server.name}`}
          onClick={onEdit}
        >
          <Pencil size={15} />
        </button>
        <button
          className="icon-button"
          aria-label={`Delete MCP server ${server.name}`}
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}

function Modal({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const container = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!isCoarsePointer())
      container.current
        ?.querySelector<HTMLElement>('input:not([type="file"]),textarea')
        ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sessionOverlayOpen(event.target))
        close.current();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),textarea,select,a[href]',
          ) ?? []),
        ].filter((item) => !item.hidden);
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      {...backdropHandlers(() => close.current())}
    >
      <section
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">{eyebrow}</span>
        <h2 id="integration-dialog-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}

function DotAvailability({
  dotIds,
  dots,
  onChange,
}: {
  dotIds: string[] | null;
  dots: DotRef[];
  onChange: (next: string[] | null) => void;
}) {
  return (
    <fieldset className="space-access-fields">
      <legend>Available to</legend>
      <label className="permission-row compact">
        <input
          type="radio"
          name="availability"
          checked={dotIds === null}
          onChange={() => onChange(null)}
        />
        <span>All Dots, including ones you add later</span>
      </label>
      <label className="permission-row compact">
        <input
          type="radio"
          name="availability"
          checked={dotIds !== null}
          onChange={() => onChange(dotIds ?? [])}
        />
        <span>Only selected Dots</span>
      </label>
      {dotIds !== null && (
        <div className="dot-choices">
          {dots.map((dot) => (
            <label className="permission-row compact" key={dot.id}>
              <input
                type="checkbox"
                checked={dotIds.includes(dot.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...dotIds, dot.id]
                      : dotIds.filter((id) => id !== dot.id),
                  )
                }
              />
              <span>{dot.name}</span>
            </label>
          ))}
          {!dots.length && <p className="muted">No Dots yet.</p>}
        </div>
      )}
    </fieldset>
  );
}

function SkippedList({ skipped }: { skipped: SkippedFile[] }) {
  if (!skipped.length) return null;
  return (
    <details className="skipped-files">
      <summary>
        Skipped {skipped.length} {skipped.length === 1 ? 'file' : 'files'}
      </summary>
      <ul>
        {skipped.map((file) => (
          <li key={file.path}>
            <code>{file.path}</code> — {file.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

interface FileRow {
  key: number;
  path: string;
  content: string;
}
const toRows = (files: Record<string, string>): FileRow[] =>
  Object.entries(files).map(([path, content]) => ({
    key: nextKey(),
    path,
    content,
  }));

function SkillDialog({
  skill,
  dots,
  onClose,
  onSaved,
}: {
  skill?: Skill;
  dots: DotRef[];
  onClose: () => void;
  onSaved: (skill: Skill) => void;
}) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [instructions, setInstructions] = useState(skill?.instructions ?? '');
  const [files, setFiles] = useState<FileRow[]>(() =>
    toRows(skill?.files ?? {}),
  );
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [dotIds, setDotIds] = useState<string[] | null>(() =>
    knownDots(skill?.dotIds ?? null, dots),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [importNote, setImportNote] = useState('');
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const total =
    instructions.length + files.reduce((sum, f) => sum + f.content.length, 0);
  const applyMarkdown = (text: string, fallbackName: string) => {
    const parsed = parseSkillMarkdown(text);
    setName(parsed.name ?? (fallbackName || name));
    if (parsed.description) setDescription(parsed.description);
    setInstructions(parsed.instructions);
    return parsed.instructions.length;
  };
  const importFile = async (file: File) => {
    setError('');
    setSkipped([]);
    const stem = file.name.replace(/\.[^.]+$/, '');
    applyMarkdown(
      await file.text(),
      stem.toLowerCase() === 'skill' ? '' : slugify(stem),
    );
    setImportNote(`Imported ${file.name}. Review the fields, then save.`);
  };
  const importFolder = async (list: File[]) => {
    setError('');
    setImportNote('');
    setSkipped([]);
    const byPath = new Map(
      list.map((file) => [file.webkitRelativePath || file.name, file]),
    );
    const plan = planSkillFolder(
      [...byPath].map(([path, file]) => ({
        path,
        size: file.size,
        type: file.type,
      })),
    );
    if ('error' in plan) {
      setError(plan.error);
      return;
    }
    const length = applyMarkdown(
      await byPath.get(plan.skillMd)!.text(),
      slugify(plan.folder),
    );
    const read = await Promise.all(
      plan.read.map(async (entry) => ({
        path: entry.path,
        text: await byPath.get(entry.source)!.text(),
      })),
    );
    const result = collectSkillFiles(read, length);
    setFiles(toRows(result.files));
    const all = [...plan.skipped, ...result.skipped];
    setSkipped(all);
    const count = Object.keys(result.files).length;
    setImportNote(
      `Imported ${plan.skillMd.split('/').slice(1).join('/')} and ${count} bundled ${count === 1 ? 'file' : 'files'}. Hidden files are ignored.`,
    );
  };
  const folderInput = (element: HTMLInputElement | null) => {
    // Not in React's attribute types; every current browser supports it.
    element?.setAttribute('webkitdirectory', '');
  };
  return (
    <Modal
      eyebrow="SKILL"
      title={skill ? `Edit ${skill.name}` : 'Teach a new skill.'}
      onClose={onClose}
    >
      <div className="import-actions">
        <label className="file-button">
          <FileText size={15} />
          <span>Import SKILL.md</span>
          <input
            type="file"
            accept=".md,text/markdown,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file)
                void importFile(file).catch((e) => setError(message(e)));
            }}
          />
        </label>
        <label className="file-button">
          <FolderOpen size={15} />
          <span>Import folder</span>
          <input
            type="file"
            multiple
            ref={folderInput}
            onChange={(event) => {
              const list = [...(event.target.files ?? [])];
              event.target.value = '';
              if (list.length)
                void importFolder(list).catch((e) => setError(message(e)));
            }}
          />
        </label>
      </div>
      {importNote && (
        <p className="muted" role="status">
          {importNote}
        </p>
      )}
      <SkippedList skipped={skipped} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          const record = skillFilesRecord(files);
          if ('error' in record) {
            setError(record.error);
            return;
          }
          if (dotIds !== null && !dotIds.length) {
            setError('Choose at least one Dot, or make it available to all.');
            return;
          }
          setBusy(true);
          try {
            const saved = await api<Skill>(
              skill ? `/skills/${skill.id}` : '/skills',
              skill ? 'PUT' : 'POST',
              {
                name: name.trim(),
                description: description.trim(),
                instructions,
                files: record.files,
                enabled,
                dotIds,
              },
            );
            onSaved(saved);
            onClose();
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field-label" htmlFor="skill-name">
          Name
        </label>
        <input
          id="skill-name"
          value={name}
          required
          maxLength={64}
          pattern="[a-z0-9][a-z0-9\-]*"
          title="Lowercase letters, digits, and hyphens"
          placeholder="weekly-report"
          aria-describedby="skill-name-help"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="muted field-help" id="skill-name-help">
          Lowercase letters, digits, and hyphens.
        </p>
        <label className="field-label" htmlFor="skill-description">
          When to use it
        </label>
        <textarea
          id="skill-description"
          rows={2}
          required
          maxLength={skillLimits.description}
          value={description}
          placeholder="Formats the weekly status report. Use when asked for a weekly update."
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="field-label" htmlFor="skill-instructions">
          Instructions (Markdown)
        </label>
        <textarea
          id="skill-instructions"
          className="mono"
          rows={10}
          maxLength={skillLimits.instructions}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <fieldset className="space-access-fields">
          <legend>Bundled files</legend>
          <p className="muted">
            Reference material the Dot can read on demand, such as templates or
            examples. Paths are relative to SKILL.md.
          </p>
          {files.map((file, index) => (
            <div className="file-row" key={file.key}>
              <div className="file-row-head">
                <label className="sr-only" htmlFor={`skill-file-${file.key}`}>
                  File {index + 1} path
                </label>
                <input
                  id={`skill-file-${file.key}`}
                  value={file.path}
                  maxLength={200}
                  placeholder="references/template.md"
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(e) =>
                    setFiles((rows) =>
                      rows.map((row) =>
                        row.key === file.key
                          ? { ...row, path: e.target.value }
                          : row,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove file ${file.path || index + 1}`}
                  onClick={() =>
                    setFiles((rows) =>
                      rows.filter((row) => row.key !== file.key),
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <label className="sr-only" htmlFor={`skill-content-${file.key}`}>
                File {index + 1} content
              </label>
              <textarea
                id={`skill-content-${file.key}`}
                className="mono"
                rows={4}
                maxLength={skillLimits.fileChars}
                value={file.content}
                onChange={(e) =>
                  setFiles((rows) =>
                    rows.map((row) =>
                      row.key === file.key
                        ? { ...row, content: e.target.value }
                        : row,
                    ),
                  )
                }
              />
            </div>
          ))}
          <button
            type="button"
            disabled={files.length >= skillLimits.files}
            onClick={() =>
              setFiles((rows) => [
                ...rows,
                { key: nextKey(), path: '', content: '' },
              ])
            }
          >
            <Plus size={14} />
            Add file
          </button>
        </fieldset>
        <p
          className={`muted size-meter ${total > skillLimits.totalChars ? 'over' : ''}`}
        >
          {total.toLocaleString('en-US')} /{' '}
          {skillLimits.totalChars.toLocaleString('en-US')} characters
        </p>
        <DotAvailability dotIds={dotIds} dots={dots} onChange={setDotIds} />
        <label className="permission-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            <strong>Enabled</strong>
            <small>Disabled skills stay saved but no Dot can load them.</small>
          </span>
        </label>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary full" disabled={busy}>
          {busy ? 'Saving…' : skill ? 'Save skill' : 'Create skill'}
        </button>
      </form>
    </Modal>
  );
}

interface HeaderRow {
  key: number;
  name: string;
  value: string;
}
const headerRows = (names: string[]): HeaderRow[] =>
  names.map((name) => ({ key: nextKey(), name, value: '' }));

function McpDialog({
  server: initial,
  dots,
  onClose,
  onSaved,
}: {
  server?: McpServerInfo;
  dots: DotRef[];
  onClose: () => void;
  onSaved: (server: McpServerInfo) => void;
}) {
  const [server, setServer] = useState(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [headers, setHeaders] = useState(() =>
    headerRows(initial?.headerNames ?? []),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [dotIds, setDotIds] = useState<string[] | null>(() =>
    knownDots(initial?.dotIds ?? null, dots),
  );
  const [checked, setChecked] = useState(() =>
    initial ? initialCheckedTools(initial) : [],
  );
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [error, setError] = useState('');
  const savedNames = server?.headerNames ?? [];
  const resetsTools =
    !!server &&
    server.tools.length > 0 &&
    (url.trim() !== server.url ||
      headers.some((row) => row.value) ||
      headers.some(
        (row) => row.name.trim() && !savedNames.includes(row.name.trim()),
      ) ||
      savedNames.some(
        (saved) => !headers.some((row) => row.name.trim() === saved),
      ));
  const save = async () => {
    if (dotIds !== null && !dotIds.length)
      throw new Error('Choose at least one Dot, or make it available to all.');
    const saved = await api<McpServerInfo>(
      server ? `/mcp/servers/${server.id}` : '/mcp/servers',
      server ? 'PUT' : 'POST',
      {
        name: name.trim(),
        url: url.trim(),
        headers: headers
          .filter((row) => row.name.trim())
          .map((row) =>
            row.value
              ? { name: row.name.trim(), value: row.value }
              : { name: row.name.trim() },
          ),
        enabled,
        dotIds,
        allowedTools: computeAllowedTools(
          server?.tools ?? [],
          checked,
          server?.allowedTools ?? null,
        ),
      },
    );
    // Values were sent once; the inputs return to "saved" placeholders.
    setServer(saved);
    setHeaders(headerRows(saved.headerNames));
    setChecked(initialCheckedTools(saved));
    onSaved(saved);
    return saved;
  };
  const test = async () => {
    setError('');
    setBusy('test');
    try {
      const saved = await save();
      const tested = await api<McpServerInfo>(
        `/mcp/servers/${saved.id}/test`,
        'POST',
        {},
      );
      setServer(tested);
      setChecked(initialCheckedTools(tested));
      onSaved(tested);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const tools = server?.tools ?? [];
  return (
    <Modal
      eyebrow="MCP SERVER"
      title={initial ? `Edit ${initial.name}` : 'Connect a remote MCP server.'}
      onClose={onClose}
    >
      <p className="help-note">
        Remote MCP servers only (Streamable HTTP or SSE). For stdio servers, run
        them behind an HTTP bridge — see docs/SETUP.md.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          setBusy('save');
          try {
            await save();
            onClose();
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(undefined);
          }
        }}
      >
        <label className="field-label" htmlFor="mcp-name">
          Name
        </label>
        <input
          id="mcp-name"
          value={name}
          required
          maxLength={32}
          pattern="[a-z0-9][a-z0-9\-]*"
          title="Lowercase letters, digits, and hyphens"
          placeholder="linear"
          aria-describedby="mcp-name-help"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="muted field-help" id="mcp-name-help">
          Lowercase letters, digits, and hyphens. Tools appear to Dots under
          this name.
        </p>
        <label className="field-label" htmlFor="mcp-url">
          Server URL
        </label>
        <input
          id="mcp-url"
          type="url"
          value={url}
          required
          maxLength={2048}
          placeholder="https://mcp.example.com/mcp"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
        <fieldset className="space-access-fields">
          <legend>Headers</legend>
          <p className="muted">
            For example Authorization. Values are stored on the server and never
            shown again.
          </p>
          {headers.map((row, index) => {
            const saved = savedNames.includes(row.name.trim());
            return (
              <div className="header-row" key={row.key}>
                <label className="sr-only" htmlFor={`mcp-header-${row.key}`}>
                  Header {index + 1} name
                </label>
                <input
                  id={`mcp-header-${row.key}`}
                  value={row.name}
                  maxLength={64}
                  placeholder="Authorization"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) =>
                    setHeaders((rows) =>
                      rows.map((item) =>
                        item.key === row.key
                          ? { ...item, name: e.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <label
                  className="sr-only"
                  htmlFor={`mcp-header-value-${row.key}`}
                >
                  Header {index + 1} value
                </label>
                <input
                  id={`mcp-header-value-${row.key}`}
                  type="password"
                  autoComplete="new-password"
                  value={row.value}
                  maxLength={8192}
                  placeholder={
                    saved ? 'Saved — leave blank to keep' : 'Bearer …'
                  }
                  onChange={(e) =>
                    setHeaders((rows) =>
                      rows.map((item) =>
                        item.key === row.key
                          ? { ...item, value: e.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove header ${row.name || index + 1}`}
                  onClick={() =>
                    setHeaders((rows) =>
                      rows.filter((item) => item.key !== row.key),
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            disabled={headers.length >= 20}
            onClick={() =>
              setHeaders((rows) => [
                ...rows,
                { key: nextKey(), name: '', value: '' },
              ])
            }
          >
            <Plus size={14} />
            Add header
          </button>
        </fieldset>
        <DotAvailability dotIds={dotIds} dots={dots} onChange={setDotIds} />
        <label className="permission-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            <strong>Enabled</strong>
            <small>Disabled servers stay saved but give Dots no tools.</small>
          </span>
        </label>
        <fieldset className="space-access-fields">
          <legend>Tools</legend>
          <div className="mcp-test-row">
            {server ? (
              <McpStatusPill server={server} />
            ) : (
              <span className="status wrap paused" data-tone="untested">
                <span />
                Not tested
              </span>
            )}
            <button type="button" disabled={!!busy} onClick={() => void test()}>
              <RefreshCw size={14} className={busy === 'test' ? 'spin' : ''} />
              {busy === 'test'
                ? 'Testing…'
                : server
                  ? 'Test connection'
                  : 'Save & test connection'}
            </button>
          </div>
          {resetsTools && (
            <p className="muted">
              Saving a new URL or header values clears the reviewed tools. Test
              again afterwards.
            </p>
          )}
          {tools.length ? (
            <>
              <p className="muted">
                Dots can call the checked tools.
                {server?.lastError
                  ? ' These are from the last successful test; Dots get nothing while the server fails.'
                  : ''}
              </p>
              <ul className="tool-list">
                {tools.map((tool) => (
                  <li key={tool.name}>
                    <label className="permission-row compact">
                      <input
                        type="checkbox"
                        checked={checked.includes(tool.name)}
                        onChange={(e) =>
                          setChecked((list) =>
                            e.target.checked
                              ? [...list, tool.name]
                              : list.filter((item) => item !== tool.name),
                          )
                        }
                      />
                      <span>
                        <strong>{tool.name}</strong>
                        {tool.readOnly && (
                          <span className="tool-badge">read-only</span>
                        )}
                        {tool.destructive && (
                          <span className="tool-badge danger">destructive</span>
                        )}
                        {tool.description && (
                          <small title={tool.description}>
                            {truncate(tool.description, 160)}
                          </small>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">
              {server?.checkedAt && !server.lastError
                ? 'The server lists no tools.'
                : 'Test the connection to review the tools this server offers. Until then, Dots get none of them.'}
            </p>
          )}
        </fieldset>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary full" disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Modal>
  );
}
