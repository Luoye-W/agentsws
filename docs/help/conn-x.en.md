# The two X (Twitter) connections

X's two connections: the X API for looking up accounts and posting, and the X Ads API for ads. **They're two separate authorizations** — paying for one doesn't cover the other.

| Connection | In one line | Review / cost |
|---|---|---|
| X API | Look up follower counts in bulk; post and reply | **Paid**, Basic tier and up; posting needs user-context OAuth |
| X Ads API | Ads | Not connected yet; application-based with manual review |

## X API

X's official API is **paid**: the free tier can't read user profiles.

Once connected, one call can look up follower counts for up to 100 usernames. **We don't fill in engagement rate** — the single-user endpoint doesn't return engagement on recent posts, and a blank beats a made-up number.

**How**

1. Sign up for a developer account in the [X developer portal](https://developer.x.com/en/portal/dashboard).
2. Buy a tier that can read the users endpoints (Basic and up; this step costs money).
3. Create an App inside a project and copy its Bearer Token.
4. Enter the token in the form. It stays on this computer only.

**Links**

- [X developer portal](https://developer.x.com/en/portal/dashboard)
- [users endpoint docs](https://docs.x.com/x-api/users/user-lookup-by-username)

**Without a paid tier**

The creator job still works: finding people relies on imports and the public library, and outreach, deals, review and attribution are all still there. The social media job's X duty uses this same card.

**About posting**

Posting and replying are connected (`POST /2/tweets`; a reply is the same endpoint with a `reply` field). But **posting needs user-context OAuth**: an App-only Bearer Token can read but not post. X then answers 403, and we tell you plainly that your tier doesn't include that endpoint.

## X Ads API

Application-based: you need an ad account first, then submit an Ads API application explaining your use, and wait for manual review.

> **Not connected yet.** The connection entry, duties, quotas and panel skeleton are in place; the real API calls aren't built. The paid X API tier on the social side **doesn't cover ads** — they're two separate authorizations. Until then, the X tile on the ads panel says "not connected yet".

**How**

1. No steps yet — this one isn't connected.

**Links**

- [X Ads API](https://developer.x.com/en/docs/x-ads-api)

## FAQ

- **Posting returns 403**: you most likely entered an App-only Bearer Token, which can only read. Posting needs user-context OAuth.
- **Why is the engagement rate blank?** X's single-user endpoint doesn't return engagement on recent posts, so we don't make one up.
- **I bought the X API — can I run ads with it?** No. The paid X API tier doesn't cover ads; the X Ads API is a separate authorization, and we haven't connected it yet.
