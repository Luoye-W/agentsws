# Switching scenes

Agents Workshop focuses on cross-border e-commerce and marketing. It is **one** scene inside DeepSeek Harness (dsh). To code, write, or do anything else, switch to another dsh scene — the installer already ships the full dsh, so **there is nothing else to install**.

## How to switch

1. Click "Scenes" at the bottom of the left sidebar (or "Switch scene" in the tray menu).
2. Find the scene you want and click "Open".
3. To come back, switch to the Agents Workshop window.

## What the scene list shows

- **Agents Workshop**: the workstation you are using now. Always first, with a check mark.
- **web (official)**: DeepSeek's full official interface — chat, model settings, history, plugin management. It is the same app that runs inside the official desktop app.
- **Scenes you created**: started from an official template. You can delete these.
- **Official desktop app (installed by you)**: only appears if you installed the official DeepSeek Harness desktop app on this computer yourself. Clicking it just opens that app.

Other scenes are maintained by DeepSeek and run with the official defaults. Agents Workshop is not responsible for them.

## Where official scenes open

"Open" shows the official scene in a **separate window** titled "DeepSeek Harness (official)", apart from the workshop window, so you can switch back and forth:

- Closing that window only hides it. The scene keeps running and its tasks are not interrupted; click "Open" again to bring it back.
- Choosing a working folder in it uses your system's own folder picker.
- Voice input asks your system for microphone permission.
- If an official scene is still open when you quit Agents Workshop, you are asked first — quitting closes it too.

Prefer your browser? In the tray's "Switch scene" menu, check "Open scenes in the browser".

## The official desktop app vs. the official scene here

If you installed the official DeepSeek Harness desktop app yourself, it and the official scene here are **two separate copies**:

| | Official scene in the workshop | Official desktop app you installed |
|---|---|---|
| Where data and sign-in live | Agents Workshop's own folder | `~/.dsh` on your computer |
| Version | Follows the Agents Workshop installer | Updates itself |
| Signed in to DeepSeek on one side | Sign in again on the other | Same |

Agents Workshop never changes the official desktop app's settings, and never downloads or installs it for you.

## FAQ

**I clicked "Open" and nothing happened?** The first open prepares the scene folder and starts its service, which can take a dozen seconds. If it has not opened after a minute, the scene row shows why; try "Restart".

**Which folder do other scenes work in?** On a new install, the `Agents 工坊` folder inside your Documents folder. If you installed an earlier version and already have a `dsh-workspace` folder in your home folder, that one keeps being used; nothing is moved.

**Can other scenes see my customer data or keys?** Not by default: their working folder is outside Agents Workshop's data folder, and none of our keys are passed to them. The official interface does let you add working folders yourself — do not add Agents Workshop's data folder.
