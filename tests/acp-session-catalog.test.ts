import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLI_MODEL_LIMIT } from '@lifeline/protocol';
import { annotateCursorSessionEfforts, cursorListedId, cursorListIdFromParameters, impliedCursorEffort, parseCursorModelList, readCursorParameters, readSessionCatalog, readSessionConfigIds, resolveCursorListSelection, rewriteCursorEffort } from '../packages/agent/src/drivers/acp/session-catalog.ts';

describe('readSessionCatalog', () => {
  it('keeps every CodeBuddy model and the session thinking list, including enabled', () => {
    const catalog = readSessionCatalog({
      sessionId: 'provider-secret',
      models: {
        currentModelId: 'glm-5.2',
        availableModels: [
          { modelId: 'glm-5.2', name: 'GLM 5.2' },
          { modelId: 'kimi-k3', name: 'Kimi K3' },
          { modelId: 'deepseek-v3', name: 'DeepSeek' },
        ],
      },
      configOptions: [
        {
          id: 'thought_level',
          category: 'thought_level',
          currentValue: 'high',
          options: [
            { value: 'enabled', name: 'On (default)' },
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'Extra high' },
            { value: 'max', name: 'Max' },
          ],
        },
      ],
    });
    assert.deepEqual(catalog, {
      models: [
        { id: 'glm-5.2', label: 'GLM 5.2' },
        { id: 'kimi-k3', label: 'Kimi K3' },
        { id: 'deepseek-v3', label: 'DeepSeek' },
      ],
      currentModelId: 'glm-5.2',
      thinking: {
        current: 'high',
        levels: [
          { value: 'enabled', label: 'On (default)' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Max' },
        ],
      },
    });
    assert.equal(JSON.stringify(catalog).includes('provider-secret'), false);
  });

  it('keeps each model effort list and does not copy the session dial onto every model', () => {
    const catalog = readSessionCatalog({
      models: {
        currentModelId: 'deepseek-v4.1-flash',
        availableModels: [
          {
            modelId: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash',
            _meta: {
              supportsReasoning: true,
              effortOptions: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
                { value: 'max', name: 'Max' },
              ],
            },
          },
          {
            modelId: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
            _meta: {
              effortOptions: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
                { value: 'xhigh', name: 'X-High' },
              ],
            },
          },
          { modelId: 'plain', name: 'Plain' },
        ],
      },
      configOptions: [{
        id: 'thought_level',
        currentValue: 'max',
        options: [
          { value: 'disabled', name: 'Off' },
          { value: 'low', name: 'Low' },
          { value: 'max', name: 'Max' },
          { value: 'enabled', name: 'On (default)' },
        ],
      }],
    });
    assert.deepEqual(catalog?.models.map(model => ({
      id: model.id,
      levels: model.thinking?.levels.map(level => level.value),
    })), [
      { id: 'deepseek-v4.1-flash', levels: ['low', 'high', 'max'] },
      { id: 'claude-sonnet-5', levels: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'plain', levels: undefined },
    ]);
    assert.deepEqual(catalog?.thinking?.levels.map(level => level.value), ['disabled', 'low', 'max', 'enabled']);
  });

  it('reads a Cursor list that has models and no thinking dial', () => {
    assert.deepEqual(readSessionCatalog({
      sessionId: 'cursor-session',
      models: {
        currentModelId: 'composer-2',
        availableModels: [
          { modelId: 'auto', name: 'Auto' },
          { modelId: 'composer-2', name: 'Composer 2' },
        ],
      },
    }), {
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'composer-2', label: 'Composer 2' },
      ],
      currentModelId: 'composer-2',
    });
  });

  it('reads a flat model array and a configOptions model list when the models block is empty', () => {
    assert.deepEqual(readSessionCatalog({
      models: [{ id: 'm1', name: 'Model One' }],
    }), {
      models: [{ id: 'm1', label: 'Model One' }],
    });

    assert.deepEqual(readSessionCatalog({
      config_options: [
        {
          id: 'model',
          category: 'model',
          current_value: 'kimi-code/k3',
          options: [
            { value: 'kimi-code/k2', name: 'K2' },
            { value: 'kimi-code/k3', name: 'K3' },
          ],
        },
        {
          id: 'thinking',
          category: 'thought_level',
          current_value: 'max',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'max', name: 'Max' },
          ],
        },
      ],
    }), {
      models: [
        { id: 'kimi-code/k2', label: 'K2' },
        { id: 'kimi-code/k3', label: 'K3' },
      ],
      currentModelId: 'kimi-code/k3',
      thinking: {
        current: 'max',
        levels: [
          { value: 'low', label: 'Low' },
          { value: 'max', label: 'Max' },
        ],
      },
    });
  });

  it('prefers availableModels over a config model list and drops a current id that is not listed', () => {
    const catalog = readSessionCatalog({
      models: {
        currentModelId: 'missing',
        available_models: [{ model_id: 'real', name: 'Real' }],
      },
      configOptions: [{
        id: 'model',
        currentValue: 'other',
        options: [{ value: 'other', name: 'Other' }],
      }],
    });
    assert.deepEqual(catalog, {
      models: [{ id: 'real', label: 'Real' }],
    });
  });

  it('returns nothing when the session names no models', () => {
    assert.equal(readSessionCatalog({ sessionId: 'only' }), undefined);
    assert.equal(readSessionCatalog({ models: { availableModels: [] } }), undefined);
    assert.equal(readSessionCatalog(null), undefined);
  });

  it('keeps the current model when the list is longer than the cap', () => {
    const availableModels = Array.from({ length: CLI_MODEL_LIMIT + 5 }, (_, index) => ({
      modelId: `m-${index}`,
      name: `Model ${index}`,
    }));
    const last = `m-${CLI_MODEL_LIMIT + 4}`;
    const catalog = readSessionCatalog({
      models: { currentModelId: last, availableModels },
    });
    assert.equal(catalog?.models.length, CLI_MODEL_LIMIT);
    assert.equal(catalog?.currentModelId, last);
    assert.equal(catalog?.models.some(model => model.id === last), true);
  });

  it('keeps the config option ids used to set a session model or thinking level', () => {
    assert.deepEqual(readSessionConfigIds({
      configOptions: [
        { id: 'model', category: 'model', options: [] },
        { id: 'thought_level', category: 'thought_level', options: [] },
      ],
    }), { modelConfigId: 'model', thinkingConfigId: 'thought_level' });
    assert.deepEqual(readSessionConfigIds({ models: { availableModels: [{ modelId: 'm1', name: 'M' }] } }), {});
  });
});

