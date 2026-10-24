/**
 * WP505（决策 1770 B）：本机服务出网时**认系统代理**——环境变量里的（`HTTPS_PROXY` 这类）和操作系统设置里的
 * （macOS「网络 → 代理」、Windows「设置 → 代理」）。
 *
 * 为什么要它：Node 自己的网络请求不看操作系统的代理设置。国内用户几乎都开着代理软件（「系统代理」模式），
 * 浏览器看得到 YouTube 的图，本机服务直连却取不到。桌面壳起服务进程时已经把**那一刻**的系统代理转成
 * `HTTP(S)_PROXY` 交过来（`apps/desktop/src/system-proxy.ts`，PAC 也由 Chromium 解析好了）；
 * 这里再补两件壳管不到的：
 *
 * 1. **现查**操作系统设置（每分钟最多查一次）：开机后才打开代理软件、换了端口，不用重启工坊；
 *    命令行起的服务（没有壳）也认。
 * 2. 候选按「环境变量 → 系统设置 → 直连」排好，**前一个连不上就试下一个**：壳交过来的代理后来关掉了，
 *    照样取得到（只在「连代理」那一步失败时换，连上了就不换）。
 *
 * 只认 HTTP / HTTPS 代理（走 CONNECT 隧道）；SOCKS 代理照实跳过（日志说一句）；自动配置脚本（PAC）这里不解析
 * ——壳起进程时已经按 PAC 解析好放进环境变量了。`NO_PROXY` 与系统的「不走代理的地址」照认。
 *
 * 纯解析函数（`parseScutilProxy` / `parseWindowsProxy` / `proxyFromEnv` / `bypassed`）都没有 IO，测试直接喂文本；
 * 读系统设置那一跳的命令执行器是注入的，测试给假的——从不在测试里读这台电脑的真设置。
 */
import { execFile } from 'node:child_process'

/** 一个可用的代理（只有 http: / https: 两种）。 */
export interface ProxyChoice {
  /** `http://h:p` 或 `https://h:p`（可带 `user:pass@`）。 */
  url: string
  /** 哪来的：环境变量 / 操作系统设置。日志与测试用。 */
  from: 'env' | 'system'
}

/** 操作系统设置里读到的代理（含「这些地址不走代理」）。 */
export interface SystemProxySetting {
  url: string
  bypass: readonly string[]
}

const PROXY_SCHEMES = new Set(['http:', 'https:'])

/** 规整一个代理地址：没写协议的当 http；只认 http / https；认不出回 `undefined`。 */
export function normalizeProxyUrl(raw: string | undefined): string | undefined {
  const s = raw?.trim()
  if (s === undefined || s === '') return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(s) ? s : `http://${s}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return undefined
  }
  if (!PROXY_SCHEMES.has(u.protocol) || u.hostname === '') return undefined
  return `${u.protocol}//${u.username === '' ? '' : `${u.username}${u.password === '' ? '' : `:${u.password}`}@`}${u.host}`
}

/** 代理地址里给日志看的那一截（不带账号密码）。 */
export function proxyLabel(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '(认不出的代理)'
  }
}

const envOf = (env: Readonly<Record<string, string | undefined>>, ...keys: string[]): string =>
  keys.map((k) => env[k] ?? '').find((v) => v.trim() !== '') ?? ''

/**
 * 一条主机名 / 地址是不是在「不走代理」名单里。名单写法照 `NO_PROXY`、macOS 的 ExceptionsList、
 * Windows 的 ProxyOverride：`*` 全部；`example.com` / `.example.com` 认它和它的子域名；`*.example.com`、`127.*`
 * 这种带星号的按通配；`<local>` 是不带点的主机名；`host:port` 只看主机那一截。
 */
export function bypassed(hostname: string, list: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  for (const raw of list) {
    let p = raw.trim().toLowerCase()
    if (p === '') continue
    if (p === '*') return true
    if (p === '<local>') {
      if (!host.includes('.')) return true
      continue
    }
    // 去掉端口（IPv6 方括号里的冒号不算）
    p = p.replace(/^\[([^\]]+)\](?::\d+)?$/u, '$1').replace(/^([^:]+):\d+$/u, '$1')
    if (p.includes('*')) {
      const re = new RegExp(
        `^${p
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
          .join('.*')}$`,
        'u',
      )
      if (re.test(host)) return true
      continue
    }
    const bare = p.replace(/^\./u, '')
    if (host === bare || host.endsWith(`.${bare}`)) return true
  }
  return false
}

const splitList = (s: string): string[] =>
  s
    .split(/[,;\s]+/u)
    .map((x) => x.trim())
    .filter((x) => x !== '')

/**
 * 环境变量里给这个 https 地址的代理：`HTTPS_PROXY` → `ALL_PROXY` → `HTTP_PROXY`（大小写都认），
 * 命中 `NO_PROXY` 就不给。SOCKS 那种认不出的回 `undefined`（由调用方决定要不要说一句）。
 */
