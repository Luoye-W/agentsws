/**
 * WP218：更新源（「去哪儿查新版本」）。构建时与运行时**同一份规则**：
 * `scripts/dist.mjs` 打包前用它算出 electron-builder 的 `publish`，
 * 运行时 `main.ts` 用它读安装包里的 `app-update.yml`、决定主源连不上时退不退到 GitHub。
 *
 * Luoye 10-05 定的分工：
 *
 * | 源 | 角色 | 地址 |
 * |---|---|---|
 * | **自有下载站（generic）** | 主源：应用内更新只查它 | `https://dl.agentsws.com/<渠道>/`（R2 公开桶，`stable/`、`beta/` 分目录） |
 * | **GitHub Releases** | 镜像：给开源用户下载，也作备用 | `Luoye-W/agentsws` 的 Release |
 *
 * 每个渠道目录里放的都是 `latest.yml` / `latest-mac.yml`（**不是** `beta.yml`）：
 * 渠道靠目录分，不靠文件名分。所以打包时 `detectUpdateChannel: false`，
 * 运行时也**不设** `autoUpdater.channel`（设了它会顺手把 `allowDowngrade` 打开）。
 *
 * 构建时用环境变量选源（不改仓库文件）：
 * - `AGENTSWS_UPDATE_PROVIDER` = `generic`（默认）| `github`
 * - `AGENTSWS_UPDATE_BASE_URL` = 自有下载站根地址（默认 `https://dl.agentsws.com`，只认 https）
 * - `AGENTSWS_UPDATE_CHANNEL` = `stable` | `beta`（不给就按版本号：带 `-beta.N` 的是 beta）
 */

/** 自有下载站根地址（R2 公开桶的自定义域，Fable 建）。 */
export const DEFAULT_FEED_BASE = 'https://dl.agentsws.com'
/** GitHub 镜像（与 `updater.ts` 的 `RELEASE_REPO` 同一个仓库）。 */
export const GITHUB_OWNER = 'Luoye-W'
export const GITHUB_REPO = 'agentsws'

export const UPDATE_CHANNELS = ['stable', 'beta'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export type FeedConfig =
  | { provider: 'generic'; url: string; channel: UpdateChannel }
  | { provider: 'github'; owner: string; repo: string; channel: UpdateChannel }

export const PROVIDER_ENV = 'AGENTSWS_UPDATE_PROVIDER'
export const BASE_URL_ENV = 'AGENTSWS_UPDATE_BASE_URL'
export const CHANNEL_ENV = 'AGENTSWS_UPDATE_CHANNEL'
/** 运行时开关：`0` = 主源连不上时**不**退到 GitHub 查（默认退一次）。 */
export const GITHUB_FALLBACK_ENV = 'AGENTSWS_UPDATE_GITHUB_FALLBACK'

/** 版本号 → 渠道：`0.2.0-beta.3` 是 beta，`0.2.0` 是 stable。别的预发布标签一律按 beta 算。 */
export function channelOf(version: string): UpdateChannel {
  return version.replace(/^v/, '').includes('-') ? 'beta' : 'stable'
}

function isChannel(value: string | undefined): value is UpdateChannel {
  return value !== undefined && (UPDATE_CHANNELS as readonly string[]).includes(value)
}

/** 本机回环（`127.0.0.1` / `localhost` / `[::1]`）。 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/**
 * 根地址规范化：只认 https、去掉尾斜杠。不对就抛——打包阶段宁可红，不发一个查不到更新的包。
 *
 * WP225 一个例外：**本机回环**上的 http（`http://127.0.0.1:<端口>`）。只给 CI 的「两个版本之间点更新」
 * 端到端用（本地起一个更新源喂 N+1）；回环上的东西出不了这台机器，没有被中间人换包的问题。
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`更新源地址不是合法网址：${raw}`)
  }
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !loopbackHttp) throw new Error(`更新源只认 https：${raw}`)
  if (url.search !== '' || url.hash !== '') throw new Error(`更新源地址不要带 ? 或 #：${raw}`)
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** 渠道目录：`https://dl.agentsws.com/beta`。 */
export function channelUrl(base: string, channel: UpdateChannel): string {
  return `${normalizeBaseUrl(base)}/${channel}`
}

/** 构建时：按环境变量与版本号算出这一包查哪个源。 */
export function feedFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  version: string,
): FeedConfig {
  const rawChannel = env[CHANNEL_ENV]
  if (rawChannel !== undefined && rawChannel !== '' && !isChannel(rawChannel))
    throw new Error(`${CHANNEL_ENV} 只认 stable / beta：${rawChannel}`)
  const channel = isChannel(rawChannel) ? rawChannel : channelOf(version)
  const provider = env[PROVIDER_ENV] ?? 'generic'
  if (provider === 'github') return { provider, owner: GITHUB_OWNER, repo: GITHUB_REPO, channel }
  if (provider !== 'generic' && provider !== '')
    throw new Error(`${PROVIDER_ENV} 只认 generic / github：${provider}`)
  const base = env[BASE_URL_ENV]
  return {
    provider: 'generic',
    url: channelUrl(base === undefined || base === '' ? DEFAULT_FEED_BASE : base, channel),
    channel,
  }
}

