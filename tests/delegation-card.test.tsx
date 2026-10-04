import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DelegationToolCard } from '../src/client/DelegationToolCard';
import type { Dot } from '../src/shared/types';

const dots = [{ id: 'researcher', name: 'Researcher' }] as unknown as Dot[];
const card = (props: { status: string; result?: unknown }) =>
  renderToStaticMarkup(
    <DelegationToolCard
      name="delegate_to_dot"
      toolCallId="call"
      args={JSON.stringify({ dot_id: 'researcher', task: 'Check the date.' })}
      dots={dots}
      {...props}
    />,
  );

it('shows the delegate while it works and links its conversation when done', () => {
  expect(card({ status: 'executing' })).toContain('Delegating to Researcher');
  const done = card({
    status: 'complete',
    result: JSON.stringify({
      dot: 'Researcher',
      conversationId: 'child-thread',
      reply: 'Done.',
    }),
  });
  expect(done).toContain('Researcher finished');
  expect(done).toContain('href="#/threads/child-thread"');
});

it('reports a refused delegation', () => {
  expect(
    card({ status: 'complete', result: 'Delegation depth limit reached' }),
  ).toContain('Researcher could not take this task');
});
