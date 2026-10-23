---
description: Allow your site and paste the embed code before </body>. Free hosting covers 200 conversations a month; a 30-credit monthly add-on answers while you're offline.
---
# Website live chat (the chat window)

Installing the website chat window takes three steps: set its look, list your site under Allowed websites, and paste the embed code before `</body>` on every page. Free official hosting (200 conversations a month) is the default, and you can “teach the AI” right inside visitor conversations.

Where: **visitor conversations** are under Messages → “Website chat” (next to your mailboxes); the **widget settings** (look, embed code, relay) are in Settings → Chat channels → “Website chat widget” (⌘, opens Settings).

## Which relay option

Visitor messages travel through a “relay” to whatever handles them. The relay only forwards: it stores no conversation text and runs no AI. All three options use the same widget and the same embed code; switching only changes who is on the other end.

| Option | For whom | Limit | Cost |
|---|---|---|---|
| Official hosting | Most people | 200 conversations a month, with a reminder at 80% | Free |
| Self-hosted relay | You want control, or no cap | None | Your own server |
| Support add-on | Your computer is often off | None | **30 credits / month**, replies’ model usage billed in credits |

With the first two, the support agent on **this computer** handles visitors (the computer must be on). With the add-on, the cloud keeps a copy of your support agent running; visitor messages go to it first and both sides sync when your computer is back.

## Install it on your site

1. Under Messaging channels → “Website chat widget”, set the **look**: accent colour and greeting.
2. Under **Allowed websites**, enter your site’s address, comma-separated for several, e.g. `https://shop.example.com`. **Empty means nothing is allowed** (safe by default).
3. Copy the **embed code** and paste it before `</body>` on every page of your site.
4. Open your site: the chat window appears at the bottom right. “Live preview” shows it first.

## Official hosting (free)

Nothing to fill in — it is the default. 200 conversations a month with a reminder at 80%; unlimited with the support add-on.

## Self-hosted relay

For people who deployed the relay themselves (Docker or their own Cloudflare Worker).

1. Deploy the relay (the repository’s `deploy/chat-relay/README.md` has step-by-step notes for non-ops people).
2. Under “Self-hosted relay”, enter the **relay address** and the **pairing key** (shown only once at deployment).
3. To receive visitors’ offline messages, also enter the **message key** (optional); a saved key is not shown again — re-enter to change it.
4. Click **Save**, then **Test connection**.

With the support add-on you do not need this: the cloud takes over automatically and syncs when your computer is back.

## Support add-on: the cloud minds the chat

1. First link an Agents Workshop account in “Settings → Account and credits” (see [credits](help:agentsws-credits)).
2. Back here, click **Subscribe (30 credits / month)**. The status goes from starting to minding the chat.
3. After changing support settings or knowledge locally, click **Update the cloud with this computer**; to bring the cloud copy back, click **Bring the cloud copy home**.

When credits run short there is a grace period (the cloud keeps minding the chat and resumes once you top up); after it ends, the service stops, and re-subscribing within 30 days picks up where you left off. Cancelling lasts until the end of the current period.

## Visitor conversations and “teach”

- **Handoff wait time**: for questions the AI cannot settle, the visitor waits at most this long (30 seconds to 10 minutes), then it moves to an email follow-up. Changes only affect new requests.
- **Teach**: open a conversation under Messages → Website chat; under it, write how it should be answered and press **Teach**. The visitor never sees your line; the AI rewrites it in the visitor’s language and answers in its own voice, and at the end it can be kept as knowledge.

## FAQ

- **Installed the embed code but nothing shows?** Check “Allowed websites” — an empty allow-list blocks everything.
- **How are the 200 counted?** By conversation, not by message.
- **What happens when my computer is off?** With official hosting or a self-hosted relay, visitor messages wait for your computer; for always-on coverage, turn on the support add-on.
