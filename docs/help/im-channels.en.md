# Message channels: WeChat and WeCom

This covers the two channels on the “Message channels” page. They are two different things: **WeChat is a private chat between you and your own agent**; **the WeCom bot is the one for the team**.

| Channel | Who uses it | What it does |
|---|---|---|
| WeChat (yours) | Only you | Ask your own agent in WeChat: what needs deciding today, where is this at, check my calendar |
| WeCom bot (the company’s) | The team | Colleagues @ it in a group; it asks each person’s own agent as that person |

One rule for both: **decisions are not made in the chat app**. Cards arrive as “summary + handle it in the workstation” links, with no approve / reject buttons — decisions and credentials never go through the chat app.

## WeChat (yours)

Scan once, then ask your own agent right in WeChat: what needs deciding today, where is this at, check my calendar. The answers are the same ones you see in the workstation.

**What it does not do**

- Colleagues cannot add this account — it only knows you and ignores messages from anyone else.
- It cannot join groups and never replies to customers. It is not a support channel.
- For things you must decide, WeChat only gets a summary and a link; approving happens in the workstation.

> WeChat’s terms (6.1 / 6.4): using it for customer service, broadcasts or public replies can get your main WeChat account banned — your own account. So this channel only does one thing: you asking your own agent.

The login credentials stay on this machine — never sent to the AI, never logged.

**Connect**

1. On the WeChat card of the “Message channels” page, click **Link WeChat**.
2. Scan the code on screen with WeChat on your phone.
3. If your phone shows a number, type it into “Digits shown on your phone”.
4. Once it says connected, send it a message in WeChat to try.

**Unlink**: “Unlink” destroys the WeChat login stored on this machine — it does not just pause receiving. If the WeChat login expires, the card says so; click **Scan again**.

## WeCom bot (the company’s)

The team channel: @ it in a group and it asks the asker’s own agent as that person, so everyone only sees answers up to what they are allowed to see.

**Connect**

1. Open the WeCom admin console, go to “Smart bots”, and create a bot (or open an existing one).
2. Copy its **BotID** and **Secret**. The Secret is shown only once — copy it right away.
3. Back on the “Message channels” page, fill in both and click **Save and connect**.
4. When the card says it is receiving, add the bot to a group and @ it to try.

The Secret goes straight into the local encrypted vault — never sent to the AI, never logged, never shown again.

## FAQ

- **Can I answer customers from WeChat?** No. This channel only knows you; using it for support breaks WeChat’s terms and risks your main account. Website visitors go through the website chat (see [chat window](help:chat-window)).
- **A colleague wants to ask from WeChat?** Use the WeCom bot, or they scan their own code to connect their own WeChat.
- **The card says “reconnect”**: the WeChat login expired; click “Scan again”.
