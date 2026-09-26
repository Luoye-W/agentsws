# Email marketing and shipment tracking

The four connections for email marketing (Klaviyo, Shopify Email) and shipment tracking (AfterShip, 17TRACK). **None of them makes real API calls yet** — here's exactly how far each one has got.

| Connection | In one line | Where it stands |
|---|---|---|
| Klaviyo (email marketing) | Segments, templates, campaign results — read-only | Not connected yet, in progress; needs a read-only key |
| Shopify Email (email marketing) | Another email marketing tool | Planned, after Klaviyo |
| AfterShip (shipment tracking) | Where a parcel is and whether anything's wrong — read-only | Not connected yet, in progress; needs a read-only key |
| 17TRACK (shipment tracking) | Another tracking service | Planned, after AfterShip |

## Klaviyo (email marketing)

Segments, templates and campaign results, **read-only**. Sending doesn't go through this connection — a bulk send is always a card someone has to approve.

> **Not connected yet.** The connection entry, read-only actions and form are in place; the real API calls aren't built. Until then, the "flows" and "results" areas of the email marketing panel say plainly "not connected" — no made-up numbers.

**How**

1. Sign in to Klaviyo and go to Settings → API keys.
2. Click Create Private API Key and choose Read-only access.
3. Enter the key in the form. It stays only in this computer's encrypted store — never uploaded, never logged.

**Links**

- [Klaviyo API keys](https://www.klaviyo.com/settings/account/api-keys)

## Shopify Email (email marketing)

Comes after Klaviyo: most independent stores doing email marketing use Klaviyo, so that one goes first.

> **Planned.** Klaviyo comes first (the preferred choice); this one follows.

**How**

1. No steps yet — this one isn't connected. If you want email marketing now, connect Klaviyo first (also still in progress).

**Links**

- [Shopify Email](https://www.shopify.com/email-marketing)

## AfterShip (shipment tracking)

Read-only tracking: where the parcel is and whether anything's gone wrong. It does **not** write tracking numbers back — that's the job of the "mark as shipped" step.

> **Not connected yet.** The connection entry, read-only actions and form are in place; the real API calls aren't built. Until then, the "shipping exceptions" area of the order fulfillment panel says plainly "not connected".

**How**

1. Sign in to AfterShip and go to Settings → API keys.
2. Create a new key with read-only access.
3. Enter it in the form. It stays only in this computer's encrypted store.

**Links**

- [AfterShip API keys](https://admin.aftership.com/settings/api-keys)

## 17TRACK (shipment tracking)

On par with AfterShip; AfterShip goes first.

> **Planned.** Shipment tracking starts with AfterShip; this one follows.

**How**

1. No steps yet — this one isn't connected.

**Links**

- [17TRACK API](https://api.17track.net)

## FAQ

- **Can I use these now?** None of the four makes real API calls yet. The Klaviyo and AfterShip forms are in place; until the calls are built, the matching panel areas say "not connected" and never show made-up numbers.
- **Can Klaviyo send my campaigns?** No — sending doesn't go through this connection. A bulk send is always a card someone has to approve.
- **Will AfterShip change my tracking numbers?** No, it only reads tracking. Entering tracking numbers belongs to the "mark as shipped" step.
- **I use Shopify Email / 17TRACK**: those come after Klaviyo / AfterShip and have no steps yet. To connect the store itself, see [Connect your Shopify store](help:conn-shopify).
