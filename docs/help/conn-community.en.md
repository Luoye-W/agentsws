# Community bots: Reddit / Discord / Telegram

The three connections for community work: a Reddit subreddit, a Discord server and a Telegram group. Their rules differ a lot, so start with the table.

| Connection | In one line | What you need |
|---|---|---|
| Reddit API | Read the mod list, post a pinned post, search discussions site-wide | A registered Reddit app; a correct User-Agent; at most 60 calls a minute |
| Discord bot | Read messages and members, post announcements, delete messages, time out members | A Bot, invited into your server |
| Telegram bot | Read group messages, post announcements, delete messages, mute and ban | A bot from @BotFather, made admin of your group |

One thing they share: **without a connection you can still sort rules, draft posts and queue approvals** — only the actual sending needs it.

## Reddit API

First register a script or web app on Reddit, then exchange the client id + secret for a token.

- **The User-Agent must be in the format Reddit accepts** — get it wrong and every call returns 429.
- On this channel a "broadcast" means one **pinned post**. Private-messaging every subscriber is explicitly banned: it gets reported as spam and the account gets banned.
- At most 60 calls a minute. Past that we queue on our side instead of waiting for Reddit's 429.

**How**

1. Go to [https://www.reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) and create an app (script or web app).
2. Copy the client id and secret, and go through OAuth to get an access token.
3. Write the User-Agent as `platform:app id:version (by /u/your username)`.
4. Enter the token, User-Agent and subreddit name in the form. They stay on this computer only.

**Links**

- [Reddit app settings](https://www.reddit.com/prefs/apps)
- [Reddit API docs](https://www.reddit.com/dev/api)

**Good to know**

A subreddit **has no member roster and no join approval** (following is one-way). So "pending join requests" is always empty on this channel — not because it isn't connected, but because the thing doesn't exist on Reddit. What you can read is the mod list: who's in charge.

## Discord bot

Reads channel messages and members, posts announcements, deletes messages, times members out.

- **A timeout is an expiry time**, lifted automatically when it's reached, 28 days at most; it isn't an on/off switch.
- Bans always need a human click.
- An announcement must name the channel it goes to — there's no "broadcast to the whole server" option.

**How**

1. In the [Discord developer portal](https://discord.com/developers/applications), create an application, add a Bot on the Bot page, and copy its token.
2. Under OAuth2 → URL Generator, tick bot plus the permissions you need: read messages, send messages, manage messages, time out members.
3. Use the generated link to invite the Bot into your server.
4. Turn on Discord's Developer Mode, right-click the server, and copy its ID.
5. Enter the token and server ID in the form. They stay on this computer only.

**Links**

- [Discord developer portal](https://discord.com/developers/applications)
- [Bot docs](https://discord.com/developers/docs/intro)

**Without it**

You can still sort rules, draft announcements and queue approvals — only the actual sending needs it. If the Bot lacks admin permissions, deleting and timeouts fail; we show you the platform's own message rather than a generic "something went wrong".

## Telegram bot

Reads group messages, posts announcements, deletes messages, mutes and bans.

- **Errors come back inside a 200**: when something fails the status is still 200 and the body is `{"ok": false, ...}`. So "sent" is judged by the `ok` field, not the status code — we check that for you.
- The bot must be a group admin, or it can't delete messages or mute anyone.

**How**

1. In Telegram, find [BotFather](https://t.me/botfather) (@BotFather), send `/newbot`, and follow the prompts to name it.
2. Copy the token it gives you.
3. Add the bot to your group and make it an admin. This step is required for deleting messages and muting.
4. Get the group ID: send a message after adding the bot to the group, or use @userinfobot.
5. Enter the token and group ID in the form. They stay on this computer only.

**Links**

- [BotFather](https://t.me/botfather)
- [Bot API docs](https://core.telegram.org/bots/api)

**Without it**

You can still sort group rules, draft announcements and queue approvals — only the actual sending needs it.

## FAQ

- **Reddit keeps returning 429**: check that the User-Agent follows `platform:app id:version (by /u/your username)`; a wrong one always gets 429.
- **Can I DM all Reddit subscribers?** No — Reddit bans it and the account gets banned. On this channel a broadcast is a pinned post.
- **Discord / Telegram can't delete messages or mute people**: the bot needs admin permissions. On Discord you'll see the platform's own error message.
- **Can I see Reddit discussions about my brand?** The Reddit card has site-wide search, which complements Google Alerts — see [The Google connections](help:conn-google).