export function proxyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  hostname: string,
): string | undefined {
  const raw = envOf(env, 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy')
  const picked = raw !== '' ? raw : envOf(env, 'HTTP_PROXY', 'http_proxy')
  if (picked === '') return undefined
  if (bypassed(hostname, splitList(envOf(env, 'NO_PROXY', 'no_proxy')))) return undefined
  return normalizeProxyUrl(picked)
}

/**
 * macOS `scutil --proxy` 的输出 → 代理。先认 HTTPS 那一组，没开再认 HTTP 那一组；
 * 只开了 SOCKS、或只开了自动配置（PAC）的回 `undefined`。
 */
export function parseScutilProxy(text: string): SystemProxySetting | undefined {
  const field = (k: string): string | undefined =>
    text.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+?)\\s*$`, 'mu'))?.[1]
  const pick = (prefix: 'HTTPS' | 'HTTP'): string | undefined => {
    if (field(`${prefix}Enable`) !== '1') return undefined
    const host = field(`${prefix}Proxy`)
    const port = field(`${prefix}Port`)
    if (host === undefined || host === '') return undefined
    return normalizeProxyUrl(`${host}${port === undefined || port === '' ? '' : `:${port}`}`)
  }
  const url = pick('HTTPS') ?? pick('HTTP')
  if (url === undefined) return undefined
  const block = text.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/u)?.[1] ?? ''
  const bypass = [...block.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gmu)].map((m) => m[1] ?? '')
  if (field('ExcludeSimpleHostnames') === '1') bypass.push('<local>')
  return { url, bypass: bypass.filter((b) => b !== '') }
}

/**
 * Windows `reg query "HKCU\…\Internet Settings"` 的输出 → 代理。`ProxyEnable` 是 1 才认；
 * `ProxyServer` 可能是 `h:p`，也可能是 `http=h:p;https=h:p;socks=h:p`（先认 https= 再认 http=，只有 socks= 的不认）。
 */
export function parseWindowsProxy(text: string): SystemProxySetting | undefined {
  const value = (name: string): string | undefined =>
    text.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'imu'))?.[1]
  const enabled = value('ProxyEnable')
  if (enabled === undefined || Number(enabled) !== 1) return undefined
  const server = value('ProxyServer')
  if (server === undefined || server === '') return undefined
  let url: string | undefined
  if (server.includes('=')) {
    const parts = new Map(
      server.split(';').map((p) => {
        const [k, v] = p.split('=')
        return [(k ?? '').trim().toLowerCase(), (v ?? '').trim()] as const
      }),
    )
    url = normalizeProxyUrl(parts.get('https')) ?? normalizeProxyUrl(parts.get('http'))
  } else url = normalizeProxyUrl(server)
  if (url === undefined) return undefined
  return { url, bypass: splitList(value('ProxyOverride') ?? '') }
}

/** 跑一条命令拿 stdout（读系统设置那一跳；测试给假的）。 */
export type CommandRunner = (cmd: string, args: readonly string[]) => Promise<string>

const execRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 2_000, windowsHide: true }, (err, stdout) => {
      if (err !== null) reject(err)
      else resolve(String(stdout))
    })
  })

export interface SystemProxyReaderOptions {
  platform?: NodeJS.Platform
  run?: CommandRunner
  /** 查一次管多久（毫秒）。默认 60 秒。 */
  ttlMs?: number
  now?: () => number
}

/**
 * 读操作系统设置里的代理（macOS / Windows；别的系统回 `undefined`）。查一次管 {@link SystemProxyReaderOptions.ttlMs}；
 * 命令跑不了、读不出就当没开。**永远不抛**。
 */
export function createSystemProxyReader(
  options: SystemProxyReaderOptions = {},
): () => Promise<SystemProxySetting | undefined> {
  const platform = options.platform ?? process.platform
  const run = options.run ?? execRunner
  const ttl = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  let cached: { at: number; value: SystemProxySetting | undefined } | undefined
  let pending: Promise<SystemProxySetting | undefined> | undefined
  const readOnce = async (): Promise<SystemProxySetting | undefined> => {
    try {
      if (platform === 'darwin') return parseScutilProxy(await run('scutil', ['--proxy']))
      if (platform === 'win32')
        return parseWindowsProxy(
          await run('reg', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
          ]),
        )
    } catch {
      // 读不到就当没开
    }
    return undefined
  }
  return async () => {
    if (cached !== undefined && now() - cached.at < ttl) return cached.value
    pending ??= readOnce().then((value) => {
      cached = { at: now(), value }
      pending = undefined
      return value
    })
    return pending
  }
}

/**
 * 去这个主机该试哪几个代理（按顺序；去重）：环境变量 → 系统设置。都没有 / 都被「不走代理」名单排除 = 空（直连）。
 * 直连那一步由调用方补在最后。
 */
export async function proxyCandidates(
  hostname: string,
  input: {
    env: Readonly<Record<string, string | undefined>>
    system?: (() => Promise<SystemProxySetting | undefined>) | undefined
  },
): Promise<ProxyChoice[]> {
  const out: ProxyChoice[] = []
  const fromEnv = proxyFromEnv(input.env, hostname)
  if (fromEnv !== undefined) out.push({ url: fromEnv, from: 'env' })
  const sys = await input.system?.()
  if (sys !== undefined && !bypassed(hostname, sys.bypass) && sys.url !== fromEnv)
    out.push({ url: sys.url, from: 'system' })
  return out
}
