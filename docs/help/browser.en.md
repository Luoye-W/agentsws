# Let AI use a browser (four ways)

Some work only exists on a web page (a YouTube channel page, Amazon Seller Central). "Settings → Browser" says which browser the workstation uses. **Leave it off and no role can open a page at all.**

Three rules that never change:

- Each role can only open the sites its job description lists; everything else is refused: each creator channel its own platform, Amazon support only Seller Central, every other role none at all.
- Passwords are always typed by you in the browser — the AI never sees them.
- Screenshots go to the AI model you chose so it can see the page; they are not kept in the Agents Workshop records.

## Which one

| Mode | In one line | When |
|---|---|---|
| No browser | The default. No role can open a web page | Work that doesn't need the web yet |
| Use the Chrome on my computer | The Chrome you're already signed in to: no second login, you clear the captchas; one task at a time | Normally |
| Use a separate Chrome | A clean browser for each task, signed in to nothing | The service isn't on your computer, or you don't want AI near your logins |
| The browser I already use | Your everyday browser (Chrome / Edge): anything you're signed in to is visible; the AI works in its own window and asks before touching a tab you have open | You need things only visible when signed in, without a second browser |

A separate Chrome never touches your everyday logins — clean, but you sign in to everything again. Your own browser can see what only a signed-in you can see; the AI works in its own window and asks before using a tab you already have open.

"Use the Chrome on my computer" and "The browser I already use" only work when the service runs on your own computer; on a shared company deployment they're greyed out with the reason (there `127.0.0.1` means the server's own machine).

## Use the Chrome on my computer

1. Choose "Use the Chrome on my computer".
2. Click "Find it" to fill in the debugging address (default `http://127.0.0.1:9333`), or type it and click "Test".
3. No debugging port open yet? Use "Open the work browser" in the desktop app tray — it opens a separate work Chrome and leaves your everyday one alone.
4. Click "Save".

## Use a separate Chrome

1. Choose "Use a separate Chrome".
2. Point at a Chrome / Chromium executable already installed, e.g. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS. We don't download a browser for you.
3. Click "Save".

## The browser I already use (Tencent BrowserSkill)

Three extra steps, because two things can't be installed by us: the extension must be added by you in the browser, and bsk is a small local program.

1. **Install the extension** in the browser you actually use (Chrome or Edge — either; nothing to configure): [Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi) / [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg).
2. **Install bsk** (a small local program): click "Install". The extension needs it to talk to the workstation. Version and checksum are pinned: the download is verified first and nothing is installed if it doesn't match.
3. **Check it**: whether the local service is running and the extension is connected; if not, each item tells you how to fix it. "All set" means roles can start working.
4. Click "Save".
