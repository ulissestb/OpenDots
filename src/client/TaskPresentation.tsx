import {
  CheckCheck,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import type { Task } from '../shared/types';
import { Mascot } from './Mascot';
export const relative = (value: number) => {
  const minutes = Math.floor((Date.now() - value) / 60000);
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(value).toLocaleDateString();
};
/** Short label for a future time, e.g. "in 5m" or a date and time. */
export const upcoming = (value: number, now = Date.now()) => {
  const minutes = Math.ceil((value - now) / 60000);
  return minutes <= 1
    ? 'soon'
    : minutes < 60
      ? `in ${minutes}m`
      : minutes < 1440
        ? `in ${Math.round(minutes / 60)}h`
        : new Date(value).toLocaleString();
};
export const statusLabel = (task: Task) =>
  task.status === 'completed' && task.nextRunAt
    ? 'Scheduled'
    : task.status === 'failed' && task.nextRunAt
      ? 'Retrying'
      : task.status.charAt(0).toUpperCase() + task.status.slice(1);
/** When a recurring task runs next; failed tasks retry with backoff. */
export const nextRunLabel = (task: Task, now = Date.now()) =>
  !task.nextRunAt
    ? ''
    : task.status === 'completed'
      ? `Next run ${upcoming(task.nextRunAt, now)}`
      : task.status === 'failed'
        ? `Retrying ${upcoming(task.nextRunAt, now)}`
        : '';
export function Status({ task }: { task: Task }) {
  return (
    <span className={`status ${task.status}`}>
      <span />
      {statusLabel(task)}
    </span>
  );
}

export function TaskRow({
  task,
  onClick,
}: {
  task: Task;
  onClick: () => void;
}) {
  return (
    <button className="task-row" onClick={onClick}>
      <span className="task-row-icon">
        {task.status === 'completed' ? (
          <CheckCheck size={19} />
        ) : task.status === 'running' ? (
          <LoaderCircle className="spin" size={19} />
        ) : (
          <MessageCircle size={19} />
        )}
      </span>
      <div>
        <strong>{task.prompt}</strong>
        <span>
          {task.intervalSeconds
            ? `Repeats every ${task.intervalSeconds < 3600 ? task.intervalSeconds / 60 + ' min' : task.intervalSeconds / 3600 + ' hr'} · `
            : ''}
          {relative(task.updatedAt)}
          {nextRunLabel(task) ? ` · ${nextRunLabel(task)}` : ''}
        </span>
      </div>
      <Status task={task} />
      <ChevronRight size={16} />
    </button>
  );
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="large-empty">
      <Mascot />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
