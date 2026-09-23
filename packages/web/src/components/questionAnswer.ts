/**
 * CodeBuddy questionnaire-answer message (human side). After the user finishes a questionnaire, the IDE
 * emits the whole questionnaire plus chosen answers as this XML **user message**. Raw form looks like:
 *
 *   <question_answer>
 *     <title>接下来做什么</title>
 *     <questions>
 *       <question_item id="next_action">
 *         <question>针对当前这批未提交的改动，你希望我先做哪件事？</question>
 *         <answers>
 *           查看具体 diff(逐个文件展示改动内容，帮你梳理本次改了什么)
 *         </answers>
 *       </question_item>
 *     </questions>
 *   </question_answer>
 *
 * Drawing the raw text on the timeline is a phone-screen of angle brackets (2026-09-18 feedback), so parse
 * into "question + answers" and hand it to QuestionAnswerCard. Parse failure always returns null; the caller
 * draws the original text — better to show the source than to swallow the message because the format drifted.
 */

export interface QuestionAnswerItem {
  /** Question stem (empty string if `<question>` is missing; answers are still kept). */
  question: string;
  /** Chosen answers: each line inside `<answers>` is one item; also accepts each item wrapped in `<answer>`. */
  answers: string[];
}

export interface QuestionAnswer {
  /** Questionnaire title (`<title>`, may be absent). */
  title: string;
  items: QuestionAnswerItem[];
}

/** The whole blob is one questionnaire answer; leading/trailing whitespace is allowed (IDE-extracted text often has it). */
const ROOT_RE = /^<question_answer(?:\s[^>]*)?>([\s\S]*)<\/question_answer>$/i;

/** First inner content of `<tag>` (open tag may have attributes): peel the shell of things like `<question_item id="…">`. */
function pickTag(source: string, tag: string): string | null {
  const m = source.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

/** XML entity unescape (`&amp;` last: otherwise `&amp;lt;` would become `<`). */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&');
}

/** Single-line text: unescape entities + collapse newlines/runs of whitespace to a single space. */
function clean(s: string): string {
  return unescapeXml(s).replace(/\s+/g, ' ').trim();
}

/**
 * `<answers>` content → answer list.
 * Primary shape is plain text, one item per line (multi-select is multiple lines); some versions wrap each
 * in `<answer>`. Split on child tags when present, otherwise on lines. Empty lines dropped.
 */
function splitAnswers(raw: string): string[] {
  const tagged = [...raw.matchAll(/<answer\b[^>]*>([\s\S]*?)<\/answer>/gi)].map(m => m[1]);
  const parts = tagged.length > 0 ? tagged : raw.split('\n');
  return parts.map(clean).filter(Boolean);
}

/**
 * Parse a questionnaire-answer message. Not this format / incomplete structure (no question_item) → null.
 */
export function parseQuestionAnswer(text: string): QuestionAnswer | null {
  const root = (text ?? '').trim().match(ROOT_RE);
  if (!root)
    return null;

  const body = root[1];
  const title = clean(pickTag(body, 'title') ?? '');

  const items: QuestionAnswerItem[] = [];
  for (const block of body.matchAll(/<question_item\b[^>]*>([\s\S]*?)<\/question_item>/gi)) {
    const question = clean(pickTag(block[1], 'question') ?? '');
    const answers = splitAnswers(pickTag(block[1], 'answers') ?? '');
    if (!question && answers.length === 0)
      continue;
    items.push({ question, answers });
  }
  if (items.length === 0)
    return null;

  return { title, items };
}
