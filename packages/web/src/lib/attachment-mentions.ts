/**
 * The IDE types what it *means*, not what it shows: a native attachment arrives in the transcript as
 * an absolute path mention (`@/var/folders/…/codebuddy-dropped-files/<id>/native-test.txt`, and
 * `@image:/Users/…/assets/chips.a96dc56d9c.png` for a pasted image). The IDE renders that as a chip;
 * in the console the raw path would be a wall of text, so pull it out and label it by file name.
 *
 * Only **absolute** paths are treated as attachments — a plain `@src/app.ts` is a normal mention the
 * user typed, and stays in the sentence.
 */

const ATTACHMENT_MENTION = /@(?:image:)?(\/\S+)/g;

/** Trailing CJK punctuation belongs to the sentence, not to the file name. */
const TRAILING_PUNCTUATION = /[，。！？、；：）】」"'》]+$/;

export interface SplitHumanText {
  /** Text with the attachment mentions removed. */
  text: string;
  /** One label per attachment, in order (basename, no directory). */
  files: string[];
}

export function fileNameOf(path: string): string {
  const cut = path.replace(/[?#].*$/, '');
  const base = cut.slice(cut.lastIndexOf('/') + 1);
  return base.length > 0 ? base : cut;
}

export function splitAttachmentMentions(text: string): SplitHumanText {
  if (!text || !text.includes('@'))
    return { text: text ?? '', files: [] };
  const files: string[] = [];
  const stripped = text.replace(ATTACHMENT_MENTION, (_match, raw: string) => {
    files.push(fileNameOf(raw.replace(TRAILING_PUNCTUATION, '')));
    return ' ';
  });
  // Collapse the gap the removed path leaves behind, but keep the author's line breaks.
  const cleaned = stripped
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return { text: cleaned, files };
}
