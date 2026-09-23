import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQuestionAnswer } from '../packages/web/src/components/questionAnswer.ts';

/**
 * 2026-09-18 feedback: "after answering the questionnaire, this display isn't great".
 *
 * CodeBuddy sends the whole questionnaire + chosen answers as a `<question_answer>` XML user
 * message; rendering the raw text on the timeline is a screen full of angle brackets. Pin the
 * parse: when it parses, become "question + answer"; when it does not, return null (the caller
 * draws the text as-is and must not swallow the message).
 */

/** Real message from the screenshot (leading/trailing newlines included — IDE-extracted text often looks like this) */
const REAL = `
<question_answer>
<title>接下来做什么</title>
<questions>
<question_item id="next_action">
<question>针对当前这批未提交的改动，你希望我先做哪件事？</question>
<answers>
查看具体 diff(逐个文件展示改动内容，帮你梳理本次改了什么)
</answers>
</question_item>
<question_item id="focus_areas">
<question>这批改动涉及多个模块，你希望重点关注哪些部分？（可多选）</question>
<answers>
agent 侧（agents-window.ts / command-executor.ts / dom-extractor.ts 及对应测试）
</answers>
</question_item>
</questions>
</question_answer>
`;

describe('parseQuestionAnswer', () => {
  it('真实消息：标题 + 两道题 + 各自答案', () => {
    const qa = parseQuestionAnswer(REAL);
    assert.ok(qa);
    assert.equal(qa.title, '接下来做什么');
    assert.equal(qa.items.length, 2);
    assert.deepEqual(qa.items[0], {
      question: '针对当前这批未提交的改动，你希望我先做哪件事？',
      answers: ['查看具体 diff(逐个文件展示改动内容，帮你梳理本次改了什么)'],
    });
    assert.deepEqual(qa.items[1], {
      question: '这批改动涉及多个模块，你希望重点关注哪些部分？（可多选）',
      answers: ['agent 侧（agents-window.ts / command-executor.ts / dom-extractor.ts 及对应测试）'],
    });
  });

  it('多选题：answers 里逐行就是逐条答案', () => {
    const qa = parseQuestionAnswer(
      `<question_answer><title>t</title><questions><question_item id="a"><question>q</question>
<answers>
选项一
选项二
</answers></question_item></questions></question_answer>`,
    );
    assert.deepEqual(qa?.items[0].answers, ['选项一', '选项二']);
  });

  it('兼容 <answer> 包每一条的形态', () => {
    const qa = parseQuestionAnswer(
      '<question_answer><questions><question_item id="a"><question>q</question><answers><answer>甲</answer><answer>乙</answer></answers></question_item></questions></question_answer>',
    );
    assert.deepEqual(qa?.items[0].answers, ['甲', '乙']);
  });

  it('没有 title：标题退化为空串，题目照常解析', () => {
    const qa = parseQuestionAnswer(
      '<question_answer><questions><question_item id="a"><question>q</question><answers>A</answers></question_item></questions></question_answer>',
    );
    assert.equal(qa?.title, '');
    assert.deepEqual(qa?.items, [{ question: 'q', answers: ['A'] }]);
  });

  it('XML 实体还原；答案里多余空白压平（同一条内）', () => {
    const qa = parseQuestionAnswer(
      '<question_answer><questions><question_item id="a"><question>1 &lt; 2 &amp; 3 ?</question><answers>  a   &amp;   b  </answers></question_item></questions></question_answer>',
    );
    assert.equal(qa?.items[0].question, '1 < 2 & 3 ?');
    assert.deepEqual(qa?.items[0].answers, ['a & b']);
  });

  it('题目被跳过（没有 answers）：题干保留，答案为空', () => {
    const qa = parseQuestionAnswer(
      '<question_answer><questions><question_item id="a"><question>q</question><answers></answers></question_item></questions></question_answer>',
    );
    assert.deepEqual(qa?.items, [{ question: 'q', answers: [] }]);
  });

  it('不是问卷回答的文本一律返回 null（原文照旧画）', () => {
    assert.equal(parseQuestionAnswer('你好，帮我改个 bug'), null);
    assert.equal(parseQuestionAnswer('<question_answer>没有 item</question_answer>'), null);
    assert.equal(parseQuestionAnswer('<user_query>普通消息</user_query>'), null);
    assert.equal(parseQuestionAnswer(''), null);
    assert.equal(parseQuestionAnswer('前文 <question_answer><questions></questions></question_answer> 后文'), null);
  });
});
