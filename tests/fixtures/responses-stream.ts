/** A minimal streamed Responses API reply carrying one text message. */
export function responsesText(text: string) {
  const response = { id: 'resp_1', object: 'response', model: 'gpt-5.5' };
  const item = { id: 'msg_1', type: 'message', role: 'assistant' };
  const events = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        ...item,
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        ...response,
        status: 'completed',
        output: [
          {
            ...item,
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
/** An unsigned JWT with the ChatGPT claims the Codex sign-in returns. */
export function chatgptJwt(claims: Record<string, unknown> = {}) {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-1',
      chatgpt_plan_type: 'plus',
    },
    ...claims,
  })}.sig`;
}
