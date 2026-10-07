/**
 * WP254（决策 100 / 123）：**下载源换国内源**——一键安装平台 CLI、下载连接器在国内网络常连不上
 * `registry.npmjs.org`。失败那一行多一个「换国内源再试」（npmmirror），点过就记住（**每台机一份**，
 * 存在 `<data>/tools/npm-registry.json`，不随品牌走），「设置 · 诊断」里能改回官方源。默认仍是官方源。
 *
 * 换源不换校验：
 * - 连接器的锁文件把 318 个包的 sha512 都钉死了，`npm ci` 从哪个源取都按它逐个校验（npm 的
 *   `replace-registry-host` 默认把锁里 `registry.npmjs.org` 的地址换成配置的源）；
 * - 下 npm 那一步（随包没带时）照样对钉死的 sha512；
 * - Shopify CLI 这种 `npm install <包>@latest` 没有锁文件，校验值来自源自己的元数据——npmmirror 是
 *   npmjs 的同步镜像，元数据里的 integrity 是原样同步的（报告里写明）。
 *
 * 选择的优先级：用户点过国内源 → 国内源；否则用户环境里有 `npm_config_registry`（公司内网源）→ 它；
 * 都没有 → 官方源（不写任何变量，npm 用它自己的默认）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type NpmRegistrySource = 'official' | 'npmmirror'

export const NPM_REGISTRY_URLS: Readonly<Record<NpmRegistrySource, string>> = {
  official: 'https://registry.npmjs.org',
  npmmirror: 'https://registry.npmmirror.com',
}

/** 记在哪（`<data>/tools/` 底下，与 npm 缓存、私有 CLI 同一处）。 */
export const NPM_REGISTRY_FILE = 'npm-registry.json'

/** 这一次装实际用哪个源。`custom` = 用户环境里自己设的 `npm_config_registry`。 */
export interface NpmRegistryChoice {
  source: NpmRegistrySource | 'custom'
  /** 要传给 npm 的地址；官方源且没有自定义时不传（npm 用它自己的默认）。 */
  url?: string
}

export interface NpmRegistryState {
  source: NpmRegistrySource
  updated_at?: string
  /** 用户环境里自己设了 `npm_config_registry`（只说有没有，不回地址）。 */
  env_override: boolean
}

export interface NpmRegistryPreference {
  get(): NpmRegistryState
  set(source: NpmRegistrySource): NpmRegistryState
  /** 这一次装用哪个源（见文件头的优先级）。 */
  choose(): NpmRegistryChoice
}

/** 失败是不是「网络类」（只有这一类才给「换国内源再试」）。 */
export function isNetworkFailure(code: string | undefined): boolean {
  return code === 'network' || code === 'timeout'
}

const envRegistry = (env: NodeJS.ProcessEnv): string | undefined => {
  const v = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
  return v === undefined || v.trim() === '' ? undefined : v.trim()
}

/**
 * 每台机一份。`toolsDir` 没有（内存档）就只记在内存里。读坏了 / 没写过 = 官方源。
 */
export function createNpmRegistryPreference(options: {
  toolsDir: string | undefined
  now: () => string
  env?: NodeJS.ProcessEnv
}): NpmRegistryPreference {
  const env = options.env ?? process.env
  const file =
    options.toolsDir === undefined ? undefined : join(options.toolsDir, NPM_REGISTRY_FILE)
  let memory: { source: NpmRegistrySource; updated_at?: string } = { source: 'official' }

  const read = (): { source: NpmRegistrySource; updated_at?: string } => {
    if (file === undefined || !existsSync(file)) return memory
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        source?: unknown
        updated_at?: unknown
      }
      const source: NpmRegistrySource = raw.source === 'npmmirror' ? 'npmmirror' : 'official'
      return {
        source,
        ...(typeof raw.updated_at === 'string' ? { updated_at: raw.updated_at } : {}),
      }
    } catch {
      return { source: 'official' }
    }
  }

  const state = (): NpmRegistryState => ({
    ...read(),
    env_override: envRegistry(env) !== undefined,
  })

  return {
    get: state,
    set(source) {
      const next = { source, updated_at: options.now() }
      if (file === undefined) memory = next
      else {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
        renameSync(tmp, file)
      }
      return state()
    },
    choose() {
      if (read().source === 'npmmirror')
        return { source: 'npmmirror', url: NPM_REGISTRY_URLS.npmmirror }
      const custom = envRegistry(env)
      return custom === undefined ? { source: 'official' } : { source: 'custom', url: custom }
    },
  }
}

/**
 * 把这一次的源写进子进程环境：选了源就覆盖 `npm_config_registry`（大写那个删掉，免得两个打架）；
 * 官方源且没自定义时一个字不动。
 */
export function withRegistry(
  childEnv: Record<string, string>,
  choice: NpmRegistryChoice,
): Record<string, string> {
  if (choice.url === undefined) return childEnv
  const out = { ...childEnv }
  delete out.NPM_CONFIG_REGISTRY
  out.npm_config_registry = choice.url
  return out
}
