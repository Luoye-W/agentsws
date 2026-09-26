# Connect DeepSeek (account sign-in / API key)

Direct in mainland China, cheap and good enough — pick it if you have no other preference. Data stays in China. There are two ways to connect; pick one:

- **Official account sign-in** (recommended, selected by default): no key needed. Sign in to your DeepSeek account once in the browser; usage is paid from your account balance.
- **Official API connection**: create an API key on the DeepSeek platform and paste it in; pay as you go.

If you already have a DeepSeek key and have never signed in with an account, the card opens on the API option.

## Option 1: official account sign-in

1. Click "Sign in with DeepSeek" — DeepSeek's authorisation page opens in your browser.
2. Sign in to your DeepSeek account on that page and click agree.
3. Back in Agents Workshop you see the account name and balance, then three checks run automatically (reachable → text → image).
4. Usage is paid from your DeepSeek balance; click "Sign out" to leave.

No browser window? Click "Didn't see the browser? Open it again". If the sign-in expires, the card says so — one click signs you in again.

Signing out deletes the sign-in on this computer and turns this model source off. Anything running on this account stops first — nothing is lost; switch model or sign in again and ask it to redo the work.

## Option 2: official API connection

1. Open the [DeepSeek platform](https://platform.deepseek.com/api_keys) and sign up / sign in with your phone number.
2. Find "API keys" on the left and click "Create API key".
3. Copy the key (it is shown only once).
4. Back in Agents Workshop, choose "Official API connection" on the DeepSeek card, click "Add API key", paste it and save.
5. Click "Test" — a model name and a latency means it works.

The API key only goes into this computer's encrypted store: never through AI, never into logs.

## Out of balance

- Account sign-in: the card says "DeepSeek balance too low" with a "Top up" link; top up on the [DeepSeek platform](https://platform.deepseek.com) and let it continue.
- API key: sign in to the platform with the DeepSeek account that created the key, top up, then retry.

## Related

- One key for both Qwen and DeepSeek: see [Alibaba Cloud Model Studio](help:model-bailian).
- Don't want to manage keys: see [Agents Workshop models and credits](help:agentsws-credits).
