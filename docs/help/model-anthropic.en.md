---
description: Sign in with the Claude Pro / Max subscription you already pay for (personal setup only), or create an API key at console.anthropic.com and pay per use.
---
# Connect Anthropic / a Claude subscription

Two ways: sign in with the Claude subscription you already pay for, or create an API key at console.anthropic.com and pay per use. If you already pay for Claude you don't need to buy API credit.

> Third-party tools signing in with a subscription are not explicitly authorised by OpenAI / Anthropic and may be rate-limited or banned; the account belongs to you alone — don't sign in on a shared company machine. The card always shows this.

## Option 1: sign in with Claude (Pro / Max)

Only available on the **personal** setup (the service runs on your own computer). Claude has no device code — only "Sign in with the browser".

1. Make sure your Claude account is Pro or Max (the free tier can't do this).
2. On the "Anthropic / Claude" card choose "Sign in with Claude" and click "Sign in with the browser" — Claude's authorisation page opens.
3. Once you approve, the page switches to "Signed in" by itself; if the browser is on another machine, paste the code it shows back here and click "Submit".
4. Pick a model.
5. Click "Sign out" to leave: the authorisation on this computer is destroyed at once.

- [Claude plans](https://claude.ai/upgrade)

## Option 2: API key (pay as you go)

This uses Anthropic's own native API: add an Anthropic key and you're set. You can also pick a thinking level (Fast / Standard / Deep) next to the AI button; model names, image support and context length come from Anthropic's official Claude catalog.

1. Open the [Anthropic Console](https://console.anthropic.com/settings/keys) and create a key under API keys.
2. Copy it, choose "API key" on the card, click "Add API key" and paste it.
3. Keep the prefilled address (`https://api.anthropic.com`).
4. Click "Fetch model list" and pick a model (claude-sonnet-4-5 or similar).
5. Click "Test".

- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)

If you connected the old way (address `https://api.anthropic.com/v1`), it switches to the native API automatically after the update: no need to re-enter the key, the model or the models you added to the AI button.

The API key only goes into this computer's encrypted store: never through AI, never into logs.
