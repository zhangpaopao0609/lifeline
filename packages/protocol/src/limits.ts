/** Socket.io default is 1e6 (1MB). A live Cursor session:full can be several MB. */
export const SOCKET_MAX_HTTP_BUFFER_SIZE = 20 * 1024 * 1024;

/** Agent uplink does sync sqlite + session:full on the main thread; 20s default drops it. */
export const SOCKET_PING_INTERVAL_MS = 25_000;
export const SOCKET_PING_TIMEOUT_MS = 120_000;

/**
 * Composer attachments. Bytes travel **inside** the `command:send_message` payload as base64
 * (the agent writes them to disk and types their paths), so the ceiling is derived from the
 * socket budget, not from taste: base64 inflates 4/3, and `SOCKET_MAX_HTTP_BUFFER_SIZE` is 20MB —
 * 12MB of raw bytes becomes ~16MB on the wire, still under the limit with room for the text.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;
