---
description: SEO & GEO groups keywords into topic clusters by their search results; you approve one card and the whole cluster fills the editorial calendar at 2 posts a day, handed to Content & Blog on the day. Backlinks get a monthly check with gaps sent to PR, llms.txt is generated and sent to the site builder, and published posts can be drafted into social posts in one click.
---
# Editorial calendar: topic clusters, backlinks, llms.txt, social drafts

In the Web Ops position, the card column on the right has an **Editorial calendar** card. It opens three tabs in the side panel: **Calendar**, **Backlinks** and **llms.txt**. Decisions (approving a cluster) show up in the main column; the data lives here.

## How a topic cluster is planned

1. In Calendar, click **Plan a topic cluster**. The button shows roughly how many credits it costs (each keyword's search results are checked);
2. The workshop starts from keywords that already get impressions in Search Console plus the category and keywords in your brand profile, and checks the top 10 search results for each;
3. The more top-10 URLs two keywords share, the more they belong together: **7+ shared means one post, 4–6 the same group (linked to each other), 2–3 one link each way**;
4. The keyword that overlaps most with the others and has the most volume becomes the **pillar**; the rest are supporting posts. Keywords you already rank for are marked **Refresh** that page instead of writing a new one;
5. A **Topic cluster** card appears in the main column: how many posts, which day each is written, how they link, and why they belong together. You can remove a few posts before approving, or reject the whole thing.

## After you approve

- The cluster is scheduled at up to 2 posts a day (the same number as Content & Blog's publishing limit), pillar first;
- Each morning, every post due that day becomes a writing task for Content & Blog (or for SEO & GEO if no one owns Content & Blog), with the target keyword and the internal links to add;
- Publishing still goes through the pre-publish check and needs your click; once a post is live it shows as **Published** in the calendar;
- **Due for a refresh** lists pages whose clicks are dropping in the daily check, and calendar posts published more than six months ago.

## Backlink check (monthly, can be turned off)

- It looks at three things: **referring domains up or down since last time**, **anchor text concentrated on one phrase**, and **suspicious sources** (high spam score, or one site with lots of links using the same keyword anchor);
- The top 10 sites that **link to your competitors but not to you** become a task for PR (off-site mentions belong to PR);
- The panel shows roughly how many credits each check costs; switch off **Check monthly** if you don't want it;
- Link data only covers what gets crawled, so counts run low, and authority and spam scores are estimates. The check lists things to review — **it never disavows links for you**.

## llms.txt

- The weekly site health check looks at your site's llms.txt: missing, out of date (new collections or policy pages not listed, or pages that are gone), or malformed;
- **Generate** builds one from your collections, products and policy pages; **Send to site builder** opens a task for the site role;
- Since May 2026 every Shopify store serves /llms.txt by default (a copy of the Shopify-generated /agents.md) — no app needed. To use ours instead: Online Store → Themes → Edit code, add `templates/llms.txt.liquid`, paste the content and save;
- That template can't read collections or articles, so the content is static: when the store changes, the health check flags it as out of date — generate a new one. Switching themes drops the file, so put it back afterwards;
- No AI is guaranteed to read it, and Google Search ignores it.

## Draft social posts from a published post

- At the bottom of Calendar, recently published posts have a **Draft social posts** button: it drafts an X thread, a LinkedIn post, a Reddit post and a short-video script, and opens a task for whoever owns each social role; channels with no owner are skipped and say so;
- **Drafts only — nothing is posted.** Numbers in the drafts come from the post; numbers it doesn't contain and invented lines like "I tested" are removed and replaced with a "your real experience" placeholder to fill in or delete;
- Platform limits and rules change — check in the platform's own composer before posting, and read the subreddit rules and disclose who you are on Reddit.
