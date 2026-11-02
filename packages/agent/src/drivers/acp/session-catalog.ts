import type { CliModelCatalog, CliModelChoice, CliThinkingLevel } from '@lifeline/protocol';
import {
  CLI_MODEL_ID_MAX,
  CLI_MODEL_LABEL_MAX,
  CLI_MODEL_LIMIT,
  CLI_THINKING_LEVEL_LIMIT,
  CLI_THINKING_VALUE_MAX,
} from '@lifeline/protocol';

const EFFORT_KEYS = new Set(['effort', 'thought_level', 'reasoning_effort']);

/**
 * Reads the model list and the session's thinking levels from one `session/new` result.
 * Tokens stay as the CLI spelled them. An empty model list returns undefined:
 * a missing catalog is not filled with a static stand-in.
 * A model's own effort list is read from `_meta.effortOptions`. The session
 * `thought_level` dial stays on `catalog.thinking` and is not copied onto every model.
 */
export function readSessionCatalog(result: unknown): CliModelCatalog | undefined {
  if (!isRecord(result))
    return undefined;
  const fromModels = readModelBlock(result.models);
  const picked = fromModels.models.length > 0 ? fromModels : readConfigModels(result);
  if (picked.models.length === 0)
    return undefined;
  const models = capModels(picked.models, picked.currentId);
  const catalog: CliModelCatalog = { models };
  if (picked.currentId && models.some(model => model.id === picked.currentId))
    catalog.currentModelId = picked.currentId;
  const thinking = readThinking(result);
  if (thinking)
    catalog.thinking = thinking;
  return catalog;
}

/**
 * Config option ids `session/set_config_option` must be given.
 * These stay off the wire catalog. A missing id means this response has no
 * session setting for that dial, so the caller does not invent one.
 */
export function readSessionConfigIds(result: unknown): { modelConfigId?: string; thinkingConfigId?: string } {
  if (!isRecord(result))
    return {};
  const model = findConfigOption(result, (id, category) => id === 'model' || category === 'model');
  const thinking = findConfigOption(result, (id, category) => EFFORT_KEYS.has(id) || EFFORT_KEYS.has(category));
  const modelConfigId = text(model?.id);
  const thinkingConfigId = text(thinking?.id);
  return {
    ...(modelConfigId ? { modelConfigId } : {}),
    ...(thinkingConfigId ? { thinkingConfigId } : {}),
  };
}

/**
 * `cursor-agent --list-models` rows. Effort stays in the id
 * (`grok-4.7-high`, `grok-4.7-low`), so this catalog has no thinking list.
 * The row marked `(current` or `(default` becomes `currentModelId`.
 */
export function parseCursorModelList(output: string): CliModelCatalog | undefined {
  const models: CliModelChoice[] = [];
  let currentId: string | undefined;
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const splitAt = line.indexOf(' - ');
    if (splitAt <= 0)
      continue;
    const id = line.slice(0, splitAt).trim();
    if (!isCursorModelId(id) || seen.has(id))
      continue;
    seen.add(id);
    let label = line.slice(splitAt + 3).trim().replace(/\s+/g, ' ');
    const markedCurrent = /\((?:current|default)\b/i.test(label);
    const paren = label.indexOf('(');
    if (paren > 0)
      label = label.slice(0, paren).trim();
    if (label.length === 0)
      label = id;
    models.push({ id, label: clip(label, CLI_MODEL_LABEL_MAX) });
    if (markedCurrent && currentId === undefined)
      currentId = id;
  }
  if (models.length === 0)
    return undefined;
  const kept = capModels(models, currentId);
  const catalog: CliModelCatalog = { models: kept };
  if (currentId && kept.some(model => model.id === currentId))
    catalog.currentModelId = currentId;
  return catalog;
}

/** Model ids accepted on `cursor-agent --model`. Rejects anything that could be another flag. */
export function isCursorModelId(value: string): boolean {
  if (value.length === 0 || value.length > CLI_MODEL_ID_MAX)
    return false;
  return /^[a-z][\w./-]*$/i.test(value);
}

