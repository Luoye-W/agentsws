---
description: Gmail, GA4, Search Console and Google Ads authorize through your own Google Cloud project; YouTube needs just an API key; Google Alerts is free, delivered via RSS.
---
# The Google connections

Google has six connections: Gmail, GA4, Search Console and Google Ads authorize through your own Google Cloud project, YouTube needs only an API key, and Google Alerts at the end is free with nothing to apply for.

| Connection | In one line | Review / cost |
|---|---|---|
| Gmail (Google sign-in) | Read and send Gmail through your own Google OAuth app | A "restricted scope": access through a third-party server needs a yearly CASA security assessment; an "Internal" consent screen avoids it |
| Google Analytics 4 | Your site's analytics | Not restricted, no security assessment |
| Google Search Console | How your site does in Google Search | Same project as GA4, one more API to enable |
| YouTube Data API | Search channels by keyword, read subscribers and topics | Just an API key; 10,000 units a day for the whole site |
| Google Ads API | Ad performance, budgets and bids, pausing | Real accounts need an access level on your Cloud project |
| Google Alerts (information monitoring) | Mentions of you, competitors and your industry in news, blogs and forums | Free, no application, no key |

Only need to read and send email? Skip Gmail and see [Connect a mailbox](help:conn-email) — one app password does it.

## Gmail (Google sign-in)

You create your own OAuth app in Google Cloud. If all you need is to read and send email, look at [Connect a mailbox](help:conn-email) (the "any mailbox" route) first.

**How**

