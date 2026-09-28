# Sending domain and health check for cold email

Why we recommend a separate sending domain for cold email, how to set one up, and what the pre-send health check looks at.

## Why a separate domain

When recipients mark cold email as spam, **the whole domain's reputation drops**. If you send from your main domain (say `brand.com`), your support replies, order emails and quotes can end up in spam too.

The first time you start a sequence, a card asks you to choose:

- **A separate sending domain**: if your site is `brand.com`, send from `brandmail.com` or `trybrand.com`. Recommended.
- **Your current mailbox**: this works too; the card keeps reminding you of the risk.

You decide. Nothing is set up without asking you.

## Buying and setting it up

1. Buy a domain close to your brand at your usual registrar (`brand + mail`, `try + brand`, `get + brand`).
2. Add it to your email provider (business mail, Google Workspace, Microsoft 365…) and create a sending mailbox such as `sales@trybrand.com`.
3. Add three DNS records as your provider instructs:
   - **SPF**: one TXT record starting with `v=spf1` (only one);
   - **DKIM**: the record your provider gives you ("custom domain DKIM");
   - **DMARC**: the `_dmarc` TXT record; `v=DMARC1; p=none` is fine to start.
4. Connect the mailbox on the Connections page (IMAP / SMTP), then pick it on the card under Outbound.

You buy the domain and edit DNS at your registrar; we only give the steps.

## What the health check looks at

- **SPF** and **DMARC** in DNS;
- a **test email sent from the mailbox to itself**; when it arrives we read its headers to see whether **DKIM** is signed with your own domain.

**No email goes out until SPF and DKIM pass.** A missing DMARC record is only a warning.

If the test email hasn't come back after 10 minutes (Gmail often keeps mail you send to yourself out of the inbox), we look up the DKIM key in DNS under the usual selectors (`google`, `selector1`, `selector2`, `k1` and a few more). If one is there, DKIM counts as "set up in DNS (not verified by a real email)" and sending is allowed, with a note on the card. If none is there, nothing is sent. When the test email does arrive later, its headers win.

## Daily limits

Each sending mailbox has its own count: up to 20 a day for the first two weeks, then up to 50. Anything over the limit waits until tomorrow.

If the mailbox has been sending normally for a long time (not a newly bought domain), tick "This mailbox has been sending normally for a long time" under Outbound to go straight to 50 a day. **Leave it off for a new domain**: sending the full amount on day one hurts its reputation most.

## After a "not interested" reply

Only this round stops. The person cools off: by default they aren't picked for any new round for 90 days, and after that they can be picked again. A second "not interested" doubles it to 180 days. People cooling off show up as one line under Outbound, with the dates in the tooltip.

An **unsubscribe** reply or a hard bounce is what puts someone on the suppression list for good.

Your company's postal address lives in Settings → Company profile: cold-email footers, quotes and shipping documents all use that one.

## FAQ

- **DKIM stays at "waiting for the test email"**: some providers don't deliver mail you send to yourself into your inbox. After 10 minutes we check DNS instead; if there's no DKIM record there either, turn DKIM on at your provider.
- **DKIM is signed by another domain**: your provider is using its default signature. Turn on custom-domain DKIM and add the record it gives you.
- **Two SPF records**: two count as none. Merge them into one.