const CURSOR_EFFORT_SUFFIXES = ['extra-high', 'xhigh', 'minimal', 'medium', 'none', 'high', 'low', 'max'] as const;

const CURSOR_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max'];

const CURSOR_EFFORT_LABEL: Record<string, string> = {
  'extra-high': 'Extra High',
  'xhigh': 'Extra High',
  'minimal': 'Minimal',
  'medium': 'Medium',
  'none': 'None',
  'high': 'High',
  'low': 'Low',
  'max': 'Max',
};

const CURSOR_EFFORT_PARAMS = ['reasoning_effort', 'effort', 'reasoning'] as const;

/**
 * Groups sibling efforts onto `model.thinking`. An open Cursor session does
 * not publish this grouping. Its model list is the flat `--list-models` ids,
 * because effort and speed are already part of each id.
 */
export function annotateCursorSessionEfforts(catalog: CliModelCatalog, listed: readonly CliModelChoice[]): void {
  for (const model of catalog.models) {
    const parsed = parseCursorParameters(model.id);
    if (!parsed)
      continue;
    const current = parsed.effort;
    if (!current)
      continue;
    const efforts = effortsForCursorFamily(parsed.family, listed);
    if (!efforts.includes(current))
      efforts.push(current);
    efforts.sort((a, b) => {
      const ai = CURSOR_EFFORT_ORDER.indexOf(a);
      const bi = CURSOR_EFFORT_ORDER.indexOf(b);
      return (ai === -1 ? CURSOR_EFFORT_ORDER.length : ai) - (bi === -1 ? CURSOR_EFFORT_ORDER.length : bi);
    });
    if (efforts.length < 2)
      continue;
    model.thinking = {
      current,
      levels: efforts.map(effort => ({
        value: effort,
        label: CURSOR_EFFORT_LABEL[effort] ?? effort,
      })),
    };
  }
}

/** Family name inside a parameterized Cursor session id, before `[`. */
export function cursorModelFamily(id: string): string | undefined {
  const open = id.indexOf('[');
  if (open <= 0 || !id.endsWith(']'))
    return undefined;
  return id.slice(0, open);
}

/** Effort token inside a parameterized Cursor session id. */
export function cursorEffortOf(id: string): string | undefined {
  return parseCursorParameters(id)?.effort;
}

/**
 * `--model` value for `cursor-agent`. Session ids hide effort in brackets
 * (`grok-4.7[reasoning_effort=low,fast=true]`); the CLI flag wants `grok-4.7-low-fast`.
 */
export function cursorCliModelId(id: string): string {
  const open = id.indexOf('[');
  if (open <= 0 || !id.endsWith(']'))
    return id;
  const family = id.slice(0, open);
  const params = id.slice(open + 1, -1).split(',').filter(param => param.length > 0);
  let effort: string | undefined;
  let fast = false;
  for (const param of params) {
    if (param === 'fast=true')
      fast = true;
    for (const key of CURSOR_EFFORT_PARAMS) {
      const prefix = `${key}=`;
      if (param.startsWith(prefix))
        effort = param.slice(prefix.length);
    }
  }
  let listed = family;
  if (effort)
    listed += `-${effort}`;
  if (fast)
    listed += '-fast';
  return listed;
}

/**
 * List id (`grok-4.7-low`, `grok-4.7-high-fast`) that names this session model.
 * Returned only when that id is on the flat `cursor-agent --list-models` list.
 */
export function cursorListedId(sessionId: string, listed: readonly { id: string }[]): string | undefined {
  const listedId = cursorCliModelId(sessionId);
  return listed.some(model => model.id === listedId) ? listedId : undefined;
}

export interface CursorParameterDial {
  id: string;
  value?: string;
  values: string[];
}

/**
 * Parameterized Cursor session.
 * `session/set_config_option` takes the family name (`grok-4.7`) on the model
 * dial and effort / speed on their own dials. A bracket id is rejected.
 */
export interface CursorParameterState {
  modelNames: string[];
  modelId?: string;
  effort?: CursorParameterDial;
  fast?: CursorParameterDial;
}