1. Open Google Cloud Console and create a new project.
2. Under "APIs & Services", enable the Gmail API.
3. Set up the OAuth consent screen with user type "Internal". Internal use within your organization avoids the third-party security assessment.
4. On the [Google Cloud credentials page](https://console.cloud.google.com/apis/credentials), create an "OAuth client ID" of type "Web application", with the redirect URL set to your local OpenConnector address.
5. Put the client ID and secret into OpenConnector, then come back and click "Authorize".

**Links**

- [Google OAuth clients (credentials page)](https://console.cloud.google.com/apis/credentials)
- [Google restricted scopes and CASA assessment](https://support.google.com/cloud/answer/9110914)

**Why all the steps**

Reading and sending Gmail is a Google "restricted scope": access through a third-party server requires a CASA security assessment every year. That's why this version runs on your own OAuth app. For plain support email, the "any mailbox" route is much easier.

## Google Analytics 4

Authorize once with your own Google OAuth app. GA4 analytics data isn't a restricted scope, so no security assessment.

**How**

1. In Google Cloud Console, enable the Google Analytics Data API.
2. Create an OAuth client ID (it can share a project with Gmail).
3. Put the client ID and secret into OpenConnector.
4. Come back, click "Authorize", and pick the GA4 property you want on Google's page.

**Links**

- [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1)

**Once connected**

Pick the property on the panel (if there is only one, it is picked for you). From then on it reads once a day: active users, conversion rate, events, and the two GA4 columns in the revenue-by-page table.

## Google Search Console

Same Google project as GA4 — just enable one more API.

**How**

1. In Google Cloud Console, enable the Search Console API.
2. Reuse the OAuth client ID from GA4.
3. Put the client ID and secret into OpenConnector.
4. Come back, click "Authorize", and pick a site whose ownership you've already verified.

**Links**

- [Search Console API](https://developers.google.com/webmaster-tools)

**Once connected**

Pick the site on the "SEO & GEO" panel (a domain property or a URL prefix both work; if there is only one, it is picked for you). From then on it reads every morning: "Daily 5 things", queries and landing pages are all real numbers.

## YouTube Data API

Searches channels by keyword and reads a channel's subscriber count and topics.

**The quota is 10,000 units a day for the whole site**, not per workspace. One search costs 100 units; reading one channel costs 1. So searching for creators isn't a button to click freely.

**How**

1. Open Google Cloud console and create (or pick) a project.
2. Under "APIs & Services → Library", enable YouTube Data API v3.
3. On the [Google Cloud credentials page](https://console.cloud.google.com/apis/credentials), click "Create credentials → API key" and copy it.
4. (Recommended) Restrict the key to YouTube Data API v3 only.
5. Enter the key in the form. It stays on this computer only.

**Links**

- [Google Cloud credentials page](https://console.cloud.google.com/apis/credentials)
- [YouTube Data API quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)

**Without it**

The creator job still works: you find people by importing your own list and from the public creator library, and outreach, deals, review and attribution are all still there. The same key also serves the social media job's YouTube duty (reading and posting on your own channel) — connect once, both light up.

## Google Ads API

Covers Search, Shopping, PMax and YouTube ads: read performance, change budgets and bids, pause.

**You need two things**: an OAuth token and a customer ID. Reads go through GAQL and writes need an updateMask — we handle all that; you just fill the two fields correctly.

You used to need a developer token from the API Center in Google Ads. **Not any more**: Google has retired developer tokens, and which accounts you can touch now depends on the access level of **the Google Cloud project that issued your OAuth credentials**. A freshly enabled project can only touch test accounts; to work on your real ad accounts, apply for a higher level in the same project.

**How**

1. Create a project in the Google Cloud console and enable the Google Ads API.
2. On the Google Ads API page of that project, apply for a higher access level (needed for real accounts).
3. Complete OAuth with that project to get an access token.
4. Copy the ten-digit customer ID in the top-right corner of Google Ads, without the dashes.
5. Enter both in the form. They stay on this computer only.

If you get a 403 after connecting, the project's access level is usually not high enough yet — check step 2.

**Links**

- [Google Ads API quick start](https://developers.google.com/google-ads/api/docs/start)
- [Access levels (Google)](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)

**What it covers today**

The Merchant Center product feed also belongs to the ads job, but that side isn't connected yet — this card only handles ads for now.

## Google Alerts (information monitoring)

Information monitoring watches news, blogs and forums about your brand, your competitors and your industry, mostly through Google Alerts: one alert per thing you watch, delivered to **RSS**, with the RSS link pasted back to me. Free, no application, no key, and you can have many.

You don't have to come up with the list yourself: say "watch my competitors" and I'll draft one from your brand profile and competitors (each with its search query and a reason). Confirm it, then create the alerts.

**How to create one**

1. Open [Google Alerts](https://www.google.com/alerts) and sign in with your Google account.
2. Type the query from the list, for example `"Aventon" -job`.
3. Click "Show options" and set:
   - How often: **As-it-happens**
   - Sources: Automatic
   - Language and region: as on the list
   - How many: **All results** (the default "Only the best results" misses a lot)
   - Deliver to: **RSS feed** (not your email)

   > Screenshot slot: the expanded options, with "All results" and "RSS feed" selected.

4. Click "Create alert". In your alert list, right-click the RSS icon next to it and copy the link.

   > Screenshot slot: the RSS icon in the alert list.

5. Paste the link back into the card in the chat (each row has its own box, or paste a batch at once). I fetch it right away; it only counts once it comes through.

**If you paste the wrong thing**

If the link doesn't start with `https://www.google.com/alerts/feeds/` and isn't a readable RSS feed, I'll tell you on the spot that the alert is still delivered by email — switch "Deliver to" to RSS in Google Alerts and copy it again.

**Website feeds work too**

Many blogs, forums and store blogs have their own RSS. Paste it in; it carries everything new on that site, so I filter locally for your brand and competitor names and only keep matches.

**Links**

- [Google Alerts](https://www.google.com/alerts)

**Good to know**

- By default each feed is pulled once a day (after 9 am local time); anything missed while the computer was off is pulled once when it's back. Tell me if you want a different schedule.
- A Google Alerts feed only keeps the latest ~20 items. If a pull brings 20 items that are all new, I switch that feed to every 4 hours and mention it in the brief.
- Alerts lag (hours to a day) and miss things. When a feed can't be fetched it gets a red dot on the Connections card and the panel says it wasn't fetched — it **never shows 0**.

## FAQ

- **Can these share one Google project?** Yes. GA4 can share a project with Gmail, and Search Console reuses GA4's OAuth client ID.
- **GA4 / Search Console is connected, so where are the numbers?** First check the panel for the small "pick one" card — reading starts once you pick the site or property. Search Console numbers lag two to three days; we read the latest full 7 days.
- **Why can't I search YouTube creators freely?** The whole site gets 10,000 units a day and each search costs 100. Reading a single channel costs 1.
- **No alerts today — does that mean nobody mentioned us?** Not necessarily. Alerts lag and miss things; if the feed didn't come through, the panel says so rather than showing 0.
