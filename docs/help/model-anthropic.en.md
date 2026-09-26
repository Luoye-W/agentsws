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

This is Anthropic's official OpenAI-compatible endpoint: point the address at `api.anthropic.com/v1` and use an Anthropic key.

1. Open the [Anthropic Console](https://console.anthropic.com/settings/keys) and create a key under API keys.
2. Copy it, choose "API key" on the card, click "Add API key" and paste it.
3. Keep the prefilled address (the official OpenAI-compatible endpoint ending in /v1: `https://api.anthropic.com/v1`).
4. Pick a model name (claude-sonnet-4-5 or similar).
5. Click "Test".

- [OpenAI SDK compatibility](https://docs.anthropic.com/en/api/openai-sdk)

The API key only goes into this computer's encrypted store: never through AI, never into logs. Data residency is global.
