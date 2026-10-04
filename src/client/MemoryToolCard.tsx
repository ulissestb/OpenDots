import { Brain } from 'lucide-react';
import type { ComputerToolRenderProps } from './ComputerToolCard';

const verbs: Record<string, [string, string]> = {
  save_memory: ['Saving memory', 'Memory saved'],
  update_memory: ['Updating memory', 'Memory updated'],
  forget_memory: ['Forgetting memory', 'Memory forgotten'],
};
export const isMemoryTool = (name: string) => Object.hasOwn(verbs, name);

function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { error: raw };
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

export function MemoryToolCard({
  name,
  status,
  args,
  result,
}: ComputerToolRenderProps) {
  const [pending, done] = verbs[name];
  const output = parse(result);
  const input = parse(args);
  const failed =
    typeof output.error === 'string' ||
    (status === 'complete' &&
      !output.saved &&
      !output.updated &&
      !output.forgotten);
  const text =
    [output.saved, output.updated, output.forgotten, input]
      .map((value) =>
        value && typeof value === 'object' && 'text' in value
          ? String((value as { text: unknown }).text)
          : '',
      )
      .find(Boolean) ?? '';
  return (
    <div className={`memory-tool ${failed ? 'failed' : ''}`} role="status">
      <Brain size={14} aria-hidden />
      <strong>
        {status !== 'complete' ? pending : failed ? 'Memory not changed' : done}
      </strong>
      {text && <span title={text}>{text}</span>}
    </div>
  );
}
