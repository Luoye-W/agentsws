# Connect OpenAI / a ChatGPT subscription

Two ways: sign in with the ChatGPT subscription you already pay for, or create an API key at platform.openai.com and pay per use. The two are billed separately — if you already pay for ChatGPT you don't need to buy API credit.

> Third-party tools signing in with a subscription are not explicitly authorised by OpenAI / Anthropic and may be rate-limited or banned; the account belongs to you alone — don't sign in on a shared company machine. The card always shows this.

## Option 1: sign in with ChatGPT (Plus / Pro)

Only available on the **personal** setup (the service runs on your own computer); on a shared company deployment the option is greyed out with the reason.

1. Make sure your ChatGPT account is Plus or Pro (the free tier can't do this).
2. On the "OpenAI / ChatGPT" card choose "Sign in with ChatGPT" and click "Sign in with a device code" — you get a URL and a code.
3. Open the URL on your phone or another computer, enter the code and approve.
4. The page switches to "Signed in" by itself; pick a model. The token renews itself before it expires.
5. Click "Sign out" to leave: the authorisation on this computer is destroyed at once and you'll need to sign in again.

- [ChatGPT plans](https://openai.com/chatgpt/pricing)
- [Codex CLI (where this sign-in comes from)](https://github.com/openai/codex)

## Option 2: API key (pay as you go)

Create a key at platform.openai.com and pay per token.

1. Open [OpenAI API keys](https://platform.openai.com/api-keys) and sign in.
2. Create a key and copy it (shown only once).
3. Choose "API key" on the card, click "Add API key", paste it and keep the prefilled address (`https://api.openai.com/v1`).
4. Click "Fetch model list" and pick a model (one that can read images).
5. Click "Test".

The API key only goes into this computer's encrypted store: never through AI, never into logs. Data residency is global: with "China-only models" selected it will be blocked.
