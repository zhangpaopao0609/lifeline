import { randomBytes } from 'node:crypto';
import net from 'node:net';

/**
 * Minimal WebSocket client over a unix socket, for `codex app-server --listen unix://…` (which speaks
 * WebSocket text frames, one JSON-RPC message per frame). No dependency: the runtime tarball ships only
 * the bundle plus better-sqlite3.
 */
export interface MessageTransport {
  send: (text: string) => void;
  onMessage: (fn: (text: string) => void) => void;
  onClose: (fn: () => void) => void;
  close: () => void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  }
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++)
    body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([header, mask, body]);
}

export function connectUnixWebSocket(path: string, timeoutMs = 5000): Promise<MessageTransport> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path);
    const listeners: Array<(text: string) => void> = [];
    const closers: Array<() => void> = [];
    const queued: string[] = [];
    let open = false;
    let closed = false;
    let buf: Buffer = Buffer.alloc(0);
    let parts: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`websocket handshake timeout: ${path}`));
    }, timeoutMs);

    const write = (opcode: number, payload: Buffer) => {
      if (!sock.destroyed)
        sock.write(frame(opcode, payload));
    };
    const emit = (text: string) => {
      if (listeners.length === 0)
        queued.push(text);
      for (const fn of listeners)
        fn(text);
    };
    const finish = () => {
      if (closed)
        return;
      closed = true;
      for (const fn of closers)
        fn();
    };

    const parse = () => {
      while (buf.length >= 2) {
        const fin = (buf[0]! & 0x80) !== 0;
        const opcode = buf[0]! & 0x0F;
        const masked = (buf[1]! & 0x80) !== 0;
        let len = buf[1]! & 0x7F;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4)
            return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        else if (len === 127) {
          if (buf.length < 10)
            return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskOff = off;
        if (masked)
          off += 4;
        if (buf.length < off + len)
          return;
        let payload = buf.subarray(off, off + len);
        if (masked) {
          const m = buf.subarray(maskOff, maskOff + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++)
            payload[i] = payload[i]! ^ m[i & 3]!;
        }
        buf = buf.subarray(off + len);
        if (opcode === 0x8) {
          write(0x8, Buffer.alloc(0));
          sock.end();
          finish();
          return;
        }
        if (opcode === 0x9) {
          write(0xA, payload);
          continue;
        }
        if (opcode === 0x1 || opcode === 0x2)
          parts = [payload];
        else if (opcode === 0x0)
          parts.push(payload);
        else
          continue;
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          emit(text);
        }
      }
    };

    sock.on('connect', () => {
      sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : chunk;
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0)
          return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          sock.destroy();
          reject(new Error(`websocket upgrade refused: ${head.split('\r\n')[0]}`));
          return;
        }
        open = true;
        resolve({
          send: text => write(0x1, Buffer.from(text, 'utf8')),
          onMessage: (fn) => {
            listeners.push(fn);
            for (const text of queued.splice(0))
              fn(text);
          },
          onClose: fn => closers.push(fn),
          close: () => {
            write(0x8, Buffer.alloc(0));
            sock.end();
            setTimeout(() => sock.destroy(), 500).unref();
          },
        });
      }
      parse();
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      if (open)
        finish();
      else
        reject(err);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!open)
        reject(new Error(`socket closed before websocket upgrade: ${path}`));
      finish();
    });
  });
}

/** True when a WebSocket server answers on `path` (the shared app-server is up). */
export async function probeUnixWebSocket(path: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ws = await connectUnixWebSocket(path, timeoutMs);
    ws.close();
    return true;
  }
  catch {
    return false;
  }
}
