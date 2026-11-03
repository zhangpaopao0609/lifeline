import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileNameOf, splitAttachmentMentions } from '../packages/web/src/lib/attachment-mentions.js';

describe('attachment mentions in the console bubble', () => {
  it('lifts a dropped-file path out of the sentence and labels it by name', () => {
    const out = splitAttachmentMentions(
      '这个文件叫什么？ @/var/folders/rs/qrk46/T/codebuddy-dropped-files/abc/native-test.txt',
    );
    assert.equal(out.text, '这个文件叫什么？');
    assert.deepEqual(out.files, ['native-test.txt']);
  });

  it('handles image mentions (the IDE writes @image:<path>)', () => {
    const out = splitAttachmentMentions('看图 @image:/Users/coln/Library/assets/chips.a96dc56d9c.png');
    assert.equal(out.text, '看图');
    assert.deepEqual(out.files, ['chips.a96dc56d9c.png']);
  });

  it('keeps relative @mentions — those are typed by the user, not attachments', () => {
    const out = splitAttachmentMentions('看下 @src/app.ts 这个文件');
    assert.equal(out.text, '看下 @src/app.ts 这个文件');
    assert.deepEqual(out.files, []);
  });

  it('never touches text that has no attachment', () => {
    const out = splitAttachmentMentions('普通消息\n第二行');
    assert.equal(out.text, '普通消息\n第二行');
    assert.deepEqual(out.files, []);
    assert.deepEqual(splitAttachmentMentions('').files, []);
  });

  it('takes the last path segment, and survives a trailing query', () => {
    assert.equal(fileNameOf('/a/b/c/report.json'), 'report.json');
    assert.equal(fileNameOf('/a/b/c/report.json?x=1'), 'report.json');
  });
});
