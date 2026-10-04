import { Users } from 'lucide-react';
import type { Dot } from '../shared/types';
import type { ComputerToolRenderProps } from './ComputerToolCard';
import { openPageLink } from './page-navigation';

export const isDelegationTool = (name: string) => name === 'delegate_to_dot';

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

export function DelegationToolCard({
  status,
  args,
  result,
  dots,
}: ComputerToolRenderProps & { dots: Dot[] }) {
  const input = parse(args);
  const output = parse(result);
  const target =
    dots.find((dot) => dot.id === input.dot_id)?.name ??
    (typeof output.dot === 'string' ? output.dot : 'another Dot');
  const conversation =
    typeof output.conversationId === 'string' ? output.conversationId : '';
  const failed =
    status === 'complete' &&
    (!conversation || typeof output.error === 'string');
  const task = typeof input.task === 'string' ? input.task : '';
  return (
    <div className={`memory-tool ${failed ? 'failed' : ''}`} role="status">
      <Users size={14} aria-hidden />
      <strong>
        {status !== 'complete'
          ? `Delegating to ${target}`
          : failed
            ? `${target} could not take this task`
            : `${target} finished`}
      </strong>
      {task && <span title={task}>{task}</span>}
      {conversation && (
        <a
          href={`#/threads/${conversation}`}
          onClick={(event) => {
            event.preventDefault();
            openPageLink(`#/threads/${conversation}`);
          }}
        >
          Open
        </a>
      )}
    </div>
  );
}
