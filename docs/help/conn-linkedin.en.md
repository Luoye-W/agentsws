# LinkedIn: the Company Page and the founder's own profile

The connection behind the LinkedIn duty in Social Media: how to set it up, what happens when it can't publish, and what it **never** does.

| Connection | In one line | Review |
|---|---|---|
| LinkedIn (Company Page + member) | Publishes posts you've planned and approved to the Company Page or the founder's profile | Member posting is self-serve; Company Page posting needs Community Management API review |

Two things to remember:

- **Not being approved is normal.** Posting as a Company Page needs LinkedIn's review, and most small companies never get it. That's fine: planning, drafting and approvals work as usual; when an approved post is due, it becomes a to-do — "copy the text and post it on LinkedIn" — and you mark it done once posted.
- **No scraping, no automated invitations, messages or likes.** LinkedIn's user agreement forbids it. Finding buyers, connecting and messaging on LinkedIn belong to the B2B position, which also only gives you tasks to do yourself.

## LinkedIn (Company Page + member)

**How**

1. Create an app in the LinkedIn developer portal and associate it with your Company Page.
2. Member profile: add the "Share on LinkedIn" product (`w_member_social`). Company Page: apply for the Community Management API (review-based; the person authorising must be a Page admin).
3. Go through OAuth to get an access token.
4. Paste the token and the author URN into the form (`urn:li:organization:…` for a Company Page, `urn:li:person:…` for a member). They stay on this computer only.

**Links**

- [Posts API docs](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- [Access tiers](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access)

**If it isn't connected**

You can still plan, draft and queue approvals. When a post is due it becomes a to-do with the text ready to copy. Posts with images, documents (PDF carousels) or video can't be published for you yet in this version, so they become to-dos too.

## FAQ

- **What's the difference between a to-do and a card?** A card asks you to decide; a to-do asks you to do something. You already approved this post — all that's left is pasting it on LinkedIn.
- **Can you connect with purchasing managers for me?** No. It breaks LinkedIn's user agreement and gets your account restricted. Prospecting lives in the B2B position, which only gives you tasks to do yourself.
- **How many posts a day?** At most one for this duty; the calendar defaults to 2–5 a week with at most one product post. Keep outbound links out of the body — the platform suppresses them.
