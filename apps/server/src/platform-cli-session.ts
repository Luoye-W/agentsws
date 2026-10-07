/**
 * WP253（Fable 10-07 真机 + Luoye 决定 138）：**平台 CLI 的登录会话按品牌分开**。
 *
 * 依据（读 `@shopify/cli@4.8.5` 的发行包源码，`npm pack` 到临时目录看的，没装）：
 *
 * 1. 会话存在 `conf` 的 `shopify-cli-kit` 那一份配置里——路径来自 `env-paths`：macOS
 *    `$HOME/Library/Preferences/shopify-cli-kit-nodejs`、Windows `%APPDATA%\\shopify-cli-kit-nodejs\\Config`、
 *    Linux `$XDG_CONFIG_HOME/shopify-cli-kit-nodejs`。**整台电脑默认只有一份**。
 * 2. `auth login --alias X`：X 已有会话 → 直接切过去（写「当前会话」，不开浏览器）；一份会话都没有 → 设备码登录，
 *    存下来的别名是**账号邮箱**（不是 X）；已有别的会话而 X 不在 → 弹「Which account would you like to use?」——
 *    非交互环境下这个提问直接失败（`Failed to prompt`）。不带 `--alias` 时非交互环境一开头就报
 *    「Flag not specified: --alias」（Fable 真机撞上的就是这一句）。
 * 3. `theme *` 命令认 `--auth-alias` / `SHOPIFY_FLAG_AUTH_ALIAS`（只在这一条命令里换会话，不改「当前会话」），
 *    但它按**别名或用户 id** 找，找不到就报 `No authenticated account found for alias`——我们不知道存下来的邮箱。
 *
 * 所以「一个品牌一个会话」最可靠的办法是**每个品牌一份 CLI 配置目录**：替用户跑 CLI 时把 `HOME` / `APPDATA` /
 * `LOCALAPPDATA` / `XDG_*` 指到 `<数据目录>/tools/<cli id>-sessions/<品牌>/`。这样每个品牌的配置里永远只有它自己
 * 那一份会话：登录（空配置 → 设备码登录）、主题命令（唯一那份就是当前会话）都不会碰到上面第 2 条的提问；
 * 不同品牌可以用不同的 Shopify 账号（决定 138）。`--alias` 照带（第 2 条的非交互检查要它），值是本品牌的别名。
 *
 * 重新登录时把这个品牌原来那份挪成 `.prev`（登好了删掉、没登成挪回来）——否则配置里已经有一份会话，
 * `--alias` 又对不上邮箱，就会撞上第 2 条的提问。这两个目录都是我们自己按品牌名建的，不碰用户自己的 CLI 配置。
 */
import { join } from 'node:path'

/** 目录名 / 别名里只留安全字符（品牌 id 本来就是 `ws_xxxx`）。 */
function segment(value: string): string {
  const mapped = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return mapped === '' ? 'x' : mapped
}

/** 这个品牌在 CLI 里的会话别名（`agentsws-ws_19cxxs7l`）。 */
export function cliSessionAlias(workspace_id: string): string {
  return `agentsws-${segment(workspace_id)}`
}

/** 这个品牌那一份 CLI 配置目录（`<tools>/<cli id>-sessions/<品牌>`）。 */
export function cliSessionHome(toolsDir: string, cli_id: string, workspace_id: string): string {
  return join(toolsDir, `${segment(cli_id)}-sessions`, segment(workspace_id))
}

/** 让 CLI 把配置 / 缓存都放进这个品牌那一份目录的几个环境变量（三个平台各认各的）。 */
export function cliSessionEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  }
}

/** 品牌会话的那一包（交给一键登录与主题命令）。 */
export interface CliSession {
  alias: string
  /** 没有数据目录（内存档）就没有——那时用整台电脑共用的那一份。 */
  home?: string
}
