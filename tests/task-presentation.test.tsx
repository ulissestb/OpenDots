import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  nextRunLabel,
  statusLabel,
  TaskRow,
  upcoming,
} from '../src/client/TaskPresentation';
import type { Task } from '../src/shared/types';
const now = 1_700_000_000_000;
const task: Task = {
  id: 'one',
  prompt: 'A recurring task',
  status: 'completed',
  intervalSeconds: 3600,
  nextRunAt: now + 5 * 60000,
  createdAt: now,
  updatedAt: now,
  error: null,
  lease: null,
  leaseUntil: null,
};
it('shows the retry time for a failed recurring task', () => {
  const failed: Task = { ...task, status: 'failed', error: 'Model offline' };
  expect(statusLabel(failed)).toBe('Retrying');
  expect(nextRunLabel(failed, now)).toBe('Retrying in 5m');
  const html = renderToStaticMarkup(
    <TaskRow
      task={{ ...failed, nextRunAt: Date.now() + 5 * 60000 }}
      onClick={() => {}}
    />,
  );
  expect(html).toContain('Retrying in 5m');
  expect(html).toContain('status failed');
});
it('keeps scheduled and terminal labels', () => {
  expect(statusLabel(task)).toBe('Scheduled');
  expect(nextRunLabel(task, now)).toBe('Next run in 5m');
  const done: Task = { ...task, status: 'failed', nextRunAt: null };
  expect(statusLabel(done)).toBe('Failed');
  expect(nextRunLabel(done, now)).toBe('');
  expect(nextRunLabel({ ...task, status: 'running' }, now)).toBe('');
  expect(upcoming(now + 30000, now)).toBe('soon');
  expect(upcoming(now + 3 * 3600000, now)).toBe('in 3h');
});
