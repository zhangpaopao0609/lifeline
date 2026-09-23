import type { IdeKind, SessionMeta } from './types.js';

export class SessionIndexMerger {
  private readonly byIde = new Map<IdeKind, SessionMeta[]>();

  set(ide: IdeKind, sessions: SessionMeta[]): SessionMeta[] {
    this.byIde.set(ide, sessions);
    return this.get();
  }

  reportedIdes(): IdeKind[] {
    return [...this.byIde.keys()];
  }

  get(): SessionMeta[] {
    const merged: SessionMeta[] = [];
    for (const sessions of this.byIde.values()) {
      merged.push(...sessions);
    }
    merged.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    return merged;
  }
}
