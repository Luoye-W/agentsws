---
description: Everything Agents Workshop sends is logged automatically in the Sent log panel and can be exported as CSV. Say one line to also write it into your own online sheet.
---
# Sent log, and writing it into your own sheet

Everything Agents Workshop sends for you — posts, comments, replies, emails, messages — is logged automatically: where it went, what it said, who approved it, and when. When someone replies to us later, the reply is attached to that row.

## Where to find it

The **Sent log** panel in the right rail (paper-plane icon). Filter by channel, or click **Export** to save a CSV that opens directly in Excel.

What we sent is always kept. If the other person deletes their message, we clear our copy of it too and keep only a "deleted by them" note.

## Writing the log into your sheet

You can have Agents Workshop also write each item into your own online sheet (for example a Feishu Base or Sheet; Google Sheets and DingTalk will work the same way later). Just say it in any position, for example:

> From now on, log every Reddit reply to this sheet https://… — columns are Date / Subreddit / Post link / Our reply / Status, and write the date as 2026/10/14.

Then:

1. Agents Workshop reads the sheet's header and works out what goes in each column;
2. A **Log sheet** card shows up in your card flow with a one-row preview. Nothing happens until you click **Save**;
3. From then on, every item sent adds one row. The same item is never written twice.

Log whatever you ask for: which columns, what goes in each, how dates look, which channels — all your call.

- **To change it**: say so ("write dates like 10-14", "only Reddit") and you'll get a new card to confirm. Until then the old setup keeps working.
- **To pause or delete it**: use the block at the top of the Sent log panel. After deleting, nothing more is written; rows already in the sheet stay.

If the sheet side needs something from you (such as granting access or sharing the sheet with the app), Agents Workshop tells you exactly what to do during setup.

## When a row can't be written

- **Network hiccup or the service is busy**: it retries automatically a bit later.
- **No permission, sheet deleted, or columns changed**: it stops, the panel says why, and those items wait locally as "to retry". Fix it and click **Retry**. If the columns changed, Agents Workshop re-matches them and sends you a new card to confirm.

Every value written to your sheet comes straight from the log — the AI never rewrites it.
