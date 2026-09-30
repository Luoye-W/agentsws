# DingTalk bot: create the app, turn on Stream, get credentials

The DingTalk bot is **for your team**: a colleague DMs the bot or @-mentions it in a group, and it asks **that person's own agent**, as that person — so everyone only sees what they are allowed to see.

It uses DingTalk's "Stream mode": your computer connects out to DingTalk, so there is **no public URL and no callback address to configure**. As long as Agents Workshop is running on this computer, the bot can receive and reply.

## 1. Create an app in the DingTalk developer console

1. Open the [DingTalk developer console](https://open-dev.dingtalk.com), sign in as an admin, go to **App development** → **Internal apps** → **Create app**, and give it a name and icon.
2. In the app, **Add capability** → add **Robot**, then open the robot settings:
   - fill in the robot's name, description and avatar;
   - **set the message receiving mode to "Stream mode"** (not HTTP);
   - save.
3. **Credentials & Basic Info** → copy the **Client ID** and **Client Secret** (older consoles call them AppKey / AppSecret).
4. **Version management & release** → release. Colleagues can only find the bot after it's released.

## 2. Enter them in Agents Workshop

5. On the Messaging channels page, in the **DingTalk bot** card, enter the Client ID and Client Secret and click **Save and connect**.
6. When the card says "Receiving", you're good.

The Client Secret goes straight into the encrypted store on this machine — never sent to the AI, never logged, never shown again.

## 3. Everyone links their own account once

The bot **only answers colleagues it knows**. The first time:

7. In the DingTalk card, click **Link my account** — you get a 6-digit code.
8. In DingTalk, **DM** the bot: `bind 123456` (your code). Valid for 10 minutes, single use.
9. Once it replies that you're linked, ask it in a DM or @ it in a group; in groups it @-mentions the asker in its reply.

To add it to a group: group settings → **Robots** → add robot → pick your internal-app robot.

## What it won't do

- **Decisions don't happen in DingTalk**: cards arrive as a summary plus a link back to the workstation — no approve/reject buttons.
- **It won't answer strangers**: an account that hasn't linked gets one line telling it to link first.
- In groups it only reacts when **@-mentioned**.

## FAQ

- **"Client ID or Client Secret is wrong, or Stream mode isn't on"**: check Credentials & Basic Info, make sure the robot uses Stream mode, then click **Re-enter credentials**.
- **"Cannot reach DingTalk for now"**: usually the network; it retries by itself.
- **It won't reply to a very old message**: DingTalk's reply address for each message expires. Just ask again.
- **Does it reply when my computer is off?** No. The Stream connection lives on this computer — while it sleeps, is offline, or Agents Workshop is closed, the bot hears nothing.
