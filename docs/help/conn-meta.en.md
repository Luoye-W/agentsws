# The Meta connections (Facebook / Instagram / WhatsApp)

What each of the six Meta connections does and how to set it up. They all start in the Meta developer dashboard, and most permissions **need review** — if you're not in a hurry, connect them last.

| Connection | In one line | Review / cost |
|---|---|---|
| Meta Ads (Facebook / Instagram) | Lights up the ads tile (the "Authorize" route, like Google's) | Review takes longer than the Google ones |
| Instagram Graph API | Creators: look up a business account by name for followers and engagement | Permissions need review |
| Facebook Graph API | Creators: search Pages, read follower counts and categories | Page Public Content Access is review-based |
| Meta Graph API (FB Page + IG) | Social media: read posts, publish and schedule, reply to comments | Reading works once connected; publishing needs App Review |
| Meta Marketing API (ads) | Ads: read performance, change budgets and bids, pause, swap creatives | Ads permissions need review |
| WhatsApp Business API | Message customers with approved templates | Business verification required; templates need approval |

One thing to remember: **the social Meta card (posting) and the ads Meta card (spending) are two different cards** with different permissions — don't merge the two keys into one.

## Meta Ads (Facebook / Instagram)

You create your own app in the Meta developer dashboard. Review takes longer than the Google ones, so if it's not urgent, connect it last.

**How**

1. Open [Meta for Developers](https://developers.facebook.com/apps) and create a "Business" type app.
2. Add the "Marketing API" product to it.
3. Get the app ID and secret from the app settings.
4. Put those two values into OpenConnector.
5. Come back, click "Authorize", and pick the ad account you want.

**Links**

- [Meta for Developers](https://developers.facebook.com/apps)

**Once connected**

The ads tile on the role panel lights up. Spend and ROAS data arrive in the next version.

## Instagram Graph API

Instagram **has no "search people by keyword"**: officially you can only look up a business account you name explicitly. So finding people on IG always relies on imports and the public library; this connection adds "how many followers do they have now, and how's their engagement".

**How**

1. Switch your Instagram account to a Business account and link it to a Facebook Page.
2. Create an app in the [Meta developer dashboard](https://developers.facebook.com/apps) and add the Instagram Graph API.
3. Request `instagram_basic` and `instagram_manage_insights` (**these need review**).
4. Use the Graph API Explorer to get a long-lived token, and note your own IG business account ID.
5. Enter the token and ID in the form. They stay on this computer only.

**Links**

- [Meta developer dashboard](https://developers.facebook.com/apps)
- [business_discovery docs](https://developers.facebook.com/docs/instagram-api/guides/business-discovery)

**Before approval**

Until the permissions are approved, the job still works — only the "look up by name" part stays empty; finding people relies on imports and the public library.

## Facebook Graph API

Searches Pages and reads a Page's follower count and category.

**Searching Pages needs the Page Public Content Access permission, which is review-based.** Until it's approved we say plainly "needs review" — we won't show an empty list and pretend nothing matched. Outreach goes through Page messages, not email: plenty of Pages list no email at all.

**How**

1. Create an app in the [Meta developer dashboard](https://developers.facebook.com/apps), type "Business".
2. Request Page Public Content Access. Explain the use clearly — **it's review-based**.
3. Use the Graph API Explorer to get a long-lived access token.
4. Enter the token in the form. It stays on this computer only.

**Links**

- [Meta developer dashboard](https://developers.facebook.com/apps)
- [Page search docs](https://developers.facebook.com/docs/graph-api/reference/page/)

**Without it**

The job still works: finding people relies on imports and the public library, and outreach is done by hand through Page messages.

## Meta Graph API (FB Page + IG)

One token covers your FB Page and IG business account: read posts and performance, publish and schedule, reply to comments.

**Reading works as soon as you connect; publishing needs App Review** — two separate things, so don't read "not approved yet" as "connection failed". We handle scheduling the way Meta requires: if you only set a time without turning off "publish now", the post goes out immediately.

**How**

1. Switch IG to a Business account and link it to your FB Page (skip this if you only post to FB).
2. Create an app in the [Meta developer dashboard](https://developers.facebook.com/apps) and add Facebook Login and the Instagram Graph API.
3. Request `pages_manage_posts` / `pages_read_engagement` / `instagram_content_publish` (**these need review**).
4. Use the Graph API Explorer to get a long-lived Page token, and note the Page ID and IG account ID.
5. Enter the token and IDs in the form. They stay on this computer only.

**Links**

- [Meta developer dashboard](https://developers.facebook.com/apps)
- [Pages publishing docs](https://developers.facebook.com/docs/pages-api)

**Without it**

You can still plan content, write drafts and queue approvals — only the actual publishing step needs it. While publishing permission is under review, we remind you when it's time to post by hand in the dashboard; we never pretend it went out.

## Meta Marketing API (ads)

Reads ad account and campaign performance, changes budgets and bids, pauses, swaps creatives.

**It's a different card from the social Meta card (Meta Graph API (FB Page + IG) above)**: this one needs the "manage ads" permission (can move budget), that one needs the "publish Page posts" permission (can post). The exact permission names are listed on the card under "What you need". You can grant both in one authorization, but don't turn the two keys into one.

**How**

1. Create an app in the [Meta developer dashboard](https://developers.facebook.com/apps) and add the Marketing API.
2. Request `ads_management` and `ads_read` (**these need review**).
3. Use the Graph API Explorer to get a long-lived token, and note your Business Manager ID (optional).
4. Enter the token in the form. It stays on this computer only.

**Links**

- [Meta developer dashboard](https://developers.facebook.com/apps)
- [Marketing API docs](https://developers.facebook.com/docs/marketing-apis)

**Without it**

You can still read proposals, queue approvals and plan — only the step that actually touches the account needs it. While permissions are under review we say "not approved yet"; we never pretend a change was made.

## WhatsApp Business API

**These three rules are Meta's, not ours:**

- You must pass business verification.
- Messages you start must use an approved template (`template.name` is required), and the recipient must have opted in first.
- Only after the customer messages you do you get a 24-hour window for free-form replies.

Break them and it's the brand's number that gets banned. So if the template name is missing or opt-in hasn't been checked, we **block it on the spot** rather than letting one click send it; free text outside the window won't send either — you'll be asked to pick a template instead.

**How**

1. Pass business verification in Meta Business Manager and connect your number to the WhatsApp Business Platform.
2. Create an app in the developer dashboard, add the WhatsApp product, and get the phone number ID.
3. Create a system user and generate a long-lived access token (it must include `whatsapp_business_messaging`).
4. Create the message templates you'll use and wait for approval. The template name and language are the two fields that have to match here.
5. Enter the token and phone number ID in the form. They stay on this computer only.

**Links**

- [WhatsApp Cloud API docs](https://developers.facebook.com/docs/whatsapp/cloud-api)

**How bulk sends work**

Bulk messages go out **one at a time** (the Cloud API has no batch endpoint), so "send to N people" on the card means N separate calls. If we get rate-limited or disconnected partway, we **stop** — no carrying on, no retries. Retrying a template message that may already have been delivered means the customer gets it twice.

## FAQ

- **Permissions are still under review — did the connection fail?** No. Meta Graph API can read as soon as it's connected; publishing waits for App Review. The ads card says "not approved yet" during review.
- **Can one Meta app authorize all these cards?** You can grant them in one authorization, but social (posting) and ads (spending) are two cards with two keys — keep them separate.
- **Can I search Instagram creators by keyword?** No — Instagram simply doesn't offer that. Finding people relies on imports and the public library; this connection only adds followers and engagement.
- **A WhatsApp bulk send stopped halfway**: when rate-limited or disconnected we stop and don't retry, so nobody receives the same message twice.
