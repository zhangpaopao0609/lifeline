export interface WindowSessionTab {
  title: string;
  isActive: boolean;
}

/** The session already current in a window, or the only session if none is marked. */
export function pickWindowSession(tabs: WindowSessionTab[]): string | undefined {
  const named = tabs.filter(t => t.title.trim().length > 0);
  const active = named.find(t => t.isActive);
  if (active)
    return active.title;
  if (named.length === 1)
    return named[0]?.title;
  return undefined;
}
