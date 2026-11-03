import type { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import type { CommandTarget } from '../packages/agent/src/command-router.js';
import type { CommandPayload, CommandResult } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { interpretPasteAttach, isImageFile, mimeOfFile, pasteAttachmentsExpression } from '../packages/agent/src/attach-files.js';
import {
  decodeAttachmentData,
  materializeAttachments,
  safeAttachmentName,
} from '../packages/agent/src/attachments.js';
import { attachCommandHandlers } from '../packages/agent/src/command-router.js';
import {
  ATTACHMENT_BLOCK_TITLE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  stripAttachmentBlock,
  withAttachmentPaths,
} from '../packages/protocol/src/index.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const dirs: string[] = [];
function tmpUploadDir(): string {
  const dir = join(tmpdir(), `lifeline-attach-${process.pid}-${dirs.length}-${Date.now()}`);
  dirs.push(dir);
  return dir;
}

after(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

/**
 * Minimal target: send_message without a window/tab never touches CDP.
 * `native` = how the IDE's attachment pipeline answers (undefined = this build has no such hook).
 * `bridge` = extra CDP members a test needs (window switching); absent means no window in the payload.
 */
function targetOf(
  uploadDir: string,
  native?: (commandId: string, files: { name: string; mime: string }[]) => Promise<CommandResult>,
  bridge: Record<string, unknown> = {},
): {
  target: CommandTarget;
  sent: string[];
  results: CommandResult[];
  pasted: string[][];
  sentPreserving: boolean[];
} {
  const sent: string[] = [];
  const results: CommandResult[] = [];
  const pasted: string[][] = [];
  const sentPreserving: boolean[] = [];
  const target: CommandTarget = {
    uploadDir,
    cdpBridge: bridge as unknown as CDPBridge,
    commandExecutor: {
      sendMessage: async (commandId: string, text: string, options?: { preserveComposer?: boolean }) => {
        sent.push(text);
        sentPreserving.push(options?.preserveComposer === true);
        return { commandId, ok: true };
      },
      attachFiles: native
        ? async (commandId: string, files: { name: string; mime: string }[]) => {
          pasted.push(files.map(f => f.name));
          return native(commandId, files);
        }
        : undefined,
    } as unknown as CommandTarget['commandExecutor'],
    emitResult: (result) => {
      results.push(result);
    },
  };
  return { target, sent, results, pasted, sentPreserving };
}

function createBus(): {
  on: (event: string, handler: (payload: CommandPayload) => void) => void;
  emit: (event: string, payload: CommandPayload) => Promise<void>;
} {
  const handlers = new Map<string, Array<(payload: CommandPayload) => unknown>>();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async emit(event, payload) {
      const list = handlers.get(event) ?? [];
      await Promise.all(list.map(handler => Promise.resolve(handler(payload))));
    },
  };
}

describe('attachment names', () => {
  it('keeps the base name only — a crafted path cannot steer the write', () => {
    assert.equal(safeAttachmentName('../../etc/passwd'), 'passwd');
    assert.equal(safeAttachmentName('C:\\Windows\\System32\\x.dll'), 'x.dll');
    assert.equal(safeAttachmentName('..'), 'file');
  });

  it('keeps Chinese and the extension, drops quotes and control characters', () => {
    assert.equal(safeAttachmentName('截图 2026:11:02.png'), '截图_2026_11_02.png');
    assert.equal(safeAttachmentName('a"b`.sh'), 'a_b_.sh');
  });

  it('accepts a data: prefix and rejects an empty body', () => {
    assert.equal(decodeAttachmentData(`data:image/png;base64,${b64('hi')}`).toString('utf8'), 'hi');
    assert.throws(() => decodeAttachmentData(''), /附件内容为空/);
  });
});

describe('materializeAttachments', () => {
  it('writes each file under the upload dir with a unique, timestamped name', () => {
    const dir = tmpUploadDir();
    const now = Date.parse('2026-11-02T07:30:00.000Z');
    const out = materializeAttachments(
      [
        { name: 'a.png', size: 2, data: b64('aa') },
        { name: 'a.png', size: 2, data: b64('bb') },
      ],
      dir,
      now,
    );

    assert.equal(out.length, 2);
    assert.notEqual(out[0]!.path, out[1]!.path, 'same name twice must not overwrite');
    assert.ok(out[0]!.path.startsWith(dir));
    assert.ok(out[0]!.path.includes('20261102T073000'));
    assert.equal(readFileSync(out[0]!.path, 'utf8'), 'aa');
    assert.equal(readFileSync(out[1]!.path, 'utf8'), 'bb');
    // Original names are reported back for the console.
    assert.deepEqual(out.map(o => o.name), ['a.png', 'a.png']);
  });

  it('refuses too many files, an oversized file, and an empty file', () => {
    const dir = tmpUploadDir();
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      size: 1,
      data: b64('x'),
    }));
    assert.throws(() => materializeAttachments(many, dir), /附件最多/);

    const huge = { name: 'huge.bin', size: MAX_ATTACHMENT_BYTES + 1, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') };
    assert.throws(() => materializeAttachments([huge], dir), /超过/);

    assert.throws(() => materializeAttachments([{ name: 'empty.txt', size: 0, data: b64('') }], dir), /附件内容为空/);
  });

  it('names the step and the path when the disk refuses — that string is the whole error the console shows', () => {
    // A file where the directory should be: mkdir fails with ENOTDIR/EEXIST.
    const blocker = join(tmpUploadDir(), 'not-a-dir');
    mkdirSync(join(blocker, '..'), { recursive: true });
    writeFileSync(blocker, 'x');
    assert.throws(
      () => materializeAttachments([{ name: 'k.txt', size: 1, data: b64('k') }], blocker),
      (err: Error) => err.message.includes('附件目录不可写') && err.message.includes(blocker),
    );

    if (process.platform === 'win32' || process.getuid?.() === 0)
      return;
    // Read-only directory: the write itself fails, and the message must name the file.
    const dir = tmpUploadDir();
    materializeAttachments([{ name: 'first.txt', size: 1, data: b64('f') }], dir);
    chmodSync(dir, 0o500);
    try {
      assert.throws(
        () => materializeAttachments([{ name: 'k.txt', size: 1, data: b64('k') }], dir),
        (err: Error) => err.message.includes('写入附件失败') && err.message.includes(dir),
      );
    }
    finally {
      chmodSync(dir, 0o700);
    }
  });

  it('creates the directory with owner-only permissions for the files', () => {
    const dir = tmpUploadDir();
    const [file] = materializeAttachments([{ name: 'k.txt', size: 1, data: b64('k') }], dir);
    if (process.platform !== 'win32')
      assert.equal(statSync(file!.path).mode & 0o777, 0o600);
  });
});

