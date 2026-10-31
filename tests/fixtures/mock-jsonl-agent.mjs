/**
 * Controllable NDJSON peer for JsonlRpc tests.
 * Never launches cursor-agent or codebuddy.
 *
 *   --mode echo | reverse | count | inbound | unknown | remote-error
 *        | huge | exact | stderr | hold-stdin | silent | exit-now
 *        | ignore-term | exit-on-term | term-sink
 *   --bytes N
 *   --stderr-extra N
 *   --term-file path
 *   --child-term-file path
 *   --ready-file path
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function readLines(onLine) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '')
      return;
    onLine(JSON.parse(line));
  });
}

function requestResult(message) {
  return {
    jsonrpc: '2.0',
    id: message.id,
    result: {
      id: message.id,
      method: message.method,
      params: message.params ?? null,
    },
  };
}

function echo() {
  readLines((message) => {
    if (message.id == null || typeof message.method !== 'string')
      return;
    reply(requestResult(message));
  });
}

function stayAlive() {
  setInterval(() => {}, 60_000);
}

function holdStdin() {
  let released = false;
  process.stdin.pause();
  process.on('SIGUSR1', () => {
    if (released)
      return;
    released = true;
    process.stdin.on('data', () => {});
    process.stdin.resume();
  });
  stayAlive();
}

function ignoreStopSignals(termFile) {
  process.on('SIGHUP', () => {});
  process.on('SIGTERM', () => {
    if (termFile)
      writeFileSync(termFile, 'term');
  });
}

function waitForFile(file) {
  const started = Date.now();
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(file)) {
    if (Date.now() - started > 3_000)
      throw new Error(`ready file missing: ${file}`);
    Atomics.wait(sleep, 0, 0, 10);
  }
}

function writeBytes(stream, buf) {
  let offset = 0;
  const chunkSize = 64 * 1024;
  const pump = () => {
    while (offset < buf.length) {
      const end = Math.min(offset + chunkSize, buf.length);
      const ok = stream.write(buf.subarray(offset, end));
      offset = end;
      if (!ok) {
        stream.once('drain', pump);
        return;
      }
    }
  };
  pump();
}

function parseArgs(argv) {
  const out = { 'bytes': 0, 'stderr-extra': 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--'))
      continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    i += 1;
    if (key === 'bytes' || key === 'stderr-extra')
      out[key] = Number(next);
    else
      out[key] = next;
  }
  return out;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.mode ?? 'echo';

  for (const stream of [process.stdin, process.stdout, process.stderr])
    stream.on('error', () => {});

  if (mode === 'term-sink') {
    ignoreStopSignals(options['term-file']);
    if (options['ready-file'])
      writeFileSync(options['ready-file'], 'ready');
    stayAlive();
  }
  else if (mode === 'ignore-term') {
    ignoreStopSignals(options['term-file']);
    const readyFile = options['ready-file'];
    const child = spawn(process.execPath, [
      process.argv[1],
      '--mode',
      'term-sink',
      '--term-file',
      options['child-term-file'] ?? '',
      '--ready-file',
      readyFile ?? '',
    ], { stdio: 'ignore' });
    if (readyFile)
      waitForFile(readyFile);
    reply({
      jsonrpc: '2.0',
      method: 'fixture/ready',
      params: { pid: process.pid, childPid: child.pid },
    });
    stayAlive();
  }
  else if (mode === 'exit-on-term') {
    const readyFile = options['ready-file'];
    const child = spawn(process.execPath, [
      process.argv[1],
      '--mode',
      'term-sink',
      '--term-file',
      options['child-term-file'] ?? '',
      '--ready-file',
      readyFile ?? '',
    ], { stdio: 'ignore' });
    if (readyFile)
      waitForFile(readyFile);
    reply({
      jsonrpc: '2.0',
      method: 'fixture/ready',
      params: { pid: process.pid, childPid: child.pid },
    });
    stayAlive();
  }
  else if (mode === 'exit-now') {
    process.exit(0);
  }
  else if (mode === 'hold-stdin') {
    holdStdin();
  }
  else if (mode === 'silent') {
    process.stdin.on('data', () => {});
    process.stdin.resume();
    stayAlive();
  }
  else if (mode === 'huge') {
    readLines((message) => {
      if (message.id == null)
        return;
      writeBytes(process.stdout, Buffer.alloc(options.bytes, 0x61));
    });
  }
  else if (mode === 'exact') {
    readLines((message) => {
      if (message.id == null)
        return;
      const prefix = `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"ok":true,"pad":"`;
      const suffix = '"}}';
      const padLen = options.bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      if (padLen < 0) {
        process.stderr.write(`pad underflow ${padLen}\n`);
        process.exit(1);
      }
      process.stdout.write(prefix);
      process.stdout.write('x'.repeat(padLen));
      process.stdout.write(`${suffix}\n`);
      stayAlive();
    });
  }
  else if (mode === 'stderr') {
    const extra = options['stderr-extra'];
    const buf = Buffer.alloc(options.bytes + extra);
    buf.fill(0x41, 0, options.bytes);
    buf.fill(0x42, options.bytes);
    process.stderr.write(buf);
    echo();
  }
  else if (mode === 'reverse') {
    const requests = [];
    readLines((message) => {
      if (message.id == null || typeof message.method !== 'string')
        return;
      requests.push(message);
      if (requests.length < 2)
        return;
      reply({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } });
      setTimeout(() => {
        reply(requestResult(requests[1]));
        reply(requestResult(requests[0]));
      }, 150);
    });
  }
  else if (mode === 'count') {
    const methods = [];
    let requestId;
    let armed = false;
    readLines((message) => {
      if (typeof message.method === 'string')
        methods.push(message.method);
      if (message.id == null || armed)
        return;
      armed = true;
      requestId = message.id;
      setTimeout(() => {
        reply({
          jsonrpc: '2.0',
          id: requestId,
          result: { count: methods.length, methods },
        });
      }, 150);
    });
  }
  else if (mode === 'inbound' || mode === 'unknown') {
    let originId;
    const inboundId = 'perm-1';
    readLines((message) => {
      if (message.id != null && typeof message.method === 'string' && originId == null) {
        originId = message.id;
        reply({
          jsonrpc: '2.0',
          id: inboundId,
          method: mode === 'inbound' ? 'session/request_permission' : 'custom/nope',
          params: mode === 'inbound' ? { title: 'run' } : {},
        });
        return;
      }
      if (message.id === inboundId && originId != null) {
        reply({
          jsonrpc: '2.0',
          id: originId,
          result: {
            result: message.result ?? null,
            error: message.error ?? null,
          },
        });
      }
    });
  }
  else if (mode === 'remote-error') {
    readLines((message) => {
      if (message.id == null)
        return;
      reply({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32001, message: 'provider failed' },
      });
    });
  }
  else {
    echo();
  }
}

main();
