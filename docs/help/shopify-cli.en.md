# Install and sign in to Shopify CLI

Shopify CLI is Shopify's official command-line tool. The Theme duty on the Site Building team uses it for three things: pull your theme to this computer, push your edits as an **unpublished copy** for you to preview, and run Shopify's official Liquid check. Publishing a theme always waits for your approval on a card.

You only need this when your brand runs on Shopify. Other site platforms don't need it.

## 1. Check your Node version

Shopify CLI runs on Node.js **22 or newer** (the "Node" icon on the card shows what you have).

1. Open Terminal (on a Mac: Applications → Utilities).
2. Type `node --version` and press Return. `v22.` or higher is fine.
3. Too old or not found: install the LTS version from [nodejs.org](https://nodejs.org/), then open a new Terminal window.

## 2. Install

Run this in Terminal (the card has a Copy button):

```
npm install -g @shopify/cli@latest
```

On a Mac with Homebrew you can use:

```
brew tap shopify/shopify && brew install shopify-cli
```

Then click "Installed — check again" on the card. The "Installed" icon turns green.

## 3. Sign in through your browser (you do this yourself)

Run:

```
shopify auth login
```

A Shopify sign-in page opens in your browser. Sign in with the account that manages this store and pick the store. Then click "I have signed in" on the card.

- **You type your account and password only on Shopify's own page.** Agents Workshop never sees or stores them.
- Shopify CLI keeps its own session on your computer, in its own place. We don't read it and it never goes into our logs.
- To sign out: run `shopify auth logout`.

## 4. What happens next

- When editing a theme, the Theme duty pulls the theme, edits a local copy, runs `shopify theme check`, pushes an **unpublished copy**, and puts the preview link on a card for you.
- Anything that would replace what shoppers see (publishing or deleting a theme) always becomes a card for you to approve.
- It only runs the `shopify theme` commands, nothing else.

## FAQ

- **What if I don't install it?** Nothing else is affected. Theme work goes through the store Admin API instead, without local preview or the official check.
- **My brand switched to another platform.** The card disappears and the Shopify skill is switched off. We never uninstall the CLI from your computer.
- **We run several brands.** Each brand is judged on its own platform. Only Shopify brands see this card.
- **Does the CLI send usage data?** When Agents Workshop runs the CLI for you it sets `SHOPIFY_CLI_NO_ANALYTICS=1` to turn its usage statistics off.
