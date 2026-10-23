<!--
  Privacy Policy (English) · WP197 draft, written from scratch by Fable at Luoye's request (09-29); no template or third-party policy was copied.
  Recommend a lawyer review before launch — especially cross-border transfer (PIPL chapter 3), minors, and the list of processors.
  The Chinese version is the reference text.
  WP477 (10-23, decisions 1609 / 1611): website analytics via Google Analytics (Consent Mode, no cookies before consent); the app's anonymous
  usage data via PostHog (US) and four milestones to GA4; feedback screenshots and diagnostics kept 180 days (WP475). Only these facts changed.
-->
# Privacy Policy

This policy explains what Agents Workshop collects, where it's stored, who processes it, how long we keep it, and how you control it. The operator is **{{OPERATOR_LEGAL_NAME}}** ("we").

In one sentence: **your business data stays on your own computer by default.** Data only passes through or is stored in our cloud when you sign in, top up, use credits to call a model or data API, or turn on a cloud feature or long-running task — and only the part that's needed.

## 1. Data that stays on your computer by default

The Agents Workshop open-source software runs on your computer. Your customers, orders, emails, playbooks, knowledge base, role memories, approval records, and the passwords and keys you enter for your store, mailbox and social accounts are kept only on your computer by default (passwords and keys live in an encrypted local vault; the AI model never sees them and they never reach a log).

We **can't reach** this data and don't collect it.

Separately, the software sends a small amount of **anonymous usage data** so we can see which features get used and where things break (see the last two rows of section 2). It contains no business content, and you can turn it off at any time in the software under Settings → Data & privacy → Help improve Agents Workshop.

When you use your own model or platform keys, those requests go straight from your computer to that provider without passing through us. The provider's own privacy policy applies to that data.

## 2. Data that reaches our cloud

Data only reaches us in these situations:

| Situation | Data processed | Why |
|---|---|---|
| Sign-up and sign-in | Name and email address; password (stored only as a one-way hash we cannot read); when you agreed to the Terms and which version; sign-in times; IP address and browser details kept to prevent abuse | Identify your account, send verification codes, keep the account secure |
| Organisation and members | Organisation name, member emails, roles, the credit limits you set | Let a team share one balance and manage limits per person and role |
| Credits and top-ups | Balance, the source and expiry of each credit batch, top-up order IDs, amounts, payment status | Bookkeeping, crediting, reconciliation, refunds and chargebacks |
| Calling models and data APIs with credits | The content and result of that request, usage, charges | Forward the request to the provider, bring the result back, bill it |
| Cloud features you turn on (e.g. creator-list cloud sync, cloud support standby) | The business data that feature needs to sync or process | Keep the feature running while your computer is off |
| Long-running tasks you run in the cloud | The data and context that task needs | Finish the task in the cloud and hand back the result and its record |
| When you contact us | What you send us and your contact details | Reply and solve the problem |
| Feedback you send from the software | What you write, any screenshot you choose to attach, and diagnostics (app version, operating system, recent error log) | Investigate the problem and reply to you |
| The software's anonymous usage data (while "Help improve Agents Workshop" is on) | Which kind of page you opened (the page type only, not its content), which button you clicked (a fixed button ID), whether a task succeeded, which cost tier it fell in, whether a card was approved or rejected, error types, app version, operating system, interface language, IDs of built-in positions and duties; a randomly generated anonymous device ID; your account ID (not your email) if you're signed in. It **never** includes emails, drafts, customer or product names, anything you type, or text shown on screen | Understand how features are used, find and fix problems |
| A few milestones from the software (same switch) | Four events — first open, first-time setup finished, first successful task, first open of each day — with the app version and the anonymous device ID; users with a Chinese interface are marked as users in China | Connect website visits with "download → actually using it" |

We **do not** train models on your business content, **do not** sell your personal information, and don't use it for advertising.

**Card details**: payment happens on the payment provider's checkout page. We never receive or store your card number.

## 3. Third-party processors

To run the cloud services we share the necessary data with the following kinds of providers. Each receives only what it needs for its job and is contractually required to protect it.

