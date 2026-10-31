export const COMMAND_EVENTS = [
  'command:send_message',
  'command:approve',
  'command:approve_all',
  'command:reject',
  'command:stop',
  'command:switch_tab',
  'command:new_chat',
  'command:set_mode',
  'command:set_model',
  'command:get_model_options',
  'command:get_plan_full',
  'command:get_plan_model_options',
  'command:set_plan_model',
  'command:click_action',
  'command:switch_window',
] as const;

export type CommandEvent = (typeof COMMAND_EVENTS)[number];

/** CLI manager registers these. They must stay out of COMMAND_EVENTS. */
export const CLI_COMMAND_EVENTS = [
  'command:cli_start',
  'command:cli_catalog',
  'command:cli_model',
  'command:cli_thinking',
  'command:cli_close',
  'command:cli_permission_response',
] as const;

export type CliCommandEvent = (typeof CLI_COMMAND_EVENTS)[number];

/** Relay registers this union. The IDE command router keeps using COMMAND_EVENTS. */
export const ALL_COMMAND_EVENTS = [...COMMAND_EVENTS, ...CLI_COMMAND_EVENTS] as const;

export type AllCommandEvent = (typeof ALL_COMMAND_EVENTS)[number];
