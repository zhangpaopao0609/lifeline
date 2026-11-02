/** Translate only public app-server items; provider thread ids never reach the web. */
export function codexTextUpdate(sessionUpdate: string, value: string, id: string): unknown {
  return { sessionUpdate, content: { type: 'text', text: value }, messageId: id };
}

export function codexItemUpdate(item: Record<string, unknown>, replay: boolean, complete: boolean): unknown {
  const id = text(item.id);
  if (!id)
    return undefined;
  if (item.type === 'agentMessage')
    return codexTextUpdate('agent_message_chunk', text(item.text), id);
  if (item.type === 'reasoning')
    return codexTextUpdate('agent_thought_chunk', Array.isArray(item.summary) ? item.summary.filter(part => typeof part === 'string').join('\n') : '', id);
  if (item.type === 'userMessage') {
    if (!replay)
      return undefined;
    const content = Array.isArray(item.content) ? item.content : [];
    return codexTextUpdate('user_message_chunk', content.map(part => text(record(part)?.text)).filter(Boolean).join('\n'), id);
  }
  if (!['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(text(item.type)))
    return undefined;
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes.map(change => text(record(change)?.path)).filter(Boolean);
  const mcpContent = record(item.result)?.content;
  const mcpText = Array.isArray(mcpContent) ? mcpContent.map(part => text(record(part)?.text)).filter(Boolean).join('\n') : '';
  const status = !complete ? 'in_progress' : item.status === 'failed' || item.status === 'declined' ? 'failed' : 'completed';
  return {
    sessionUpdate: complete ? 'tool_call_update' : 'tool_call',
    toolCallId: id,
    title: text(item.command) || paths.join('\n') || [text(item.server), text(item.tool)].filter(Boolean).join(': ') || text(item.type),
    kind: item.type === 'commandExecution' ? 'execute' : item.type === 'fileChange' ? 'edit' : 'other',
    status,
    content: [{ type: 'content', content: { type: 'text', text: text(item.aggregatedOutput) || text(record(item.error)?.message) || mcpText || changes.map(change => text(record(change)?.diff)).join('\n') } }],
    ...(paths[0] ? { locations: [{ path: paths[0] }] } : {}),
  };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
