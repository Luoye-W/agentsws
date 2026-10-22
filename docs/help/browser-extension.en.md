---
description: The Creator helper Chrome extension ships with Agents Workshop. Load it once in Developer mode to check up on and save creators on YouTube, Instagram and TikTok.
---
# The “Creator helper” browser extension

The Chrome extension “Agents Workshop · Creator helper” isn’t in the Chrome Web Store — it ships with the app and updates with it. It gives a creator an instant check-up right on their YouTube / Instagram / TikTok page, and one click saves them into the current brand’s creator list.

## What it can and cannot do

- **Only three things**: view creators (the check-up), save creators, and read your creator list.
- **It cannot** send email, change deals, or touch orders.
- **It only collects when you press the button** — no browsing history, no scrolling or paging on its own.
- **It only talks to `127.0.0.1` on this computer**, before and after pairing — it knows no cloud address. What it saves lands on your own computer first.

## What you need

- Chrome on this computer;
- the Agents Workshop desktop app running (the extension ships with it and updates with it — nothing to download).

## Install (once)

The extension is not in the Chrome Web Store. It comes with Agents Workshop, in a fixed folder on your computer. Add it to Chrome once; after that it updates whenever the app updates — **no uninstalling, no reinstalling**.

1. In the workstation, under “Settings → This computer → Browser extension” (or on the extension card in a chat), press **Open Chrome extensions**: Chrome opens a new tab and `chrome://extensions` is already copied — paste it into the address bar and press Enter (Chrome does not let other programs open that page directly).
2. Turn on **Developer mode** (top right of the extensions page).
3. Back on the card, press **Open extension folder** (the path is copied for you), then click **Load unpacked** (top left of the extensions page) and pick that folder. If the picker cannot find it: on Mac press ⌘⇧G and paste the path; on Windows paste it into the address bar. You can also drag the folder into the picker.
4. A new icon appears in the toolbar; press it and the panel shows up at the top right of the page. Open any YouTube channel page — the check-up already works.

**Keep Developer mode on**: Chrome disables extensions added from a folder when it is turned off; turn it back on and the extension returns.

### Updates

Nothing to do. After the app updates, the extension reloads itself once while it is idle (no ads / Reddit action in progress); pairing, settings and permissions you already granted stay. If Chrome is closed, it simply starts with the new version next time. The extension’s options page shows the current version.

If the connection card says the extension in your browser is still the old version: you probably added another copy earlier (for example from a downloaded zip). Remove that copy on the extensions page and add it again from the app’s folder with the steps above.

## Pair it (only needed to save into your creator list)

1. In the workstation, open Settings (⌘,) → This computer → **Browser extension** and press **Generate a pairing code**. Six digits appear — **valid for 5 minutes, once only**.
2. Back in Chrome, find the extension in `chrome://extensions` → “Details” → “Extension options” (or press “Pair” on the page panel).
3. Type the six digits and press **Pair**. The panel’s first line now says which brand it saves into.

The code only lives on that workstation screen: it is not stored in the browser or the URL, and closing the page loses it — just generate another. After 5 minutes the code stays on screen (you may be typing it digit by digit) with a note that it has probably expired; if it is rejected, generate a new one.

## Revoke a browser

Paired browsers are listed under “Browser extension”, each with its extension id and when it was last used. Press **Revoke** and that browser can never send anything in again. A revoked key **stays on the list** with the time it was revoked, so you can answer “did I revoke one last week?”.

## The public creator library

> Once you sign in to an Agents Workshop cloud account, the **public** creator data you collect while browsing is shared to the public creator library (there is no separate switch); in return, using data others contributed costs you nothing extra. Not signed in = nothing is uploaded.

Only what the platform already shows publicly is shared: channel, handle, profile link, avatar; follower / view counts as printed on the page; public business contacts and the page they came from. **Your notes, shortlists and lists, deals and campaigns, and emails with creators never go to the public library.**

## Reddit: the extension fills in the draft, you click send

In the extension settings, click “Reddit · Connect”. Chrome will ask for access to old.reddit.com / www.reddit.com. You log in to Reddit yourself in this Chrome; the extension never touches your password.

- For each Reddit reply, comment or post you approved in Agents Workshop, the extension **opens a new tab** and fills the draft into the reply box (or the submit page). A bar at the top says it is waiting for you to send.
- **You always click send yourself.** Once you do and the post shows up, Agents Workshop logs it (with a link). If you do not send it, Reddit blocks it, or you are logged out, the extension stops and nothing is logged as sent.
- **If the extension is offline, it waits**: approved posts stay queued until you open Chrome (up to 24 hours). Nothing is posted for you automatically.
- **Not posted? Fill it again**: the social media position page shows a “Not posted” line with the reason. Click “Fill again” to hand the same approved draft to the extension, with no new approval. You can also dismiss the line.
- To stop, click “Stop” on the bar. The draft stays on the page, unsent.
- **Not replying? Click “Don't send”.** It takes effect at once and a reason is optional. With no reason, only that card is skipped. If you give one (tap “Not relevant”, “Bad timing” and so on at the top, or type your own), AI checks your other pending cards against that reason and skips the ones that fit. The line at the top lists them and why; restore any single card or undo them all. When you click “Send”, similar cards are only offered to send together. They are never sent on their own.
- An extension paired before this update has to be **paired again** to do Reddit posting.

## FAQ

- **“Can’t reach Agents Workshop on this computer”**: the desktop app is closed, or it is not on the default port 4317. Open the app; if the port really differs, change it at the bottom of the extension’s settings.
- **“Wrong pairing code”**: a code lives 5 minutes and works once. Go back to the workstation and generate another.
- **The panel says “N items waiting in the extension”**: the desktop app was closed, so the extension held them. Open the app; within 5 minutes they are sent.
- **Save into a different brand**: “Unpair” in the extension settings, then generate a new code in that brand’s Settings → Browser extension.
- **Stop using it**: remove it in `chrome://extensions`, then **revoke** its key under “Settings → This computer → Browser extension” — removing the extension only clears this computer; revoking is what kills the key.
