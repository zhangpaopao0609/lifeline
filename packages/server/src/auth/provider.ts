import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { AuthKind } from '../../../protocol/src/index.js';
import type { AvatarUrlFor } from './avatar.js';

export type AuthProviderKind = AuthKind;

export interface VerifiedIdentity {
  /** Gateway-injected username / 'owner'. Called userId uniformly across the stack. */
  userId: string;
}

/**
 * Pluggable browser-side auth. The agent does not go through here — machine tokens (identity-store.ts)
 * are a separate channel; browser sessions and machine credentials are fully split.
 *
 * The interface shape is reverse-engineered from two existing call sites: relay's HTTP gate (gateHttp)
 * and the browser socket.io handshake (io.use) both only have headers and both want "identity or
 * reject", so `verify(headers)` covers both (cookies live in headers). verify only answers "who";
 * two things that don't fit go through optional hooks, so relay has zero type-specialization on the
 * provider:
 *
 * - `onHttpDenied`: response shape after verify fails (password: page GET → 302 /login;
 *   default = 403 forbiddenHtml).
 * - `checkHandshake`: extra socket.io handshake check (password: Origin against cross-site cookie
 *   hijacking). Return null = pass, string = reject reason.
 */
export interface AuthProvider {
  kind: AuthProviderKind;
  /** Identity entry point, shared by the HTTP gate and socket.io handshake; null = reject (403 / Unauthorized). */
  verify: (headers: IncomingHttpHeaders) => Promise<VerifiedIdentity | null>;
  /** Server-issued avatar URL; '' → frontend initial fallback (AUTH_AVATAR_URL template in avatar.ts). */
  avatarUrlFor: AvatarUrlFor;
  /** Default 403 page when verify fails (self-contained; gated static assets cannot load). */
  forbiddenHtml: string;
  /** Provider-layered unauthenticated paths (password's /login, etc.); stacked on top of the common isPublicPath; must be exact paths. */
  isPublicPath?: (path: string) => boolean;
  /** Mount login routes (password-only: /claim /login /api/*). */
  setupRoutes?: (app: FastifyInstance) => void;
  /** Custom response after verify fails. Return true = already replied; default is 403 forbiddenHtml. */
  onHttpDenied?: (req: FastifyRequest, reply: FastifyReply) => boolean;
  /** Extra socket.io handshake check. Return null = pass, string = reject reason (Unauthorized). */
  checkHandshake?: (headers: IncomingHttpHeaders) => string | null;
  /** Release resources held by the provider (password's sqlite connection); called from Relay.stop. */
  close?: () => void;
}