describe('parseCursorModelList', () => {
  it('keeps effort inside the model id and marks the default row', () => {
    const catalog = parseCursorModelList(`Available models

auto - Auto (default)
grok-4.7-low - Grok 4.7  Low
grok-4.7-high - Grok 4.7  High
Tip: use --model <id> to switch.
`);
    assert.deepEqual(catalog, {
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'grok-4.7-low', label: 'Grok 4.7 Low' },
        { id: 'grok-4.7-high', label: 'Grok 4.7 High' },
      ],
      currentModelId: 'auto',
    });
    assert.equal(catalog?.thinking, undefined);
    assert.equal(catalog?.models.some(model => model.thinking), false);
  });
});

describe('cursor list ids', () => {
  const template = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]';
  const listed = [
    { id: 'grok-4.7-low', label: 'Grok 4.7 Low' },
    { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast' },
  ];

  it('names the session with the list id that includes speed', () => {
    assert.equal(cursorListedId(template, listed), 'grok-4.7-high-fast');
    assert.equal(cursorListedId('grok-4.7[reasoning_effort=low]', listed), 'grok-4.7-low');
  });

  it('maps a list id onto the family name and its effort and speed dials', () => {
    const names = ['grok-4.7', 'grok-4.6', 'composer-2.5', 'gpt-5.3-codex', 'claude-opus-5-high', 'auto-smart'];
    assert.deepEqual(resolveCursorListSelection('grok-4.7-low', names), {
      modelId: 'grok-4.7',
      effort: 'low',
      fast: false,
    });
    assert.deepEqual(resolveCursorListSelection('grok-4.7-high-fast', names), {
      modelId: 'grok-4.7',
      effort: 'high',
      fast: true,
    });
    assert.deepEqual(resolveCursorListSelection('cursor-grok-4.6-low', names), {
      modelId: 'grok-4.6',
      effort: 'low',
      fast: false,
    });
    assert.deepEqual(resolveCursorListSelection('composer-2.5', names), {
      modelId: 'composer-2.5',
      fast: false,
    });
    assert.deepEqual(resolveCursorListSelection('composer-2.5-fast', names), {
      modelId: 'composer-2.5',
      fast: true,
    });
    assert.deepEqual(resolveCursorListSelection('gpt-5.3-codex-low-fast', names), {
      modelId: 'gpt-5.3-codex',
      effort: 'low',
      fast: true,
    });
    assert.deepEqual(resolveCursorListSelection('claude-opus-5-high', names), {
      modelId: 'claude-opus-5-high',
      fast: false,
    });
    assert.deepEqual(resolveCursorListSelection('auto', names), {
      modelId: 'auto-smart',
      fast: false,
    });
  });

  it('names the parameterized session with the matching list id', () => {
    const names = ['grok-4.7', 'gpt-5.3-codex', 'composer-2.5'];
    const listed = [
      { id: 'grok-4.7-low' },
      { id: 'grok-4.7-high-fast' },
      { id: 'gpt-5.3-codex' },
      { id: 'gpt-5.3-codex-low' },
      { id: 'gpt-5.3-codex-high' },
      { id: 'gpt-5.3-codex-fast' },
      { id: 'composer-2.5' },
      { id: 'composer-2.5-fast' },
    ];
    assert.equal(cursorListIdFromParameters({
      modelNames: names,
      modelId: 'grok-4.7',
      effort: { id: 'reasoning_effort', value: 'high', values: ['low', 'high'] },
      fast: { id: 'fast', value: 'true', values: ['false', 'true'] },
    }, listed), 'grok-4.7-high-fast');
    assert.equal(cursorListIdFromParameters({
      modelNames: names,
      modelId: 'gpt-5.3-codex',
      effort: { id: 'reasoning', value: 'medium', values: ['low', 'medium', 'high'] },
      fast: { id: 'fast', value: 'false', values: ['false', 'true'] },
    }, listed), 'gpt-5.3-codex');
    assert.equal(impliedCursorEffort('gpt-5.3-codex', names, listed, ['low', 'medium', 'high']), 'medium');
    assert.equal(cursorListIdFromParameters({
      modelNames: names,
      modelId: 'composer-2.5',
      fast: { id: 'fast', value: 'false', values: ['false', 'true'] },
    }, listed), 'composer-2.5');
  });

  it('reads the parameterized model, effort, and speed dials', () => {
    const state = readCursorParameters({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'grok-4.7',
          options: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
        },
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
        {
          id: 'fast',
          category: 'model_config',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'On' },
          ],
        },
      ],
    });
    assert.deepEqual(state, {
      modelNames: ['grok-4.7'],
      modelId: 'grok-4.7',
      effort: { id: 'reasoning_effort', value: 'low', values: ['low', 'high'] },
      fast: { id: 'fast', value: 'false', values: ['false', 'true'] },
    });
  });
});