export interface CursorListSelection {
  modelId: string;
  effort?: string;
  fast: boolean;
}

/** Model names and the current effort / speed dials from one ACP result. */
export function readCursorParameters(result: unknown): CursorParameterState | undefined {
  if (!isRecord(result))
    return undefined;
  const model = findConfigOption(result, (id, category) => id === 'model' || category === 'model');
  if (!model)
    return undefined;
  const modelNames = readOptionValues(model);
  if (modelNames.length === 0)
    return undefined;
  const modelId = firstText(model.currentValue, model.current_value);
  const effort = readDial(findConfigOption(result, (id, category) =>
    category === 'thought_level' || id === 'reasoning_effort' || id === 'effort' || id === 'reasoning'));
  const fast = readDial(findConfigOption(result, id => id === 'fast'));
  const state: CursorParameterState = { modelNames };
  if (modelId && modelNames.includes(modelId))
    state.modelId = modelId;
  if (effort)
    state.effort = effort;
  if (fast)
    state.fast = fast;
  return state;
}

/**
 * Flat `--list-models` id as a parameterized selection.
 * An id that is itself a model name (`claude-opus-5-high`) is that model.
 * `grok-4.7-low` is family `grok-4.7` plus effort `low`. `cursor-` is only a list prefix.
 */
export function resolveCursorListSelection(listedId: string, modelNames: readonly string[]): CursorListSelection | undefined {
  const names = new Set(modelNames);
  if (names.has(listedId))
    return { modelId: listedId, fast: false };
  if (listedId.endsWith('-fast')) {
    const stem = listedId.slice(0, -'-fast'.length);
    if (stem.length > 0 && names.has(stem))
      return { modelId: stem, fast: true };
  }
  for (const candidate of listedId.startsWith('cursor-') && listedId.length > 'cursor-'.length
    ? [listedId, listedId.slice('cursor-'.length)]
    : [listedId]) {
    const parsed = parseCursorListId(candidate);
    if (parsed.effort && names.has(parsed.base))
      return { modelId: parsed.base, effort: parsed.effort, fast: parsed.fast };
  }
  if (listedId === 'auto' && names.has('auto-smart'))
    return { modelId: 'auto-smart', fast: false };
  return undefined;
}

/**
 * List id for the live parameterized selection.
 * A bare id such as `gpt-5.3-codex` is the effort value that has no suffixed row.
 */
export function cursorListIdFromParameters(
  state: CursorParameterState,
  listed: readonly { id: string }[],
): string | undefined {
  if (!state.modelId)
    return undefined;
  const fast = state.fast?.value === 'true';
  const bareEffort = state.effort
    ? impliedCursorEffort(state.modelId, state.modelNames, listed, state.effort.values)
    : undefined;
  const matches: string[] = [];
  for (const model of listed) {
    const resolved = resolveCursorListSelection(model.id, state.modelNames);
    if (!resolved || resolved.modelId !== state.modelId || resolved.fast !== fast)
      continue;
    if (resolved.effort) {
      if (resolved.effort === state.effort?.value)
        matches.push(model.id);
      continue;
    }
    if (!state.effort || (bareEffort !== undefined && state.effort.value === bareEffort))
      matches.push(model.id);
  }
  return matches.find(id => resolveCursorListSelection(id, state.modelNames)?.effort) ?? matches[0];
}

/** Effort a bare list id means: the dial value that no sibling row spells out. */
export function impliedCursorEffort(
  modelId: string,
  modelNames: readonly string[],
  listed: readonly { id: string }[],
  optionValues: readonly string[],
): string | undefined {
  const explicit = new Set<string>();
  for (const model of listed) {
    const resolved = resolveCursorListSelection(model.id, modelNames);
    if (resolved?.modelId === modelId && resolved.effort)
      explicit.add(resolved.effort);
  }
  const missing = optionValues.filter(value => !explicit.has(value));
  return missing.length === 1 ? missing[0] : undefined;
}

