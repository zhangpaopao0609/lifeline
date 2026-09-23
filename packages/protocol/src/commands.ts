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
