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

## Visits and sales from AI (Content & search)

The Content & search duty page gets one more block: sales and revenue from ChatGPT, Perplexity, Gemini, Copilot, Claude and others in the last 7 days, marked **measured** — Shopify's own record of where shoppers came from, not an estimate. The weekly AI answer tracking report shows the same line next to "did AI mention you".

- Each order counts once: the AI of the last visit before buying, otherwise the first visit;
- **Visits** need the "Reports" permission in your store authorization; without it only sales are counted, and the footer says so.

## Lists, feeds and marketplace pages

The AI crawler and AI source lists are data and are updated with the app. By default we compare the product page, the structured data and your store's public product data; your product feed and marketplace listings are compared only once their addresses are added — the place to add them is still being built, so for now they're simply skipped, never counted as "missing".

Ideas from Aleyda Solis' *AI Search Optimization Checklist*; the crawler list draws on the open-source ai.robots.txt project and each vendor's documentation.
