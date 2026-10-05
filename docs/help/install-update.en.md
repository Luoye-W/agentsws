# Installing and updating

Agents Workshop is a desktop app for Windows and Mac. Once installed, it checks for new versions by itself. When one is out, you update with one click: no re-downloading, no uninstalling.

## Download

Get it from the download page at agentsws.com/download. The page offers the right installer for your computer:

- **Windows**: `Agents-Workshop-Setup-<version>-x64.exe`
- **Mac with Apple silicon (M1 and later)**: `Agents-Workshop-<version>-arm64.dmg`
- **Mac with an Intel chip**: `Agents-Workshop-<version>-x64.dmg`

Not sure which Mac you have? Click the Apple menu → "About This Mac". If the chip starts with "Apple M", it is Apple silicon.

## Windows: first install

1. Double-click the downloaded `.exe`.
2. If a blue "Windows protected your PC" screen appears, click **"More info"**, then **"Run anyway"**. This shows up because the installer is not code-signed yet; it is not a virus.
3. Choose where to install (by default it goes in your own user folder, no admin rights needed) and click "Install".
4. It opens by itself when done. An icon appears in the tray at the bottom right of the taskbar; left-click it for the menu.

The first launch takes you straight to setup. Just follow along.

## Mac: first install

1. Double-click the `.dmg` and drag Agents Workshop into Applications.
2. The first time, **right-click it in Applications → "Open" → "Open" again**. A plain double-click gets blocked with "cannot verify the developer". You only need to do this once.
3. Once open, it lives as an icon on the right of the menu bar at the top of the screen, not in the Dock.

## How updates work

Agents Workshop checks for a new version when it starts, then about every 4 hours. When there is one:

1. **"Update available"** appears in the workbench's **bottom-left corner, just above your name**. The tray menu gets an item too.
2. Click it and the new version downloads in the background, with progress shown next to the button. Keep working as usual.
3. When the download finishes, the button turns into **"Restart to update"**. Click it whenever it suits you.
4. If something is still running (an official scene is open, or the AI is using the computer), it first asks "Something is still running. Restart now?". Choose "Not now" and nothing restarts; the button stays.
5. Confirm and the app quits, installs the new version and reopens by itself, usually in under a minute.

**Your data and settings stay**: account, connected services, keys saved on this computer and your work history are left alone. Before updating it runs a self-check. If the check fails, it skips the update and the old version keeps working.

### When an update fails

The button turns red and says "Download failed" or "Update not installed". Hover over it to see why, for example:

- **Cannot reach the download server**: check your network, then click the button to retry.
- **Not enough disk space**: free some up and retry.
- **Self-check failed**: nothing changes and the old version keeps working. Use "Export a diagnostics bundle…" in the tray menu and send it to us.

If our own download server is unreachable, the app automatically checks the mirror on GitHub instead.

### Updating on a Mac

The Mac version is not signed yet, and macOS does not let an unsigned app replace itself. So on a Mac the button says "Update available" and opens the download page. Download the new `.dmg` and drag it into Applications over the old one. Your data stays. Once the Mac version is signed, it will update with one click just like Windows.

## Stable and beta

A version with `beta` in it (like `0.2.0-beta.3`) is a **beta**: you get new features first, with the odd rough edge. One without (like `0.2.0`) is **stable**. You keep getting updates for the kind you installed. Beta users are also told when the matching stable version comes out.

## Uninstalling

- **Windows**: Settings → Apps → find Agents Workshop → Uninstall.
- **Mac**: drag Agents Workshop from Applications to the Trash.

Uninstalling does not delete your data. It lives in `%APPDATA%\@agentsws\desktop` on Windows and in "~/Library/Application Support/@agentsws/desktop" on a Mac. Delete it yourself if you are sure you no longer need it.
