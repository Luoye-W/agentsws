---
description: A read-only weekly check — can AI crawlers get in, do prices and stock show without JavaScript, does product info match everywhere, are you ready for ChatGPT shopping.
---
# Site health: can AI read your store?

Shoppers increasingly ask AI "which one, how much, can I return it". Whether the AI gets it right starts with three things: **can it get into your site, can it read the key facts, and do your listings agree with each other**. Site health runs every Monday morning, or click the refresh icon ("Run check now") at the top right of a report block.

The check only reads: it opens your site's public pages and reads your store admin. **It never changes anything.**

## First run

1. Fill in your website address under Settings → Company profile (that's the site we check).
2. Authorize your store on the Website operations or Website building position page (without it the crawler check still runs; product data is skipped).
3. Open the position's "Reports" and click the refresh icon on any site health block; it takes a minute or two.

## Reading the four report blocks

**Can AI crawlers get in** (Website building and Website operations)
Checks whether `robots.txt` blocks each AI's crawler. Three kinds:
- **AI search** (e.g. OAI-SearchBot, Claude-SearchBot, PerplexityBot): if blocked, that AI can hardly cite you;
- **Opened for a user** (e.g. ChatGPT-User, Claude-User): when someone asks an AI about you, it opens your page on the spot — blocked means it can't;
- **Training** (e.g. GPTBot, Google-Extended, CCBot): only listed when blocked. Blocking them is your call, not a mistake.

"Partly blocked" means e.g. the home page is open but product pages aren't. The triangle in "Why" shows which robots.txt line blocks it.

**Visible without JavaScript?**
Most AI crawlers don't run page scripts. We fetch each product page twice — once without scripts, once after they run — and look for the price, stock status, a selling point and the return window from your store admin.
- **JS only**: appears only after scripts run — most AI won't see it; ask your theme developer to put it in the page itself;
- **Missing**: not found either way.

If there's no Chrome / Edge on this computer, only the no-script copy is checked, and the footer says so.

**Does product info match** (Website operations)
Your store admin is the source of truth. We compare it with the product page text, the structured data (the part of the page written for machines), your product feed, and any marketplace listings you added in settings. Every mismatch in price, currency, stock, number of variants or return window is one row; expired prices and listings with no date are listed too (dated facts are more likely to be trusted by AI).

When something doesn't match, the check opens a task for Website operations with the list. They verify it and propose fixes as change cards (nothing changes until you approve). The same list isn't handed over again within 7 days.

**Ready for ChatGPT shopping?**
Checks your product data field by field against OpenAI's public product feed spec: required fields such as title, description, link, brand, image, availability and price, plus the privacy policy and terms needed for checkout. **Assessment only — we don't connect you.**

## Visits and sales from AI (SEO & GEO)

The SEO & GEO duty page gets one more block: sales and revenue from ChatGPT, Perplexity, Gemini, Copilot, Claude and others in the last 7 days, marked **measured** — Shopify's own record of where shoppers came from, not an estimate. The weekly AI answer tracking report shows the same line next to "did AI mention you".

- Each order counts once: the AI of the last visit before buying, otherwise the first visit;
- **Visits** need the "Reports" permission in your store authorization; without it only sales are counted, and the footer says so.

## Technical audit, redesign regressions, competing pages (SEO & GEO)

The **technical audit** runs in the same pass. "SEO & GEO" and the site-building positions each get a "Technical audit" block that lists only problems:

- **Indexing**: pages Search Console reports as not indexed, redirecting, or with a different Google-selected canonical (needs Search Console connected);
- **Canonical**: missing, more than one, pointing to another page, or pointing to a broken URL;
- **Redirects and dead links**: links on the home page that return 404, redirect chains, temporary redirects;
- **Sitemap**: missing, unreadable, listing broken or noindex URLs, or missing live pages;
- **hreflang** (when you sell in several markets): wrong language/region codes (GB, not UK), no self-reference, missing return tags, or not matching the canonical;
- **Structured data**: Product / Offer / breadcrumb checked against Google's current rich-result requirements; articles only get recommendations;
- **Page speed**: real-user data (Chrome UX Report) first; lab numbers otherwise, marked "lab".

Fixes are **handed to site building as a task**: redirects, sitemap and dead links go to "Full site build"; template tags and speed go to "Theme". Redirect chains come as "old path → new path" lines ready for a redirect card. The same list is not handed over again within 7 days.

**Redesign regressions**: after a theme is published or an app is installed/removed (plus a weekly fallback), we capture the home page, two products, one collection and one article and compare title, description, canonical, noindex, H1, structured data and status with last time:
- **Critical** (e.g. noindex added, product structured data gone, page broken): an alert card on the home page naming the change, plus a task for site building;
- **Warning / FYI**: one line in the daily "5 things worth doing" brief and the "Redesign regressions" block.

**Competing pages**: once a week we look in Search Console for queries where two of our pages compete. Critical ones join the daily "5 things" (at most two a day), keeping the page with more clicks; the other page is either merged and redirected (handed to site building) or rewritten for a different angle with a link to the kept page (a change card). The rest are listed in the "Two pages competing for the same queries" block.

**Decay triage**: a "declining" item now says which kind it is — refresh the content, the queries shifted (rewrite title and intro), merge, or retire (hand to site building for a redirect) — with the numbers behind it.

## Lists, feeds and marketplace pages

The AI crawler and AI source lists are data and are updated with the app. By default we compare the product page, the structured data and your store's public product data; your product feed and marketplace listings are compared only once their addresses are added — until then they're skipped, never counted as "missing".

**Just say it in the chat**: in a Website operations or SEO & GEO conversation, say something like "our Google product feed is https://…", "our Amazon listing is https://…, it's power-bank-20000 in our store", "stop checking GPTBot" or "count Kimi as an AI source". A card shows just what will change; click "Looks good" to save it, and the site is checked again with the new settings.

To ask "can AI get into our site?" or "how many orders did AI bring last week?", just ask in the chat — the assistant reads the latest check to answer.

Ideas from Aleyda Solis' *AI Search Optimization Checklist*; the crawler list draws on the open-source ai.robots.txt project and each vendor's documentation; the technical audit, regression, competing-page and decay checks draw on the open-source claude-seo and claude-blog projects (MIT).
