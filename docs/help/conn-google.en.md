# The Google connections

What each of the six Google connections does and how to set it up. The first ones use your own Google Cloud project; Google Alerts at the end needs no approval at all.

| Connection | In one line | Review / cost |
|---|---|---|
| Gmail (Google sign-in) | Read and send Gmail through your own Google OAuth app | A "restricted scope": access through a third-party server needs a yearly CASA security assessment; an "Internal" consent screen avoids it |
| Google Analytics 4 | Your site's analytics | Not restricted, no security assessment |
| Google Search Console | How your site does in Google Search | Same project as GA4, one more API to enable |
| YouTube Data API | Search channels by keyword, read subscribers and topics | Just an API key; 10,000 units a day for the whole site |
| Google Ads API | Ad performance, budgets and bids, pausing | The developer token needs review |
| Google Alerts (brand monitoring) | Brand mentions in news, blogs and reviews | Free, no application, no key |

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

The GA4 tile on the role panel lights up. Active users and event data arrive in the next version.

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

The Search Console tile on the role panel lights up. Query and landing-page data arrive in the next version.

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

**You need all three**: an OAuth token, a developer token and a customer ID. Reads go through GAQL and writes need an updateMask — we handle all that; you just fill the three fields correctly.

**How**

1. Create a project in Google Cloud, enable the Google Ads API, and complete OAuth authorization.
2. In Google Ads → Tools → API Center, apply for a developer token (Basic access is enough), **then wait for review**.
3. Copy the ten-digit customer ID in the top-right corner of Google Ads, without the dashes.
4. Enter all three in the form. They stay on this computer only.

**Links**

- [Google Ads API quick start](https://developers.google.com/google-ads/api/docs/start)
- [API Center (apply for a developer token)](https://ads.google.com)

**What it covers today**

The Merchant Center product feed also belongs to the ads job, but that side isn't connected yet — this card only handles ads for now.

## Google Alerts (brand monitoring)

Free, no application, no key: create an alert in Google Alerts, switch delivery to RSS, and paste the feed address here. It's the **only** news-monitoring source that needs no application, costs nothing and breaks nobody's terms.

It covers news, blogs and reviews. Reddit discussions are covered by the Reddit card's site-wide search — see [Community bots](help:conn-community).

**How**

1. Open [Google Alerts](https://www.google.com/alerts) and sign in with your Google account.
2. Create an alert with your brand name as the keyword. One in Chinese and one in English is safer.
3. Click the pencil next to the alert → set "Deliver to" to **RSS feed**.
4. Copy the feed address and enter it in the form. It stays on this computer only.

**Links**

- [Google Alerts](https://www.google.com/alerts)

**Good to know**

Google Alerts lags (a few hours to a day) and misses things — it isn't whole-web monitoring. When the feed can't be fetched, the panel says so plainly ("this feed wasn't fetched") and **never shows "0 mentions today"**: brand monitoring has to keep those two apart.

## FAQ

- **Can these share one Google project?** Yes. GA4 can share a project with Gmail, and Search Console reuses GA4's OAuth client ID.
- **GA4 / Search Console is connected, so where are the numbers?** In this version connecting only lights up the tile; the actual data comes in the next version.
- **Why can't I search YouTube creators freely?** The whole site gets 10,000 units a day and each search costs 100. Reading a single channel costs 1.
- **No alerts today — does that mean nobody mentioned us?** Not necessarily. Alerts lag and miss things; if the feed didn't come through, the panel says so rather than showing 0.