/** Rewrite the effort parameter inside a Cursor session model id. */
export function rewriteCursorEffort(id: string, effort: string): string | undefined {
  if (!isCursorEffortToken(effort))
    return undefined;
  for (const key of CURSOR_EFFORT_PARAMS) {
    const pattern = new RegExp(`(^|[,[])${key}=([^,\\]]+)`);
    if (!pattern.test(id))
      continue;
    return id.replace(pattern, `$1${key}=${effort}`);
  }
  return undefined;
}

function parseCursorParameters(id: string): { family: string; effort?: string } | undefined {
  const open = id.indexOf('[');
  const close = id.endsWith(']') ? id.length - 1 : -1;
  if (open <= 0 || close <= open)
    return undefined;
  const family = id.slice(0, open);
  const params = id.slice(open + 1, close).split(',');
  for (const key of CURSOR_EFFORT_PARAMS) {
    const prefix = `${key}=`;
    const found = params.find(param => param.startsWith(prefix));
    if (found)
      return { family, effort: found.slice(prefix.length) };
  }
  return { family };
}

function effortsForCursorFamily(family: string, listed: readonly CliModelChoice[]): string[] {
  const bases = new Set([family, `cursor-${family}`]);
  const efforts: string[] = [];
  const seen = new Set<string>();
  for (const model of listed) {
    const split = splitListedCursorId(model.id);
    if (!split.effort || !bases.has(split.base) || seen.has(split.effort))
      continue;
    seen.add(split.effort);
    efforts.push(split.effort);
  }
  return efforts;
}

function splitListedCursorId(id: string): { base: string; effort?: string } {
  const parsed = parseCursorListId(id);
  return parsed.effort ? { base: parsed.base, effort: parsed.effort } : { base: parsed.base };
}

function parseCursorListId(id: string): { base: string; effort?: string; fast: boolean } {
  let rest = id;
  let fast = false;
  if (rest.endsWith('-fast') && rest.length > '-fast'.length) {
    fast = true;
    rest = rest.slice(0, -'-fast'.length);
  }
  for (const effort of CURSOR_EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (rest.endsWith(suffix) && rest.length > suffix.length)
      return { base: rest.slice(0, -suffix.length), effort, fast };
  }
  return { base: rest, fast };
}

