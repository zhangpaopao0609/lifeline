# Lifeline naming notes

**English** | [简体中文](./zh-CN/naming-brief.md)

> This document records the rename: why the product exists, what had to change, the naming bar, candidates, the final pick, and the trade-offs after it landed.
>
> Before 2026-09-16 it was a brief for another agent that opened with “please help me name this product”. After the name became Lifeline, the earlier sections and quoted original wording were kept; only structure and headings were cleaned up.

---

## 1. Background: what this product is

### In one sentence

A tool that **remote-controls Cursor / CodeBuddy on your machine** (those are the local IDEs; the AI session stays in them). A personal project.

### How it runs

- **On the machine**: a CLI (formerly `agent-remote`, now `lifeline`) installs a daemon, talks to the local IDE over CDP (Cursor on `9222`, CodeBuddy on `9223`), reads sessions, runs commands.
- **Remote**: a server with a socket.io relay and static pages. The on-machine agent **dials out**; the machine does not need a public inbound port.
- **Me**: I open the web page on my phone and I am on that local IDE.

### What I can do on the web

- Watch the session live: my messages, the agent's replies, tool calls, plan cards
- **Approve / reject** the agent's actions, run / skip commands
- Send a new prompt
- Switch chat tabs, mode, and model
- Switch among machines (home vs office)
- Browser notifications when something needs approval

### Two design points I care about

- **The session is continuous**: what the page shows comes from the session files on local disk (live projection), not a new cloud session. The same session continues from desktop to phone.
- **One machine can run two IDEs side by side**: Cursor and CodeBuddy each get a slot.

### Before the rename: where the name started (before 2026-09-16)

- The web brand said `AGENT·REMOTE`, with the line: 「把你的 CodeBuddy / Cursor 装进口袋」 (“put your CodeBuddy / Cursor in your pocket”)
- The repo, command, and config directory were still `agent-remote`

What had to change was the **product-name layer** (the name on the page, the CLI, the config directory). Protocol identifiers underneath stay.

---

## 2. Why I built it

### What I most wanted to say

> 我真的不想守在电脑旁，真的太浪费人的生命了。我完全可以出去，对不对？工作也一样能做。等我回来后，整个过程我还在现场，更能体现是我的样子。就好像生命延长。
>
> *(I really do not want to sit by the computer — it wastes a life. I can go out, right? Work still gets done. When I come back I am still in the scene, more myself. As if life were extended.)*

- Sitting and waiting for it, waiting for approvals, wastes life
- I can leave; work still happens
- When I return I am still in the scene: I can see the whole process, and things still go my way
- That feeling is life extended

### How I develop

> 我个人的习惯是用 IDE 开发。
>
> *(Personally I develop in an IDE.)*

I do not like moving development into a browser. My code, my environment, the things I verify, live in this local IDE.

### The pain

> 但现在 AI 开发可能会等很久，可能需要你审批之类的，你就必须一直守在电脑前面，不能走，对不对？
>
> *(But AI work can wait a long time, and it may need your approval, so you have to sit in front of the computer and cannot leave, right?)*

The AI agent waits, and it needs approval. Without approval it sticks — so I am pinned to the desk.

### Why not pure remote development

> 但如果完全用纯远程开发，又不是我的习惯。我看不到代码，也看不到整个过程，没办法直接验，改完了也没办法直接验，对吧？我觉得不是很习惯。
>
> *(Pure remote development is not my habit. I cannot see the code, or the whole process, or verify directly after a change. I am not used to that.)*

Pure remote (cloud IDE, browser-based coding) solves “not at the desk”, but it drops the reality of the local machine: you cannot see the code, you cannot see the process, you cannot verify in place.

### So why this helps

> 这是我个人的习惯。但你又不能一直坐在电脑前，所以有这个东西就太好了。
>
> *(That is my habit. You also cannot sit at the computer forever, so this is exactly what I needed.)*

It does not move my development somewhere else. It only lets me walk away from the desk.

### How I understand the product

> 其实我们的产品本质上就是控制你的 IDE，对吧？能够远程操控你的 IDE。而且这样做的好处在于，会话是连续的，不会断，对吧？
>
> *(The product is essentially controlling your IDE — remote-controlling the real local IDE. The win is that the session is continuous; it does not break.)*

- **Essence**: control my IDE — remote-control the real one on this machine.
- **Win**: the session continues; it does not break.

---

## 3. The naming bar: two things that both have to be true

> 把 cursor 和 codebuddy 装进口袋。
>
> *(Put cursor and codebuddy in your pocket.)*

> 我人走了，但会话还可以继续，并且整个现场就跟我坐在电脑上一样。我回来了，完全保持现场。
>
> *(I leave, but the session continues, and the whole scene is as if I were still at the computer. When I return, the scene is intact.)*

Both have to hold:

1. **In your pocket**: both IDEs (Cursor / CodeBuddy) come with you; you do not move development somewhere else.
2. **The scene does not break**: the session continues while you are away, identical to sitting at the desk; when you return, nothing has shifted.

One line: **what you take with you is “me”, not “the scene”.**

---

## 4. Candidates (mine, before it was decided)

1. **lifeline** — I wanted it to mean extending my life. Still those two sentences in section 3. **← the pick**
2. **PocketScene**
3. **outside**
4. **Continuum** — life Continuum, spacetime Continuum

---

## 5. The pick: Lifeline / 生命线 (2026-09-16)

> “Please help me name this product” ends here — the name is set.

| Item | Final |
|---|---|
| Product name | Lifeline |
| Chinese name | 生命线 |
| CLI | `lifeline` |
| Config directory | `~/.lifeline` |
| Web brand | `Lifeline` |
| Tagline | 把你的 CodeBuddy / Cursor 装进口袋 |
| Core claim | 线不断，人就自由。 |
| Main slogan | 把守在电脑前的时间，还给你。 |
| Secondary slogan | 人走，线不断；回来，现场还在。 |
| Another line | 带走的是你，不是现场。 |
| Notification | `Lifeline · 需要你批准` |
| Multi-machine | `Lifeline · Home` / `Lifeline · Office` |

### Why the name does not have to say “extend life”

Lifeline is already 「生命线」. It does not say “extend”, but it says the more basic thing:

- The line holds, so the person is free.
- You dare to leave because the line is still there.
- You can leave because the session does not break.
- You come back still in the scene because that line stayed connected.

The waiting, the approvals, the hours at the desk — that is the life you get back. So “extend life” is not literal extra years. It is: **return the time that waiting and approval ate.**

### Three layers

Do not ask one name to say both jobs. Each layer owns one:

| Layer | Owns |
|---|---|
| Name | the line holds |
| Claim / slogan | life extended, more freedom |
| Tagline | in your pocket |

---

## 6. Trade-offs after the pick

1. **English Lifeline is dirty; Chinese 「生命线」 is clean.** In English, Lifeline is occupied by emergency / “save a life” (US Lifeline subsidy, emergency call devices). Chinese 「生命线」 defaults closer to “lifeline of the work, something you cannot do without”, with less rescue flavor. So the Chinese name leads, and English is the identifier. Cost: in an English-speaking context that occupancy will show up.
2. **「生命线」 is a common word; exclusivity is mediocre.** Said aloud, “that 生命线” might first mean a monitoring / ops tool. Fine for a personal project.
3. **Protocol identifiers do not move.** `AGENT_TOKEN` and the rest were out of scope for the rename (see section 1, “before the rename”).
