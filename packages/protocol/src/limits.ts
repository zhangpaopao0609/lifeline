/** Socket.io default is 1e6 (1MB). A live Cursor session:full can be several MB. */
export const SOCKET_MAX_HTTP_BUFFER_SIZE = 20 * 1024 * 1024;

/** Agent uplink does sync sqlite + session:full on the main thread; 20s default drops it. */
export const SOCKET_PING_INTERVAL_MS = 25_000;
export const SOCKET_PING_TIMEOUT_MS = 120_000;
