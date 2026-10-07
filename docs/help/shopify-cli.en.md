# Install and sign in to Shopify CLI

Shopify CLI is Shopify's official command-line tool. The Theme duty on the Site Building team uses it for three things: pull your theme to this computer, push your edits as an **unpublished copy** for you to preview, and run Shopify's official Liquid check. Publishing a theme always waits for your approval on a card.

You only need this when your brand runs on Shopify. Other site platforms don't need it.

## 1. One-click install

1. Open the Site Building page (or Connections) and find the "Shopify CLI" card.
2. Click **Install** and wait until it goes from "Downloading" to installed — usually a minute or two.

- No terminal and no Node.js setup: Agents Workshop uses the Node that ships with the app and installs the CLI into **its own data folder**. No system settings change and no admin rights are needed.
- If Shopify CLI is already installed on your computer, the card recognizes it.
- If it fails, the card says why in one line (usually network or proxy). Click "Try again"; "Details" shows the raw output.

## 2. Sign in to Shopify (you do this yourself)

1. Once installed, click **Sign in to Shopify**. Your browser opens the Shopify sign-in page.
2. Sign in with the account that manages this store and confirm (the code on the page matches the one on the card).
3. Come back to the workshop; the card turns green by itself.

- Browser did not open: click "Did not open? Click here" on the card.
- Changed your mind: click "Cancel".
- **You type your account and password only on Shopify's own page.** Agents Workshop never sees or stores them.
- Shopify CLI keeps its own session on your computer, in its own place. We don't read it and it never goes into our logs.

## 3. Prefer the terminal? (optional)

"Details" has both commands to copy:

```
npm install -g @shopify/cli@latest
shopify auth login
```

This way needs Node.js **22 or newer**. Then click "Check again" on the card. To sign out, run `shopify auth logout`.

## 4. What happens next

- When editing a theme, the Theme duty pulls the theme, edits a local copy, runs `shopify theme check`, pushes an **unpublished copy**, and puts the preview link on a card for you.
- Anything that would replace what shoppers see (publishing or deleting a theme) always becomes a card for you to approve.
- It only runs the `shopify theme` commands, nothing else.

## FAQ

- **What if I don't install it?** Nothing else is affected. Theme work goes through the store Admin API instead, without local preview or the official check.
- **My brand switched to another platform.** The card disappears and the Shopify skill is switched off. We never uninstall the CLI from your computer.
- **We run several brands.** Each brand is judged on its own platform. Only Shopify brands see this card.
- **Does the CLI send usage data?** When Agents Workshop runs the CLI for you it sets `SHOPIFY_CLI_NO_ANALYTICS=1` to turn its usage statistics off.