describe('annotateCursorSessionEfforts', () => {
  it('attaches sibling efforts from the flat list and keeps the rest of the id', () => {
    const catalog = {
      models: [
        {
          id: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
          label: 'grok-4.7',
        },
        { id: 'composer-2.5[fast=true]', label: 'composer-2.5' },
        { id: 'auto-smart[optimize_for=balanced]', label: 'Auto Balance' },
      ],
      currentModelId: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
    };
    annotateCursorSessionEfforts(catalog, [
      { id: 'grok-4.7-low', label: 'Grok 4.7 Low' },
      { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast' },
      { id: 'grok-4.7-xhigh', label: 'Grok 4.7 Extra High' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
    ]);
    assert.deepEqual(catalog.models[0]?.thinking, {
      current: 'high',
      levels: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra High' },
      ],
    });
    assert.equal(catalog.models[1]?.thinking, undefined);
    assert.equal(catalog.models[2]?.thinking, undefined);
    assert.equal(
      rewriteCursorEffort(catalog.models[0]!.id, 'low'),
      'grok-4.7[context=256k,reasoning_effort=low,fast=true]',
    );
    assert.equal(rewriteCursorEffort('grok-4.6[effort=medium]', 'high'), 'grok-4.6[effort=high]');
    assert.equal(rewriteCursorEffort('composer-2.5[fast=true]', 'high'), undefined);
  });

  it('matches a cursor-prefixed list id to the session family', () => {
    const catalog = {
      models: [{ id: 'grok-4.5[effort=low]', label: 'grok-4.5' }],
      currentModelId: 'grok-4.5[effort=low]',
    };
    annotateCursorSessionEfforts(catalog, [
      { id: 'cursor-grok-4.5-low', label: 'Grok 4.5 Low' },
      { id: 'cursor-grok-4.5-high', label: 'Grok 4.5 High' },
    ]);
    assert.deepEqual(catalog.models[0]?.thinking?.levels.map(level => level.value), ['low', 'high']);
  });

  it('leaves a family with one effort unchanged', () => {
    const catalog = {
      models: [{ id: 'solo[reasoning=high]', label: 'solo' }],
    };
    annotateCursorSessionEfforts(catalog, [{ id: 'solo-high', label: 'Solo High' }]);
    assert.equal(catalog.models[0]?.thinking, undefined);
  });
});
