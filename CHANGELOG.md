# Changelog

**English** | [简体中文](./CHANGELOG.zh-CN.md)

## [0.3.0] - 2026-11-03

### Features

- Send files from the web console to the IDE. The composer has a paperclip button, chips show each file's name and size, and a message can be files only.
- A message bubble shows those files as chips. An absolute path is shown as the file name, including on a phone.
- Files are written on the machine and handed to the IDE. If the handoff fails, the message falls back to the file path as text.

### Bug Fixes

- A file that is too large, or too many files, shows a toast instead of being dropped silently.
- When saving an attachment fails, the error names the step and the path.

## [0.2.4] - 2026-11-03

### Bug Fixes

- Starting a session from another window no longer drops the placeholder row a moment later. Whether it stays depends only on the target window's tab.

## [0.2.3] - 2026-11-03

### Features

- Tapping + to start a session shows a placeholder row immediately, and it stays until a new tab appears after that tap.

## [0.2.2] - 2026-10-31

### Bug Fixes

- After you send a message, the extra bubble is removed once the real message is on disk.

## [0.2.1] - 2026-10-31

### Bug Fixes

- On a newer Cursor, opening a session no longer shows an empty transcript. The message list is read from the chunked headers Cursor writes for that chat.

## [0.2.0] - 2026-10-30

### Features

- Command-line sessions are part of the stable release.

## [0.1.91] - 2026-10-30

### Features

- A command-line session can be resumed and closed, and the timeline follows the turn happening in the terminal.
- The model and thinking level you pick on the web are remembered on the machine, and copying to the terminal or resuming uses that same choice.
- A CodeBuddy turn already finished in the terminal is appended to the timeline. Closing a session removes it from the list at once, and the green dot stays on only while a session is open.
- The machine's model list is remembered, so reopening the page does not wait for it again. Cursor is selected by the model in that list, including effort and speed. A session that does not match the terminal no longer offers copy.

### Bug Fixes

- The dropdowns in the new-session dialog share one menu.

## [0.1.90] - 2026-10-28

### Features

- Start a command-line session from the console, from its own entry and a new-session dialog that takes a working directory.
- Approve or reject command-line actions from the console.
- See the models and thinking level available to the current account.
- Command-line replies show thinking, and messages that share an id fold into one.

### Bug Fixes

- A missing full transcript is retried once, and an older full copy is not written back over the message.
- A failed prompt no longer marks a command-line session that is still running as crashed.
- Setup saves the CodeBuddy command-line credential. A bad credential is reported separately from the command-line tool being missing.

## [0.1.89] - 2026-10-21

### Features

- On the desktop sidebar, the workspace group that holds the current session expands on its own.

### Bug Fixes

- A CodeBuddy compaction turn's prompt envelope is no longer drawn as a human message.
