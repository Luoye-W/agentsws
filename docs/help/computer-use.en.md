# Let AI operate this computer

Some work only happens inside an app on this computer (desktop-only software, system dialogs). "Settings → Computer use" decides whether **AI may touch this computer** — see the screen, click, type. Off by default.

## Three switches

1. **Master switch** (on this card): "Allow AI to operate this computer".
2. **Which duties**: none by default. Unticked duties never even see the request.
3. **An approval card before each run touches the computer**: approved in the home deck, not in Settings. Each approval lasts a few minutes (1–60, set on the card).

Once on: after you approve a card, it can see your screen, click and type for those minutes — like someone sitting at your computer.

- It stops and hands over at logins, passwords, payments and verification codes; it never types them for you.
- Screenshots go to the AI model you chose so it can see the screen; they are not kept in the Agents Workshop records.
- The tray icon turns red while it works and the workstation shows "AI is operating this computer" at the top right; press Stop any time.

If the service isn't on your own computer (a shared company deployment), computer use can't be turned on.

## Three steps after turning it on

1. **Download the driver**: the open-source Cua Driver (MIT). We pin the version, check its sha256 and put it in the data folder — no system changes, nothing added to PATH.
2. **Grant system permissions**:
   - On macOS, turn on Accessibility and Screen Recording for "Agents Workshop". The two buttons only open the page; you flip the switches. Restart Agents Workshop afterwards.
   - Windows needs no extra permission. If SmartScreen blocks the first run, choose "More info → Run anyway".
3. **Self-check**: the driver reads its permissions once (no system prompt, no screenshot, no clicks); results are listed as-is, with a fix for anything missing. "Driver output" holds the full raw output.