describe('attachment prompt block', () => {
  it('appends paths after the user text and strips back to the original text', () => {
    const text = withAttachmentPaths('看下这张图', ['/tmp/a.png']);
    assert.ok(text.startsWith('看下这张图\n\n'));
    assert.ok(text.includes(`${ATTACHMENT_BLOCK_TITLE}\n- /tmp/a.png`));
    assert.equal(stripAttachmentBlock(text), '看下这张图');
  });

  it('a files-only message is just the block, and strips to empty', () => {
    const text = withAttachmentPaths('', ['/tmp/a.png']);
    assert.ok(text.startsWith(ATTACHMENT_BLOCK_TITLE));
    assert.equal(stripAttachmentBlock(text), '');
  });

  it('leaves text without a block untouched', () => {
    assert.equal(stripAttachmentBlock('普通消息'), '普通消息');
    assert.equal(stripAttachmentBlock(`提到 ${ATTACHMENT_BLOCK_TITLE} 的正文`), `提到 ${ATTACHMENT_BLOCK_TITLE} 的正文`);
  });
});

describe('command:send_message with attachments', () => {
  it('types the user text plus the local paths', async () => {
    const dir = tmpUploadDir();
    const { target, sent, results } = targetOf(dir);
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'a1',
      type: 'send_message',
      text: '看图',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });

    assert.equal(results[0]?.ok, true);
    assert.ok(sent[0]!.startsWith('看图\n\n'));
    assert.ok(sent[0]!.includes(dir), 'the prompt must reference the local copy');
  });

  it('accepts a files-only send (no text)', async () => {
    const dir = tmpUploadDir();
    const { target, sent, results } = targetOf(dir);
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'a2',
      type: 'send_message',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });

    assert.equal(results[0]?.ok, true);
    assert.ok(sent[0]!.includes(dir));
  });

  it('fails the send when the write fails — never types a prompt pointing at missing files', async () => {
    // A file where the directory should be: mkdirSync throws EEXIST/ENOTDIR.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const base = mkdtempSync(join(tmpdir(), 'lifeline-attach-blocked-'));
    const blocker = join(base, 'not-a-dir');
    writeFileSync(blocker, '');
    dirs.push(base);

    const { target, sent, results } = targetOf(blocker);
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'a3',
      type: 'send_message',
      text: '看图',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });

    assert.equal(results[0]?.ok, false);
    assert.equal(sent.length, 0, 'nothing may be typed when the attachment could not be saved');
  });

  it('still requires text or attachments', async () => {
    const { target, sent, results } = targetOf(tmpUploadDir());
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', { commandId: 'a4', type: 'send_message', text: '' });

    assert.equal(results[0]?.ok, false);
    assert.equal(sent.length, 0);
  });
});

