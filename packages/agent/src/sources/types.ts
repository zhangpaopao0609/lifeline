/**
 * Content-live adapter contract types that are also on the wire live in
 * @lifeline/protocol. This file re-exports them so existing relative imports
 * keep working until packages/agent owns the adapters.
 */
export type {
  IdeKind,
  MessageHeader,
  SessionMeta,
  SessionRef,
} from '../../../protocol/src/index.js';

export interface SourceProbe {
  ok: boolean;
  schemaVersion?: string | number;
  versionMismatch?: boolean;
  rootPath: string;
  error?: string;
}
