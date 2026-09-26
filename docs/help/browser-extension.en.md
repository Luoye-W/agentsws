# The “Creator helper” browser extension

This covers the Chrome extension “Agents Workshop · Creator helper”: it gives a creator an instant check-up right on their YouTube / Instagram / TikTok page, and one click saves them into the current brand’s creator list.

## What it can and cannot do

- **Only three things**: view creators (the check-up), save creators, and read your creator list.
- **It cannot** send email, change deals, or touch orders.
- **It only collects when you press the button** — no browsing history, no scrolling or paging on its own.
- **It only talks to `127.0.0.1` on this computer**, before and after pairing — it knows no cloud address. What it saves lands on your own computer first.

## What you need

- Chrome on this computer;
- the Agents Workshop desktop app running (the extension looks for it, default port 4317);
- the package `agentsws-influencer-assistant-<version>-chrome.zip`.

## Install

1. Unzip the package somewhere **you will not delete by accident** (for example “Documents/Agents Workshop extension”). A developer-mode extension is loaded from that folder; delete the folder and the extension is gone.
2. Type `chrome://extensions` in Chrome’s address bar and press Enter.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** (top left) and pick the `chrome-mv3` folder inside what you unzipped.
5. A new icon appears in the toolbar; press it and the panel shows up at the top right of the page. Open any YouTube channel page — the check-up already works.

## Pair it (only needed to save into your creator list)

1. In the workstation, open “Connections”, scroll to **Browser extension** and press **Generate a pairing code**. Six digits appear — **valid for 5 minutes, once only**.
2. Back in Chrome, find the extension in `chrome://extensions` → “Details” → “Extension options” (or press “Pair” on the page panel).
3. Type the six digits and press **Pair**. The panel’s first line now says which brand it saves into.

The code only lives on that workstation screen: it is not stored in the browser or the URL, and closing the page loses it — just generate another. After 5 minutes the code stays on screen (you may be typing it digit by digit) with a note that it has probably expired; if it is rejected, generate a new one.

## Revoke a browser

Paired browsers are listed under “Browser extension”, each with its extension id and when it was last used. Press **Revoke** and that browser can never send anything in again. A revoked key **stays on the list** with the time it was revoked, so you can answer “did I revoke one last week?”.

## The public creator library

> Once you sign in to an Agents Workshop cloud account, the **public** creator data you collect while browsing is shared to the public creator library (there is no separate switch); in return, using data others contributed costs you nothing extra. Not signed in = nothing is uploaded.

Only what the platform already shows publicly is shared: channel, handle, profile link, avatar; follower / view counts as printed on the page; public business contacts and the page they came from. **Your notes, shortlists and lists, deals and campaigns, and emails with creators never go to the public library.**

## FAQ

- **“Can’t reach Agents Workshop on this computer”**: the desktop app is closed, or it is not on the default port 4317. Open the app; if the port really differs, change it at the bottom of the extension’s settings.
- **“Wrong pairing code”**: a code lives 5 minutes and works once. Go back to the workstation and generate another.
- **The panel says “N items waiting in the extension”**: the desktop app was closed, so the extension held them. Open the app; within 5 minutes they are sent.
- **Save into a different brand**: “Unpair” in the extension settings, then generate a new code on that brand’s Connections page.
- **Stop using it**: remove it in `chrome://extensions`, then **revoke** its key under “Connections → Browser extension” — removing the extension only clears this computer; revoking is what kills the key.
