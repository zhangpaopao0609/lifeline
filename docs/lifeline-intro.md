# Lifeline: put Cursor / CodeBuddy in your pocket

**English** | [简体中文](./zh-CN/lifeline-intro.md)

> Product features only — no internals. For explaining what Lifeline is and what it does.

## The problem

If you write code with an AI agent in Cursor or CodeBuddy, you have probably lived this:

You send a task. The agent starts working. You stare at the screen — waiting for it to finish, to ask a question, to need a command approved. Without that approval it sits frozen. So you cannot leave: lunch is anxious, meetings mean peeking at your phone, and you check one more time before you go home.

Lifeline is that line, plugged into your phone.

It does not move your development into a browser, and it does not start a separate cloud session. Your code, your IDE, your environment stay on that computer. Lifeline only lets you **walk away** — the session keeps running, it can find you when it needs you, and you still decide.

One line: **give back the time you spend sitting in front of the machine.**

## What it does

### The session does not break: one session, from desktop to phone

What you see on the web is a live projection of the session on local disk — not a new cloud chat, not a copy with no provenance. Progress you watch away from the desk is the same scene you open on the computer when you return.

Open the page and the current session's messages, answers, code, and todos are in front of you:

- Your messages and the agent's replies in time order; code blocks have language tags and copy
- Tool calls group and collapse; expand when you need the detail
- Plan cards show todo progress (3/5 and so on)
- A live status dot: running or idle

### You stay in charge: decisions without sitting at the desk

When the agent stops to wait, that is when it needs you most; when it is grinding forward, you can still interrupt. Lifeline puts both on the web and on your phone:

- **Approve / reject**: shell, file edits, MCP, mode switches — anything that needs a nod pops a card; approve or skip
- **Accept all**: one command to clear a batch of the same kind
- **Questionnaires**: the agent's follow-ups and multiple choice, answered on the phone
- **New prompts**: the input sits under the session, same as typing at the desk; send has three states (delivered / confirmed / failed-retryable) — no silent drop
- **Stop anytime**: it went sideways, or you just want it to stop writing — the stop control next to the input is the same action as the IDE's stop key. A session running in the background can be stopped without switching to it on the computer first

One detail: approval cards often have more than one option (Run / Always Run / Skip). The page draws every button; the one you tap is the one that runs.

### In your pocket: phones in portrait work

The console is a mobile browser. No app:

- One top-bar control switches machine, IDE, window, and session, and opens on the session you were already looking at
- Todo cards stick above the input, stacked and counted; swipe to switch
- Approvals fire a browser notification: `Lifeline · 需要你批准`

### Many computers, one list

Home machine, office machine — after both enroll, the page is a machine list:

- Online vs offline at a glance; switching machines switches the scene
- **Offline machines stay readable**: last mirror, read-only — no blank screen, no auto-jump to another machine
- You can remove an offline machine from the list; its own data is untouched, and the daemon brings it back on the next connect
- Each machine belongs to the person who enrolled it: after login you only see and control yours

### One slot for Cursor, one for CodeBuddy

On the same computer, Cursor and CodeBuddy each get a slot, shown and controlled separately:

- Separate windows, sessions, modes, and models
- Separate approve, send, and stop — no crosstalk
- A disconnected slot is not mistaken for the other

### Small things around the console

- **⌘K command palette** (desktop): fuzzy jump to any machine, IDE, window, session, mode, or model
- **New session**: every window group header has “＋”; the new session belongs to the window, not globally
- **Window order**: drag to reorder; remembered per machine and IDE, so clicking a session does not reshuffle the list
- **Enroll is two commands**: install, then setup, then one browser login on the controlled machine — no runtime to preinstall

## Who it is for

- People who develop in a local IDE and do not want the workflow moved to a browser or the cloud
- People who let AI run long tasks and do not want to sit and wait
- People with more than one machine (office / home / a spare)
- People who live in CodeBuddy or Cursor — or both

## What it feels like

You send a large task before you leave, close the lid (or leave it open). On the subway a notification: “需要你批准”. You open the page, see the agent stuck on a command, read the context, tap approve, put the phone away.

You get home, open the computer — the session is where you left it. The code you still need to write, the result you still need to check, are in the same IDE, unchanged.

**You leave; the line holds. You return; the scene is still there.**
