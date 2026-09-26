# The three TikTok connections

TikTok's three connections: the Research API for creators, the Content Posting API for publishing videos, and the Business API for ads. All three are **application-based**, and **each is applied for separately**.

| Connection | In one line | Review / cost |
|---|---|---|
| TikTok Research API | Creators: look up followers, likes and video count by username | Application-based; review takes days to weeks |
| TikTok Content Posting API | Social media: post videos to TikTok | Application-based; separate from the Research API |
| TikTok Ads (Business API) | Ads | Not connected yet; needs an approved developer app |

## TikTok Research API

**Application-based**: you submit a research-use statement to TikTok and only get data once approved.

Once approved, you can look up followers, total likes and video count by username. The engagement rate is our estimate (average likes per video ÷ followers); if any of the three numbers is missing, we leave that cell blank. TikTok has no "search people by keyword" endpoint either.

**How**

1. Sign up for a developer account at [TikTok for Developers](https://developers.tiktok.com).
2. Apply for Research API access and explain your use clearly. Review takes days to weeks.
3. Once approved, get the client key and client secret from the app details page.
4. Exchange them for a client access token. It lasts two hours; get a new one when it expires.
5. Enter the token in the form. It stays on this computer only.

**Links**

- [TikTok for Developers](https://developers.tiktok.com)
- [Research API docs](https://developers.tiktok.com/doc/research-api-get-started)

**Before approval**

The job still works without approval — only the finding-people part stays empty. TikTok Shop sales attribution runs on tracking links and affiliate codes, not on this connection.

## TikTok Content Posting API

**Application-based**, and **applied for separately** from the Research API the creator job uses.

Publishing takes two steps: we hand it to TikTok, TikTok fetches the media itself, then we wait for it to report back. A one-step publish doesn't exist on TikTok, so a post only counts as "out" once TikTok says it's done. Also, there's **no public API for reading or replying to comments**, so the "comments to answer" area stays empty for this channel.

**How**

1. Create an app in the TikTok developer portal and apply for the Content Posting API. It needs a use statement and is review-based.
2. Add the domain your videos are served from to the app's URL allowlist. We use `PULL_FROM_URL`, meaning TikTok fetches the video itself.
3. Use the client key / secret to go through OAuth and get an access token with `video.publish`.
4. Enter the token in the form. It stays on this computer only.

**Links**

- [Content Posting API docs](https://developers.tiktok.com/doc/content-posting-api-get-started)

**Before approval**

Until your application is approved, TikTok answers 403. We call that "this endpoint needs an application first", not "connection failed", so you don't keep re-entering a token that's perfectly fine. Meanwhile scheduling, drafts and approvals work as usual, and we remind you when it's time to post by hand.

## TikTok Ads (Business API)

First, in Business Center, you authorize your ad account to an approved developer app. It's a separate application from the social side's Content Posting API.

> **Not connected yet.** The connection entry, duties, quotas and panel skeleton are in place; the real API calls aren't built. Spark Ads (promoting videos you've already posted) also need a second authorization code from the organic account side, so the day it's connected it has to be done together with social TikTok publishing (`social.tiktok`).

**How**

1. No steps yet — this one isn't connected.

**Links**

- [TikTok Business API](https://business-api.tiktok.com/portal/docs)

## FAQ

- **My Research API is approved — can I post videos now?** No. Posting needs the Content Posting API, applied for separately; the ads Business API is yet another application.
- **A post keeps showing as pending**: TikTok publishing is two steps — it only counts as posted once TikTok has fetched the media and reported back.
- **Content Posting returns 403**: most likely the endpoint isn't approved yet; the token is fine, no need to re-enter it.
- **Can the AI reply to TikTok comments?** No — TikTok has no public API for reading or replying to comments.