function readOptionValues(option: Record<string, unknown>): string[] {
  if (!Array.isArray(option.options))
    return [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (const entry of option.options) {
    if (!isRecord(entry))
      continue;
    const value = bounded(text(entry.value), CLI_MODEL_ID_MAX);
    if (!value || seen.has(value))
      continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function readDial(option: Record<string, unknown> | undefined): CursorParameterDial | undefined {
  if (!option)
    return undefined;
  const id = text(option.id);
  const values = readOptionValues(option);
  if (!id || values.length === 0)
    return undefined;
  const current = firstText(option.currentValue, option.current_value);
  return {
    id,
    values,
    ...(current && values.includes(current) ? { value: current } : {}),
  };
}

function isCursorEffortToken(value: string): boolean {
  return /^[a-z][\w.-]{0,31}$/i.test(value);
}

export function currentModelLabel(catalog: CliModelCatalog | undefined): string | undefined {
  if (!catalog?.currentModelId)
    return undefined;
  return catalog.models.find(model => model.id === catalog.currentModelId)?.label;
}

function readModelBlock(models: unknown): { models: CliModelChoice[]; currentId?: string } {
  if (Array.isArray(models))
    return { models: readModelEntries(models) };
  if (!isRecord(models))
    return { models: [] };
  const available = Array.isArray(models.availableModels)
    ? models.availableModels
    : (Array.isArray(models.available_models) ? models.available_models : []);
  const currentId = firstText(models.currentModelId, models.current_model_id);
  return { models: readModelEntries(available), currentId };
}

function readConfigModels(result: Record<string, unknown>): { models: CliModelChoice[]; currentId?: string } {
  const option = findConfigOption(result, (id, category) => id === 'model' || category === 'model');
  if (!option)
    return { models: [] };
  return {
    // Standard ACP select options may be grouped by provider (DSH uses this
    // shape). Only leaf values are model ids; group names are display labels.
    models: readModelEntries(Array.isArray(option.options)
      ? option.options.flatMap(entry => isRecord(entry) && Array.isArray(entry.options) ? entry.options : [entry])
      : [], 'value'),
    currentId: firstText(option.currentValue, option.current_value),
  };
}

function readThinking(result: Record<string, unknown>): CliModelCatalog['thinking'] | undefined {
  const option = findConfigOption(result, (id, category) => EFFORT_KEYS.has(id) || EFFORT_KEYS.has(category));
  if (!option || !Array.isArray(option.options))
    return undefined;
  const current = firstText(option.currentValue, option.current_value);
  const levels = capLevels(readThinkingLevels(option.options), current);
  if (levels.length === 0)
    return undefined;
  const thinking: NonNullable<CliModelCatalog['thinking']> = { levels };
  if (current && levels.some(level => level.value === current))
    thinking.current = current;
  return thinking;
}

function findConfigOption(
  result: Record<string, unknown>,
  match: (id: string, category: string) => boolean,
): Record<string, unknown> | undefined {
  const options = Array.isArray(result.configOptions)
    ? result.configOptions
    : (Array.isArray(result.config_options) ? result.config_options : []);
  for (const option of options) {
    if (!isRecord(option))
      continue;
    const id = text(option.id).toLowerCase();
    const category = text(option.category).toLowerCase();
    if (match(id, category))
      return option;
  }
  return undefined;
}

function readModelEntries(entries: unknown, idKey = 'id'): CliModelChoice[] {
  if (!Array.isArray(entries))
    return [];
  const models: CliModelChoice[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry))
      continue;
    const id = bounded(firstText(entry.modelId, entry.model_id, entry[idKey], entry.id), CLI_MODEL_ID_MAX);
    if (!id || seen.has(id))
      continue;
    seen.add(id);
    const label = clip(firstText(entry.name, entry.label) || id, CLI_MODEL_LABEL_MAX);
    const thinking = readModelEffort(entry._meta);
    models.push(thinking ? { id, label, thinking } : { id, label });
  }
  return models;
}

function readModelEffort(meta: unknown): CliModelChoice['thinking'] | undefined {
  if (!isRecord(meta))
    return undefined;
  const raw = Array.isArray(meta.effortOptions)
    ? meta.effortOptions
    : (Array.isArray(meta.effort_options) ? meta.effort_options : undefined);
  if (!raw)
    return undefined;
  const levels = capLevels(readThinkingLevels(raw), undefined);
  if (levels.length === 0)
    return undefined;
  return { levels };
}

function readThinkingLevels(entries: unknown[]): CliThinkingLevel[] {
  const levels: CliThinkingLevel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry))
      continue;
    const value = bounded(text(entry.value), CLI_THINKING_VALUE_MAX);
    if (!value || seen.has(value))
      continue;
    seen.add(value);
    levels.push({
      value,
      label: clip(firstText(entry.name, entry.label) || value, CLI_MODEL_LABEL_MAX),
    });
  }
  return levels;
}

function capModels(models: CliModelChoice[], currentId: string | undefined): CliModelChoice[] {
  if (models.length <= CLI_MODEL_LIMIT)
    return models;
  const kept = models.slice(0, CLI_MODEL_LIMIT);
  if (!currentId || kept.some(model => model.id === currentId))
    return kept;
  const current = models.find(model => model.id === currentId);
  if (!current)
    return kept;
  kept[kept.length - 1] = current;
  return kept;
}

function capLevels(levels: CliThinkingLevel[], current: string | undefined): CliThinkingLevel[] {
  if (levels.length <= CLI_THINKING_LEVEL_LIMIT)
    return levels;
  const kept = levels.slice(0, CLI_THINKING_LEVEL_LIMIT);
  if (!current || kept.some(level => level.value === current))
    return kept;
  const chosen = levels.find(level => level.value === current);
  if (!chosen)
    return kept;
  kept[kept.length - 1] = chosen;
  return kept;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const trimmed = text(value);
    if (trimmed.length > 0)
      return trimmed;
  }
  return '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function bounded(value: string, max: number): string {
  if (value.length === 0 || value.length > max)
    return '';
  return value;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