/**
 * electron-builder 命令行覆盖（`-c.publish.*`）。`electron-builder.yml` 里的 `publish`
 * 是默认那一份（generic + beta），这里按本次构建覆盖；`detectUpdateChannel=false`
 * 让渠道目录里的文件始终叫 `latest*.yml`。
 */
export function builderArgs(feed: FeedConfig): string[] {
  const common = ['-c.detectUpdateChannel=false']
  if (feed.provider === 'generic')
    return [...common, '-c.publish.provider=generic', `-c.publish.url=${feed.url}`]
  return [
    ...common,
    '-c.publish.provider=github',
    `-c.publish.owner=${feed.owner}`,
    `-c.publish.repo=${feed.repo}`,
    `-c.publish.releaseType=${feed.channel === 'beta' ? 'prerelease' : 'release'}`,
  ]
}

/**
 * 运行时：读安装包里的 `app-update.yml`（electron-builder 按 `publish` 写的那份）。
 * 只认我们用得到的几个键，一行一个 `key: value`——不为这几行拉一个 YAML 解析器。
 * 读不懂就回 `undefined`（调用方退回默认源）。
 */
export function parseAppUpdateYml(text: string, version: string): FeedConfig | undefined {
  const kv = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) kv.set(m[1], m[2].replace(/^['"]|['"]$/g, ''))
  }
  const channel = channelOf(version)
  const provider = kv.get('provider')
  if (provider === 'generic') {
    const url = kv.get('url')
    if (url === undefined) return undefined
    try {
      return { provider, url: normalizeBaseUrl(url), channel }
    } catch {
      return undefined
    }
  }
  if (provider === 'github') {
    const owner = kv.get('owner')
    const repo = kv.get('repo')
    if (owner === undefined || repo === undefined) return undefined
    return { provider, owner, repo, channel }
  }
  return undefined
}

/** 运行时：主源连不上时退不退到 GitHub 查一次。环境变量优先，其次 `config.json`，默认退。 */
export function githubFallbackEnabled(
  env: Readonly<Record<string, string | undefined>>,
  configValue: boolean | undefined,
): boolean {
  const flag = env[GITHUB_FALLBACK_ENV]
  if (flag === '0') return false
  if (flag === '1') return true
  return configValue ?? true
}

/** 主源是 GitHub 时就没有「退到 GitHub」这回事。 */
export function githubFallbackFeed(primary: FeedConfig): FeedConfig | undefined {
  if (primary.provider === 'github') return undefined
  return { provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO, channel: primary.channel }
}

/** 版本信息文件名：Windows `latest.yml`，mac `latest-mac.yml`，Linux `latest-linux.yml`。 */
export function updateInfoFile(platform: string): string {
  if (platform === 'win32') return 'latest.yml'
  if (platform === 'darwin') return 'latest-mac.yml'
  return 'latest-linux.yml'
}

/** 从 `latest*.yml` 里取 `version:`（notify 档只要这一个字段）。 */
export function versionFromUpdateInfo(text: string): string | undefined {
  const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)
  return m?.[1]
}
