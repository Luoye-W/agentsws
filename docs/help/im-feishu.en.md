# Feishu bot: create the app, turn on long connection, get credentials

The Feishu bot is **for your team**: a colleague DMs the bot or @-mentions it in a group, and it asks **that person's own agent**, as that person — so everyone only sees what they are allowed to see.

It uses Feishu's "long connection": your computer connects out to Feishu, so there is **no public URL and no callback address to configure**. As long as Agents Workshop is running on this computer, the bot can receive and reply.

## 1. Create an app on the Feishu Open Platform

1. Open the [Feishu Open Platform](https://open.feishu.cn/app), sign in as an admin, and click **Create custom app**. Give it a name and icon (that's what colleagues see). Lark (international) users go to open.larksuite.com — same steps.
2. In the app, **Add features** → add **Bot**.
3. **Permissions** → search for and enable:
   - Read direct messages sent to the bot (`im:message.p2p_msg:readonly`)
   - Receive group messages that @-mention the bot (`im:message.group_at_msg:readonly`)
   - Send messages as the app (`im:message:send_as_bot`)
4. **Credentials & Basic Info** → copy the **App ID** (starts with `cli_`) and the **App Secret**.

## 2. Enter them in Agents Workshop

Only **the owner or a company admin** can do this; everyone else only sees the status on the card.

5. On the Messaging channels page, in the **Feishu bot** card, enter the App ID and App Secret (tick "Lark (international)" if that's you) and click **Save and connect**.
6. When the card says "Connecting" or "Receiving", you're good.

The App Secret goes straight into the encrypted store on this machine — never sent to the AI, never logged, never shown again.

## 3. Back on the Open Platform: long connection and release

7. **Events & Callbacks** → **Event configuration** → set the subscription mode to **Receive events through persistent connection** and save. Feishu checks that a connection is already up when you save — that's why step 5 comes first.
8. On the same page, **Add event** → **Receive message** (`im.message.receive_v1`).
9. **Version management & release** → create a version → request release. Once your admin approves, colleagues can find the bot in Feishu.

## 4. Everyone links their own account once

The bot **only answers colleagues it knows**. The first time:

10. In the Feishu card, click **Link my account** — you get a 6-digit code.
11. In Feishu, **DM** the bot: `bind 123456` (your code). Valid for 10 minutes, single use.
12. Once it replies that you're linked, ask it in a DM or @ it in a group.

To add it to a group: group settings → **Bots** → add bot → pick your app.

## What it won't do

- **Decisions don't happen in Feishu**: cards arrive as a summary plus a link back to the workstation — no approve/reject buttons.
- **It won't answer strangers**: an account that hasn't linked gets one line telling it to link first.
- In groups it only reacts when **@-mentioned**; @all doesn't count.

## FAQ

- **"App ID or App Secret is wrong"**: copy them again from Credentials & Basic Info and click **Re-enter credentials**.
- **"Feishu refused the long connection"**: check that the Bot feature is added, the subscription mode is persistent connection, and the app is released.
- **"Too many connections"**: the same app is connected from another computer. Close that one first.
- **Does it reply when my computer is off?** No. The connection lives on this computer — while it sleeps, is offline, or Agents Workshop is closed, the bot hears nothing.
