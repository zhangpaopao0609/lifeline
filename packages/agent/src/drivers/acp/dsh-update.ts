/** DSH titles tools by name; the operation and approval reason live in rawInput. */
export function describeDshToolUpdate(update: unknown): unknown {
  if (!isRecord(update) || update.sessionUpdate !== 'tool_call' || !isRecord(update.rawInput))
    return update;
  const input = update.rawInput;
  const parts = [input.description, input.command, input.justification]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (parts.length === 0)
    return update;
  // Keep approval previews bounded independently of the provider's argument size.
  return { ...update, title: [...new Set(parts)].join('\n').slice(0, 4000) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