| Category | Purpose | Data it receives |
|---|---|---|
| Cloud infrastructure (Cloudflare) | Hosting this site and the cloud services, network acceleration and protection, storage | All data passing through the cloud services (encrypted in transit and at rest) |
| Model providers (e.g. DeepSeek and other LLM providers) | AI chat, drafting, image generation you run with credits | The content of that request |
| Data API providers (creator data, social data, search, web fetching, transcription, etc.) | Data lookups you run with credits | The parameters of that lookup (e.g. keywords, URLs, handles) |
| Payment providers (Waffo and others) | Payments, refunds, chargebacks | Order ID, amount, currency, payment status; payment details you enter on their page are handled by them |
| Email delivery providers | Sending verification codes, sign-in emails and service notices | Your email address and the email content |
| Product analytics (PostHog, United States) | Processing the software's anonymous usage data | The anonymous usage data described in section 2 (IP addresses are not stored) |
| Website and milestone analytics (Google Analytics, Google LLC, United States) | Website visit statistics; the software's four milestones | Website: the pages you visit, where you came from, device and browser details, plus Google's analytics cookies if you agree; software: the four milestones and the anonymous device ID (your IP address is not passed to Google) |

You can see which model or data provider will be used before a call runs, and you can switch any capability back to your own key at any time — then those requests no longer go through us.

## 4. Cookies and local storage

- **This website, {{SITE_URL}}, uses Google Analytics to count visits**; there is no advertising or cross-site tracking. On your first visit a small bar at the bottom asks you to "Allow" or "Decline":
  - Until you click "Allow" (including after "Decline"), **no cookies are stored** and Google Analytics only receives anonymous, cookieless counts;
  - After "Allow", Google Analytics stores two analytics cookies (`_ga` and one starting with `_ga_`, kept for up to 2 years) to recognise return visits; all advertising features stay off;
  - Your choice is stored in your browser (localStorage). To change it, click "[Analytics settings](/privacy/#consent)" in the footer; switching to "Decline" also clears those two cookies.
  - When you switch between light and dark themes, your browser also stores that one preference locally (localStorage); it is never sent to us.
- **The account pages (cloud.agentsws.com)** use only two cookies, both strictly necessary, never for analytics or advertising:
  - `__Host-agentsws_account`: keeps you signed in. Readable only by the server (httpOnly), sent only over HTTPS (Secure), SameSite=Lax; it expires after 3 days of inactivity and after 30 days at most. We store only a hash of it, and signing out invalidates it.
  - `agentsws_account_csrf`: stops other websites from submitting actions with your signed-in session.
  - The operations back office uses a separate cookie that has nothing to do with your account pages.

## 5. Cross-border transfer

Our cloud services run on Cloudflare's global network, and some model or data providers you choose may be located outside mainland China. Using the cloud services may therefore involve transferring data abroad for processing. Where the law requires it, we will obtain your separate consent and put the necessary safeguards in place. The cloud services do not offer a separate "keep data in China" option. If you don't want data to pass through our cloud, use only your own keys and run everything locally — data then goes straight to the model or data provider you picked, and whether it leaves China depends on that provider.

## 6. How long we keep data

- Account information: for as long as the account exists; deleted or anonymised after closure, except where the law requires us to keep it.
- Credit and transaction records: for the period required by financial and tax law.
- Requests made with credits: our own usage records contain only the capability, quantity, credits charged, model name, token counts and a request ID — **never the request content**. The content passes through our model gateway to the relevant AI provider, whose terms apply to it.
- Data for cloud features and long-running tasks: kept while the feature is on or the task is running; deleted when you turn the feature off or delete the task. It is not deleted while a service is paused for an unpaid balance.
- Feedback you send: the feedback itself is kept with your account; attached screenshots and diagnostics are kept for **180 days** and then deleted.

## 7. Your rights

You can:

- **access and correct** your account information;
- **export** your data held in the cloud;
- **delete** data for cloud features and tasks, or **close your account**;
- **withdraw consent**: turn off cloud features or switch capabilities back to your own keys, and later requests no longer go through us (processing already completed is unaffected);
- **object or complain** about how we process your data.

To exercise these rights, email {{CONTACT_EMAIL}}. We'll act promptly after verifying your identity, and generally reply within 15 working days.

## 8. Security

Data is encrypted in transit and stored encrypted in the cloud; access is granted on a least-privilege basis and logged. Still, no system is perfectly secure. If a personal-data security incident occurs, we will notify you and the authorities as the law requires.

## 9. Minors

Agents Workshop is built for businesses and merchants and is not intended for anyone under 18. If you believe a minor has given us personal information without a guardian's consent, contact us and we'll delete it.

## 10. Updates to this policy

When this policy changes we'll update it here with an effective date; for significant changes we'll notify you in advance in the app or by email.

## 11. Contact us

- Operator: {{OPERATOR_LEGAL_NAME}}
- Email: {{CONTACT_EMAIL}}
- If the Chinese and English versions differ, the Chinese version prevails.
