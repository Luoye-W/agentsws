---
description: WeChat is a private line to your own assistant; WeCom, Feishu and DingTalk bots serve your team. Decisions are always made in the workstation, never in the chat app.
---
# Message channels: WeChat, WeCom, Feishu and DingTalk

WeChat lives in Settings → Notifications → WeChat reminders, the team bots in Settings → Chat channels — and they are two different things: **WeChat is a private chat between you and your own assistant**; **the WeCom bot is the one for the team**.

| Channel | Who uses it | What it does |
|---|---|---|
| WeChat (yours) | Only you | Ask your own assistant in WeChat: what needs deciding today, where is this at, check my calendar |
| WeCom bot (the company’s) | The team | Colleagues @ it in a group; it asks each person’s own assistant as that person |

One rule for both: **decisions are not made in the chat app**. Cards arrive as “summary + handle it in the workstation” links, with no approve / reject buttons — decisions and credentials never go through the chat app.

## WeChat (yours)

Scan once, then ask your own assistant right in WeChat: what needs deciding today, where is this at, check my calendar. The answers are the same ones you see in the workstation.

**What it does not do**

- Colleagues cannot add this account — it only knows you and ignores messages from anyone else.
- It cannot join groups and never replies to customers. It is not a support channel.
- For things you must decide, WeChat only gets a summary and a link; approving happens in the workstation.

> WeChat’s terms (6.1 / 6.4): using it for customer service, broadcasts or public replies can get your main WeChat account banned — your own account. So this channel only does one thing: you asking your own assistant.

The login credentials stay on this machine — never sent to the AI, never logged.

**Connect**

1. On the WeChat card in Settings → Notifications, click **Link WeChat**.
2. Scan the code on screen with WeChat on your phone.
3. If your phone shows a number, type it into “Digits shown on your phone”.
4. Once it says connected, send it a message in WeChat to try.

**Unlink**: “Unlink” destroys the WeChat login stored on this machine — it does not just pause receiving. If the WeChat login expires, the card says so; click **Scan again**.

## WeCom bot (the company’s)

The team channel: @ it in a group and it asks the asker’s own assistant as that person, so everyone only sees answers up to what they are allowed to see.

**Connect**

1. Open the WeCom admin console, go to “Smart bots”, and create a bot (or open an existing one).
2. Copy its **BotID** and **Secret**. The Secret is shown only once — copy it right away.
3. Back in Settings → Chat channels, fill in both and click **Save and connect**.
4. When the card says it is receiving, add the bot to a group and @ it to try.

The Secret goes straight into the local encrypted vault — never sent to the AI, never logged, never shown again.

When an answer takes a while it first says "Got it, checking." and then replaces that line with the answer. "Disconnected, reconnecting" means the connection dropped and it is reconnecting; "connected somewhere else" means the same bot is connected on another computer — re-save the credentials on the side you want to keep.

## Feishu / DingTalk bots (company)

Like WeCom, these are for your team: colleagues DM the bot or @ it in a group and it answers as the asker. Both use an outbound long connection (DingTalk calls it Stream mode), so no public URL is needed. Everyone clicks **Link my account** once and DMs the code to the bot — it only answers colleagues it knows. WeCom now uses the same linking step.

Setup guides: [Feishu](help:im-feishu), [DingTalk](help:im-dingtalk).

## Who answers (WeCom / Feishu / DingTalk)

- **Questions about a position's work** (name the position, e.g. "Anything Reddit Ops needs from me today?"): that position's AI answers in one line — cards waiting for you, to-dos, what it's working on — with a "Handle it in the workbench" link. Work questions that don't name a position go to your main position.
- **Handing over a job** ("reply to this email for me"): it's logged as a task in that position and you get "Logged as a task — confirm it in the workbench". Nothing is sent from the chat.
- **Small talk, your schedule, colleagues**: still answered by your personal assistant.
- **Links open in their own brand**: if the workbench is on another brand, the link switches over first; if you can't open that brand, you stay put and are told why.

## FAQ

- **Can I answer customers from WeChat?** No. This channel only knows you; using it for support breaks WeChat’s terms and risks your main account. Website visitors go through the website chat (see [chat window](help:chat-window)).
- **A colleague wants to ask from WeChat?** Use the WeCom bot, or they scan their own code to connect their own WeChat.
- **The card says “reconnect”**: the WeChat login expired; click “Scan again”.