describe('native attachment route (IDE paste)', () => {
  it('an image the IDE accepts travels as an attachment — no path text in the prompt', async () => {
    const { target, sent, pasted } = targetOf(tmpUploadDir(), async commandId => ({ commandId, ok: true }));
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'n1',
      type: 'send_message',
      text: '看图',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });

    assert.deepEqual(pasted[0], ['shot.png']);
    assert.equal(sent[0], '看图', 'the IDE already holds the image; the prompt stays clean');
  });

  it('a refused paste falls back to typing the local path', async () => {
    const dir = tmpUploadDir();
    const { target, sent } = targetOf(dir, async commandId => ({ commandId, ok: false, error: 'no composer' }));
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'n2',
      type: 'send_message',
      text: '看图',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });

    assert.ok(sent[0]!.includes(dir));
  });

  it('a text file becomes a native @-file mention as well (measured on CodeBuddy)', async () => {
    const dir = tmpUploadDir();
    const { target, sent, pasted } = targetOf(dir, async commandId => ({ commandId, ok: true }));
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'n3',
      type: 'send_message',
      text: '看下这个文件',
      attachments: [{ name: 'notes.txt', size: 3, data: b64('txt') }],
    });

    assert.deepEqual(pasted[0], ['notes.txt']);
    assert.equal(sent[0], '看下这个文件');
  });

  it('a build without the hook keeps the old path route', async () => {
    const dir = tmpUploadDir();
    const { target, sent } = targetOf(dir);
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'n4',
      type: 'send_message',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });

    assert.ok(sent[0]!.includes(dir));
  });

  it('switches to the target window before pasting — the file must not stay in the previous chat', async () => {
    const order: string[] = [];
    const { target, sent } = targetOf(tmpUploadDir(), async (commandId) => {
      order.push('attach');
      return { commandId, ok: true };
    }, {
      activeTargetId: 'window-a',
      switchWindow: async () => { order.push('switchWindow'); },
      raiseActiveWindow: async () => { order.push('raise'); },
    });
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'n5',
      type: 'send_message',
      text: '看图',
      windowId: 'window-b',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });

    assert.deepEqual(order, ['switchWindow', 'raise', 'attach']);
    assert.equal(sent[0], '看图');
  });

  it('a partial paste (one chip for two files) falls back to typing both paths', async () => {
    const dir = tmpUploadDir();
    const { target, sent } = targetOf(dir, async commandId => ({ commandId, ok: false, error: 'composer took 1/2', attached: 1 }));
    const bus = createBus();
    attachCommandHandlers(bus.on, target);

    await bus.emit('command:send_message', {
      commandId: 'n6',
      type: 'send_message',
      text: '两份',
      attachments: [
        { name: 'a.png', size: 3, data: b64('a') },
        { name: 'b.png', size: 3, data: b64('b') },
      ],
    });

    assert.ok(sent[0]!.includes('a.png'), 'the file the IDE dropped must still be named in the prompt');
    assert.ok(sent[0]!.includes('b.png'));
  });

  it('tells the driver to keep the composer when the attachment is native, and not otherwise', async () => {
    const native = targetOf(tmpUploadDir(), async commandId => ({ commandId, ok: true }));
    const nativeBus = createBus();
    attachCommandHandlers(nativeBus.on, native.target);
    await nativeBus.emit('command:send_message', {
      commandId: 'n7',
      type: 'send_message',
      text: '看图',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });
    assert.deepEqual(native.sentPreserving, [true]);

    const fallback = targetOf(tmpUploadDir(), async commandId => ({ commandId, ok: false, error: 'no composer' }));
    const fallbackBus = createBus();
    attachCommandHandlers(fallbackBus.on, fallback.target);
    await fallbackBus.emit('command:send_message', {
      commandId: 'n8',
      type: 'send_message',
      text: '看图',
      attachments: [{ name: 'shot.png', size: 3, data: b64('png') }],
    });
    assert.deepEqual(fallback.sentPreserving, [false]);
  });
});

describe('paste script', () => {
  it('carries every file name, mime type and body into the page', () => {
    const script = pasteAttachmentsExpression([
      { name: '图 1.png', mime: 'image/png', base64: b64('a') },
    ]);
    assert.ok(script.includes('图 1.png'));
    assert.ok(script.includes('image/png'));
    assert.ok(script.includes(b64('a')));
    assert.ok(script.includes('ClipboardEvent'));
    assert.ok(script.includes('.aislash-editor-input'), 'must target the chat composer');
  });

  it('derives mime from the extension', () => {
    assert.equal(mimeOfFile('a.PNG'), 'image/png');
    assert.equal(mimeOfFile('a.tar.gz'), 'application/octet-stream');
    assert.equal(isImageFile('x.webp'), true);
    assert.equal(isImageFile('x.pdf'), false);
  });

  it('reads the composer answer', () => {
    assert.equal(interpretPasteAttach({ ok: true, after: 1 }).ok, true);
    assert.equal(interpretPasteAttach({ ok: false, error: 'composer not found' }).error, 'composer not found');
    assert.equal(interpretPasteAttach(null).ok, false);
  });

  it('does not call a partial paste a success', () => {
    const partial = interpretPasteAttach({ ok: false, added: 1, error: 'composer took 1/2' });
    assert.equal(partial.ok, false);
    assert.equal(partial.attached, 1, 'the count is reported so the log explains the fallback');
    assert.equal(interpretPasteAttach({ ok: true, added: 2 }).attached, 2);
  });
});
