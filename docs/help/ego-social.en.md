---
description: With ego installed, approved posts and replies are filled in ego and sent by the app, which reads the link back and logs it. Turn on “Let me check before it sends” on a position to send them yourself. If ego can't send, it goes to the extension; if a site shows a captcha, the app stops and tells you.
---
# How the app uses ego to post, reply and find creators

Once ego is installed (see [Install and set up ego](help:ego)), Reddit replies and posts, plus posts and comments on Facebook, Instagram, X, LinkedIn and TikTok, go through ego first. The browser extension takes over only when ego can't be used.

## How a post or reply goes out

1. The AI drafts it and makes a card under the duty's usual rules: if it needs approval, it waits for yours. Reddit cards that go through ego show up in the app with an “Approve and send” button.
2. Once approved, the app opens the page in ego, attaches images, fills in the text and clicks send.
3. It then reads back the link, logs it under Sent and marks it “Sent · logged”. If it can't read the link back, it says “clicked send, no link read back” rather than pretending it checked.

## Check it before it goes out

1. On the position page, open Settings and find “Let me check before it sends” under Connections (off by default).
2. With it on, the app only fills it in ego and leaves the page for you to send.
3. The app checks back a few times and logs it once it sees your post; if it doesn't, click “Posted” in the extension or the to-do.

## When ego can't send it

- Not signed in to that site in ego, the page layout changed, or ego isn't open: the item goes to the extension's “Waiting to send”, with the reason noted on the item.
- ego shows a prompt such as “Show notifications”: the bell asks you to click it away in ego, and the app carries on afterwards; after half an hour with no answer it goes to the extension.
- The site shows a captcha or a security warning: the app stops and tells you. It doesn't work around it or try another route.
- The app clicked send but couldn't confirm it went out: it stops and asks you to check, and never sends a second copy.

## Finding creators

Creator positions use ego to read public profiles (handle, followers, number of posts, bio). What they read is saved to your creator library and, like data from the browser extension, backed up to the app's cloud. Only public profile data is backed up; DMs and passwords are never uploaded.

Posting frequency and daily limits stay in the duty settings, set by you.
