---
description: In Settings → Data sources → Search data, choose official (credits per call, failures free), your own provider key (no credits), or off.
---
# Search data APIs

When the "SEO & GEO" duty checks search result pages (where you rank on Google / Bing, whether the AI overview mentions you) or asks AI platforms (do ChatGPT, Gemini, Claude or Google AI Overviews mention you), it needs third-party search data. The "Connections → Search data" row decides where it comes from — three options:

| Option | Who pays | In one line |
|---|---|---|
| Official (credits) | You, in credits | Agents Workshop's official data service, charged per call; failed calls are free. The unit price is shown under the buttons |
| My own key | You pay the provider directly | This computer calls your chosen provider with your own quota; no credits |
| Off | — | Steps that need search data are skipped, and the card says so |

If you never chose, it picks in this order: linked an Agents Workshop account → official; not linked but saved your own key → own key; neither → off. Saving your own key switches to "own key". If the chosen option fails it **doesn't switch**: a failing own key reports the error rather than quietly spending credits.

## Use the official option (credits)

1. Link your Agents Workshop account in [Settings → Account & credits](/settings/credits) first (see [Agents Workshop models and credits](help:agentsws-credits)).
2. Open Settings (⌘, or your name at the bottom left → Settings) → Brand → Data sources and click "Official (credits)" on the "Search data" row.
3. Once it says "Ready" with the unit prices (per search-results query, per AI platform), you're done.

## Bring your own key

Three providers:

- **DataForSEO**: one key for Google / Bing results (with AI overview and "People also ask") plus ChatGPT / Gemini / Claude answers.
- **SerpApi**: Google / Bing + AI overview + Copilot.
- **Serper**: Google web results only; the cheapest.

1. Sign up with the provider and get a key (for DataForSEO write it as `login:password`).
2. Open "Settings → Data sources", click "My own key" on the "Search data" row, pick the provider, paste the key and click "Save".
3. Click "Test connection". Fill it again to replace; "Remove" to drop it.

The key stays in this computer's encrypted store — never in logs, never in the cloud.

## FAQ

- **Which provider does the official option use**: the UI doesn't say; errors only mention "the official data service".
- **Why Claude costs more and looks different from the website**: Claude's answers are taken from Claude's web-search answers, so they may differ slightly from what you see on claude.ai. Each ask costs more than the others (about 3.6 credits); "Tracking settings" shows roughly how much Claude costs per month, and you can switch off just Claude. To read these answers, see [AI answer tracking](help:ai-answer-tracking).
- **Why Copilot sometimes can't be checked**: the official option doesn't cover Copilot yet; bring a SerpApi key to check Copilot.
