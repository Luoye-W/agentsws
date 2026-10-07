/**
 * WP253：建站岗位「网页模板」端到端——**一个品牌一份**的主题工坊（服务端那一半）。
 *
 * 从「用户在建站岗位里说『用 agentsws-theme 给我搭个首页』」到「店里出现一个未发布主题可预览」，
 * 每一跳在这里接上：
 *
 * | 这一跳 | 从哪来 |
 * |---|---|
 * | CLI 在哪 | WP245 的私有安装（`<data>/tools/shopify-cli`，用我们自己的 node 起），系统全局的也认 |
 * | 登录态 | WP245 的一键登录（按品牌记一笔时间）；我们不读 CLI 的会话文件，凭据不经我们 |
 * | 店铺地址 | 本品牌的 Shopify 连接（客户端凭据经纪人记的那家店）；没连就用人在岗位页上填的那一个 |
 * | 工作目录 | `<data>/themes/<workspace>/<store>/`（与终端沙箱、变更审阅同一个地方） |
 * | 起底 | 开源主题 agentsws-theme 的**钉死版本**（commit + sha256），LICENSE 原样带上 |
 * | 发布 | **不在这里发**：只出 `publish_theme` 的审批卡；人批了执行器调 {@link SiteThemeAssembly.apply} |
 *
 * 三条纪律：
 *
 * 1. **AI 只拿得到受限的几件事**（`theme-tools.ts` 那九个工具），不是终端；写文件只限工作目录，
 *    以 agentsws-theme 起底时只许改 `custom-*` / templates / section 组 / locales / settings_data（主题自己的规矩）。
 * 2. **线上只有一条路会变**：审批过的 `publish_theme` → {@link SiteThemeAssembly.apply} → `theme publish`。
 * 3. **没装 / 没登录 / 没店铺地址不是异常**，是「还差哪一步」（{@link ThemeReadiness.next}）——岗位页与工具回话同一套话。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import type { SiteThemeStoreChoice, SiteThemeView } from '@agentsws/api'
import type {
  Clock,
  EffectiveConfig,
  Mandate,
  PlatformCliSpec,
  RunRequest,
  StagedChange,
} from '@agentsws/contracts'
import { themeWorkspaceRoot } from '@agentsws/dsh-adapter'
import { publishReadiness, type ThemeSummaryLike, themeLanes } from '@agentsws/site-core'
import type { ThemeNeed } from '@agentsws/stand-ins'
import type { BackendResult, StageInput, StageOutcome } from '@agentsws/txn'
import { extractTgz } from './npm-runtime.js'
import type { PlatformCliProbe } from './platform-cli.js'
import { normalizeShopDomain } from './shopify-broker.js'
import {
  createRunCli,
  createShopifyTheme,
  PASSTHROUGH_ENV,
  type PushedTheme,
  type RunCli,
  type ShopifyTheme,
  ShopifyThemeError,
  scrubCliOutput,
  type ThemeCheckResult,
  type ThemeSummary,
} from './shopify-theme.js'
import PIN from './theme-base-pin.json' with { type: 'json' }

/**
 * 起底用的开源主题——**钉子只在一处**：`theme-base-pin.json`（tag + commit + 起底包 sha256 + 许可证）。
 *
 * 换一个新 tag 只改那一个文件：`tag` / `version` / `commit` 照 GitHub 上那个 tag 指的 commit 抄，
 * `sha256` / `bytes` 对 `https://codeload.github.com/Luoye-W/agentsws-theme/tar.gz/<commit>` 现算
 * （按 commit 下，包里那一层目录是 `agentsws-theme-<commit>`；按 tag 下的包目录名不同、校验值也不同，不用它）。
 * `upstreams.yml` 的 `agentsws-theme` 一条写着同一个 tag / commit，`check-upstreams` 对账（docs/42）。
 *
 * 10-07：主题仓库与 package.json 都是 **MIT**（Luoye 决定 136：口径就是 MIT）。
 */
export const THEME_BASE: ThemeBasePin & { tag: string; bytes: number } = PIN

/** 起底包的钉子（测试 / 演示换成本地造的假主题包）。 */
export interface ThemeBasePin {
  repo: string
  version: string
  commit: string
  sha256: string
  license: string
  /** 上游的 release tag（只用来说清楚是哪一版；下载按 commit）。 */
  tag?: string
}

export const themeBaseUrl = (pin: ThemeBasePin = THEME_BASE): string =>
  `https://codeload.github.com/${pin.repo}/tar.gz/${pin.commit}`

/** 店铺主题认的几个目录（`theme push` 只传这些；AI 也只许写这些）。 */
export const THEME_DIRS = [
  'assets',
  'blocks',
  'config',
  'layout',
  'locales',
  'sections',
  'snippets',
  'templates',
] as const

/** 写得进去的文件类型。 */
const WRITABLE_EXT = /\.(liquid|json|css|js|svg|txt)$/i
/** 单个文件读 / 写的上限。 */
export const MAX_THEME_FILE_BYTES = 512 * 1024

/**
 * 以 agentsws-theme 起底时**只许改**的那几类（主题 AGENTS.md §2 第 1 条：核心文件升级时会被覆盖，
 * 店铺仓库里改了 verify 就不过）。`assets/app.css` 是构建产物，不在里面。
 */
export function baseWritable(rel: string): boolean {
  const name = rel.split('/').pop() ?? ''
  if (rel.startsWith('templates/') || rel.startsWith('locales/')) return true
  if (rel === 'config/settings_data.json') return true
  if (/^sections\/[^/]+\.json$/.test(rel)) return true
  if (/^(sections|blocks|snippets|assets)\/[^/]+$/.test(rel)) return /^_?custom-/.test(name)
  return false
}

export interface ThemePushRecord {
  theme_id: string
  theme_name: string
  preview_url?: string
  at: string
  changed_files: string[]
}

interface StoreState {
  base?: { repo: string; version: string; commit: string; license: string; at: string }
  /** 起底 / 拉下来那一刻每个主题文件的 sha256（算「改了哪些文件」用）。 */
  baseline?: Record<string, string>
  pushes: ThemePushRecord[]
}

/**
 * WP258：登录后在这个 Shopify 账号下找到的店（存在设置文件里，岗位页下拉框用；`need_login` 不给界面看原文）。
 */
export interface StoreLookupState {
  status: 'ok' | 'none' | 'failed'
  stores: SiteThemeStoreChoice[]
  checked_at: string
  message?: string
  /** 命令说的是「没登录 / 会话过期」——岗位页那一行回到「登录 Shopify」。 */
  need_login?: boolean
}

interface SettingsFile {
  version: 1
  /** 这个品牌建站用的店铺地址（没连店时用）。 */
  store?: string
  /**
   * WP258：这个地址是怎么来的。`manual` = 人手填的（**永远不被自动覆盖**；WP253 时存下的老地址没有这一格，
   * 一律当手填）；`cli` = 登录后自动取的（账号下只有一家，或与官网对上）；`picked` = 人从下拉框里选的。
   */
  store_by?: 'manual' | 'cli' | 'picked'
  /** WP258：最近一次找店的结果。 */
  lookup?: StoreLookupState
  stores: Record<string, StoreState>
}

/** 「还差哪一步」的那一份（岗位页与工具回话同一套判断；形状就是 `/v1/site/theme` 回的那一份）。 */
export type ThemeReadiness = SiteThemeView

export type ThemeFetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

export interface SiteThemeOptions {
  workspace_id: string
  clock: Clock
  /** 数据根目录（主题工作副本在 `<dataDir>/themes/<workspace>/<store>/`）。 */
  dataDir: string
  /** 设置文件（店铺地址、起底版本、推过哪些副本）；不给 = 只在内存里。 */
  settingsFile?: string
  /** 这个品牌的平台的 CLI 那一行（不是 Shopify 的品牌 = undefined）。 */
  cliSpec(): PlatformCliSpec | undefined
  probe(spec: PlatformCliSpec, fresh?: boolean): Promise<PlatformCliProbe>
  /** WP245 一键登录按品牌记的那一笔（登好了 = true）。 */
  loggedIn(cli_id: string): boolean
  /** WP253：这个品牌那一份 CLI 会话的环境变量（一个品牌一份会话，见 `platform-cli-session.ts`）。 */
  sessionEnv?(cli_id: string): Record<string, string> | undefined
  /** 怎么起 CLI（私有安装 → `<node> <入口>`；系统里的 → `shopify`）。 */
  invocation(spec: PlatformCliSpec): { command: string; prefix: readonly string[] }
  /** 这个品牌接管的店（连接页那一条）。 */
  connectedShops(): string[]
  /** WP258：品牌档案里官网读到的那个 `xxx.myshopify.com`（找到好几家店时拿它对一下）。 */
  siteStore?(): string | undefined
  env?: NodeJS.ProcessEnv
  /** 测试 / 演示注入假 CLI。 */
  run?: RunCli
  /** 下起底包（测试 / 演示注入）；不给 = 全局 fetch。 */
  fetch?: ThemeFetch
  /** 起底钉哪一版（测试 / 演示注入假包的钉子）；不给 = {@link THEME_BASE}。 */
  base?: ThemeBasePin
  /**
   * 随安装包带的起底包所在目录（`<repo名>-<commit>.tgz`；Luoye 决定 140 的兜底）。GitHub 下不动时用它，
   * 校验值与 {@link THEME_BASE} 同一个。不给 = 只从 GitHub 下。服务进程经 `AGENTSWS_THEME_BASE_DIR` 拿。
   */
  localBaseDir?: string
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  effectiveConfig(assignment_id: string): EffectiveConfig
  /** 「预览好了」进事项时间线（有事项时）。 */
  notePreview?(matter_id: string, input: { text: string; url: string; label: string }): void
  appendEvent?(type: string, payload: Record<string, unknown>): void
}

export class SiteThemeError extends Error {
  constructor(
    readonly code: 'needs' | 'invalid_input' | 'outside' | 'integrity' | 'network' | 'cli',
    message: string,
    readonly need?: ThemeNeed,
  ) {
    super(message)
    this.name = 'SiteThemeError'
  }
}

/** 每一步差什么时说的那句话（岗位页上有对应的一键按钮）。 */
export const NEED_TEXT: Readonly<Record<ThemeNeed, string>> = {
  install_cli: '这台电脑还没装 Shopify CLI。请到建站岗位页点「一键安装」，装好再让我接着做。',
  node: 'Shopify CLI 要的 Node 版本不够。请到建站岗位页点「一键安装」装一份工作台自己用的。',
  login: '还没登录 Shopify。请到建站岗位页点「登录 Shopify」，在浏览器里登好再让我接着做。',
  store:
    '还不知道是哪家店。请到建站岗位页填上店铺地址（xxx.myshopify.com），或者在连接页把店接上。',
}

/** WP258：找过店之后「还不知道是哪家店」的两种更具体的说法。 */
export const STORE_LOOKUP_TEXT = {
  none: '这个 Shopify 账号下没有店铺。请到建站岗位页换个账号登录，或者先去 Shopify 开店。',
  pick: '这个 Shopify 账号下有好几家店。请到建站岗位页选一家，我再接着做。',
  failed: '没能从 Shopify 找到你的店铺，可以在建站岗位页手动填一下店铺地址（xxx.myshopify.com）。',
} as const

export interface SiteThemeAssembly {
  readiness(opts?: { fresh?: boolean }): Promise<ThemeReadiness>
  /** `source: 'list'`（WP258）= 从登录账号下找到的店里选的（必须在清单里）；不给 = 人手填的。 */
  setStore(raw: string, opts?: { source?: 'manual' | 'list' | undefined }): Promise<ThemeReadiness>
  /**
   * WP258：现找一次这个账号下的店（`relogin` = 刚登录 / 换了账号：自动取的、选的那家不在新账号下就清掉）。
   * 不是 Shopify / 没装 / 没登录 / CLI 不会找店 → 什么都不做。
   */
  refreshStores(opts?: { relogin?: boolean }): Promise<StoreLookupState | undefined>
  initFromBase(input: { replace?: boolean }): Promise<{
    base: { repo: string; version: string; commit: string; license: string }
    files: number
    moved_aside: boolean
  }>
  list(): Promise<ThemeSummary[]>
  pull(input: { theme_id?: string }): Promise<{ files: number }>
  check(): Promise<ThemeCheckResult>
  files(dir?: string): Promise<{ files: string[]; truncated: boolean }>
  readFile(path: string): Promise<{ path: string; content: string }>
  writeFile(
    path: string,
    content: string,
  ): Promise<{ path: string; bytes: number; created: boolean }>
  push(input: { name: string; request?: RunRequest }): Promise<ThemePushRecord>
  proposePublish(input: { theme_id: string; request: RunRequest }): Promise<{
    status: 'staged' | 'blocked'
    message: string
    change_id?: string
    approval_item_id?: string
  }>
  /** 执行器批过的 `publish_theme`（不是这个品牌的 / 不是这一类回 undefined）。 */
  apply(change: StagedChange): Promise<BackendResult | undefined>
}

/** WP258：找店命令没跑成（`detail` 是抹过令牌的输出，只用来判断是哪一种失败，不给人看）。 */
class StoreLookupFailure extends Error {
  constructor(readonly detail: string) {
    super('store lookup failed')
    this.name = 'StoreLookupFailure'
  }
}

/** CLI 说的是「没登录 / 会话过期」。 */
const LOGIN_HINT =
  /not logged in|log ?in again|auth login|session (?:has )?expired|unauthori[sz]ed|\b401\b|reauthenticat/i

/** `store list --json` 的一行 → 下拉框的一行（不是 `xxx.myshopify.com` 的不要）。 */
export function storeChoiceOf(row: unknown, orgName?: string): SiteThemeStoreChoice | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const r = row as Record<string, unknown>
  if (typeof r.store !== 'string') return undefined
  let store: string
  try {
    store = normalizeShopDomain(r.store)
  } catch {
    return undefined
  }
  if (!store.endsWith('.myshopify.com')) return undefined
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : undefined
  const name = text(r.name)
  const plan = text(r.plan)
  const organization = text(r.organizationName) ?? text(orgName)
  return {
    store,
    ...(name === undefined ? {} : { name }),
    ...(plan === undefined ? {} : { plan }),
    ...(organization === undefined ? {} : { organization }),
  }
}

/** `organization list --json` 的一行 → 组织 id（只认纯数字，或 `gid://shopify/Organization/<数字>`）。 */
function orgOf(row: unknown): { id: string; name?: string } | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const r = row as Record<string, unknown>
  const raw = typeof r.id === 'number' ? String(r.id) : typeof r.id === 'string' ? r.id : undefined
  const gid = typeof r.gid === 'string' ? /\/(\d+)$/.exec(r.gid)?.[1] : undefined
  const id = raw !== undefined && /^\d{1,20}$/.test(raw) ? raw : gid
  if (id === undefined) return undefined
  return { id, ...(typeof r.name === 'string' ? { name: r.name } : {}) }
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/** 主题文件（只看主题那几个目录，跳过点开头的）。 */
function themeFiles(root: string): string[] {
  const out: string[] = []
  for (const top of THEME_DIRS) {
    const dir = join(root, top)
    if (!existsSync(dir)) continue
    const walk = (d: string): void => {
      for (const name of readdirSync(d).sort()) {
        if (name.startsWith('.')) continue
        const full = join(d, name)
        const st = lstatSync(full)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) walk(full)
        else if (st.isFile()) out.push(relative(root, full).split(sep).join('/'))
      }
    }
    walk(dir)
  }
  return out
}

function manifestOf(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of themeFiles(root)) out[rel] = sha256(readFileSync(join(root, rel)))
  return out
}

/** 相对基线改了哪些（新增 / 改动 / 删除都算），按路径排序。 */
export function changedFiles(
  baseline: Record<string, string> | undefined,
  now: Record<string, string>,
): string[] {
  if (baseline === undefined) return Object.keys(now).sort()
  const out = new Set<string>()
  for (const [rel, hash] of Object.entries(now)) if (baseline[rel] !== hash) out.add(rel)
  for (const rel of Object.keys(baseline)) if (now[rel] === undefined) out.add(rel)
  return [...out].sort()
}

/**
 * AI 给的相对路径 → 工作目录里的绝对路径。出不去：绝对路径、`..`、盘符、点开头的目录一律拒；
 * 已有的路径再按真实路径（symlink 解开之后）判一次是不是还在根里面。
 */
export function resolveInside(root: string, raw: string): { abs: string; rel: string } {
  const clean = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (clean === '' || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.includes('\0'))
    throw new SiteThemeError('outside', `路径「${raw}」不在主题工作目录里（要给相对路径）`)
  const parts = clean.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..' || p.startsWith('.')))
    throw new SiteThemeError('outside', `路径「${raw}」出了主题工作目录，或者是隐藏目录，不许碰`)
  const rel = parts.join('/')
  const abs = normalize(join(root, ...parts))
  const realRoot = realpathSync(root)
  // 一路往上找到第一个存在的祖先，按真实路径判（防 symlink 把写操作带出去）
  let probe = abs
  while (!existsSync(probe) && probe !== root) probe = dirname(probe)
  const realProbe = realpathSync(probe)
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep))
    throw new SiteThemeError('outside', `路径「${raw}」指到了主题工作目录外面，不许碰`)
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink())
    throw new SiteThemeError('outside', `「${raw}」是一个链接，不许碰`)
  return { abs, rel }
}

export function createSiteTheme(options: SiteThemeOptions): SiteThemeAssembly {
  const ws = options.workspace_id
  const pin: ThemeBasePin = options.base ?? THEME_BASE
  const now = (): string => options.clock.now()
  const emit = (type: string, payload: Record<string, unknown>): void =>
    options.appendEvent?.(type, payload)

  // ── 设置文件 ─────────────────────────────────────────────────────────
  let settings: SettingsFile = { version: 1, stores: {} }
  if (options.settingsFile !== undefined && existsSync(options.settingsFile)) {
    try {
      const raw = JSON.parse(readFileSync(options.settingsFile, 'utf8')) as Partial<SettingsFile>
      const by = raw.store_by
      const lookup = raw.lookup
      settings = {
        version: 1,
        ...(typeof raw.store === 'string' ? { store: raw.store } : {}),
        ...(by === 'manual' || by === 'cli' || by === 'picked' ? { store_by: by } : {}),
        ...(lookup !== undefined &&
        typeof lookup === 'object' &&
        Array.isArray(lookup.stores) &&
        typeof lookup.checked_at === 'string'
          ? { lookup }
          : {}),
        stores: raw.stores !== undefined && typeof raw.stores === 'object' ? raw.stores : {},
      }
    } catch {
      // 坏文件当没有：最坏是岗位页上再填一次店铺地址
    }
  }
  const save = (): void => {
    if (options.settingsFile === undefined) return
    mkdirSync(dirname(options.settingsFile), { recursive: true })
    writeFileSync(options.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  }
  const stateOf = (shop: string): StoreState => {
    const found = settings.stores[shop]
    if (found !== undefined) return found
    const fresh: StoreState = { pushes: [] }
    settings.stores[shop] = fresh
    return fresh
  }

  // ── 店铺地址 ─────────────────────────────────────────────────────────
  /** WP258：存下的地址是怎么来的（WP253 存的老地址没有 `store_by`，当手填）。 */
  const storeBy = (): SettingsFile['store_by'] =>
    settings.store === undefined ? undefined : (settings.store_by ?? 'manual')

  const storeOf = (): { store: string; source: 'connection' | 'manual' | 'cli' } | undefined => {
    const shops = options.connectedShops()
    if (shops.length > 0) {
      const manual = settings.store
      const pick = manual !== undefined && shops.includes(manual) ? manual : shops[0]
      return pick === undefined ? undefined : { store: pick, source: 'connection' }
    }
    if (settings.store === undefined) return undefined
    return { store: settings.store, source: storeBy() === 'manual' ? 'manual' : 'cli' }
  }

  const rootOf = (shop: string): string => {
    const dir = themeWorkspaceRoot(options.dataDir, ws, shop)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const cliFor = (spec: PlatformCliSpec): ShopifyTheme =>
    createShopifyTheme({
      clock: options.clock,
      workdir: options.dataDir,
      workspaceDir: rootOf,
      ...(options.env === undefined ? {} : { env: options.env }),
      // 凭据只在 CLI 自己的会话里（一键登录）；我们这一侧一个令牌都不拿
      tokenFor: () => undefined,
      sessionLogin: () => options.loggedIn(spec.id),
      sessionEnv: () => options.sessionEnv?.(spec.id),
      cli: () => options.invocation(spec),
      ...(options.run === undefined ? {} : { run: options.run }),
      appendEvent: (type, payload) => emit(type, { ...payload, workspace_id: ws }),
    })

  // ── WP258：登录后自动找店 ───────────────────────────────────────────

  /** 找店那两条命令的环境：与主题命令同一个白名单 + 本品牌那一份会话；不带店铺、不带任何令牌。 */
  const lookupEnv = (spec: PlatformCliSpec): Record<string, string> => {
    const env = options.env ?? process.env
    const out: Record<string, string> = {}
    for (const key of PASSTHROUGH_ENV) {
      const value = env[key]
      if (typeof value === 'string') out[key] = value
    }
    // 非交互：CLI 要问「选哪个组织」时直接报错，不会卡住等输入
    out.CI = '1'
    Object.assign(out, spec.telemetry_off_env)
    Object.assign(out, options.sessionEnv?.(spec.id) ?? {})
    return out
  }

  /** 跑一条找店命令；非零退出码 → 抛（带抹过的输出，只用来判断是哪一种失败）。 */
  const lookupRun = async (spec: PlatformCliSpec, args: readonly string[]): Promise<unknown> => {
    const run = options.run ?? createRunCli(() => options.invocation(spec))
    const cwd = join(options.dataDir, 'theme-work', ws)
    mkdirSync(cwd, { recursive: true })
    const result = await run(args, { cwd, env: lookupEnv(spec), timeoutMs: 90_000 })
    emit('site_theme.store_lookup_command', {
      workspace_id: ws,
      command: args.slice(0, 2).join(' '),
      exit_code: result.code,
    })
    if (result.code !== 0)
      throw new StoreLookupFailure(scrubCliOutput(`${result.stdout}\n${result.stderr}`))
    const at = result.stdout.search(/[[{]/)
    if (at < 0) throw new StoreLookupFailure('no json')
    try {
      return JSON.parse(result.stdout.slice(at)) as unknown
    } catch {
      throw new StoreLookupFailure('bad json')
    }
  }

  /**
   * 这个账号下有哪几家店：先 `store list --json`（只有一个组织时 CLI 自己选，一条命令就够）；
   * CLI 说「好几个组织、非交互要给组织 id」再 `organization list --json`，逐个组织列（组织 id 只认纯数字）。
   */
  const lookupStores = async (spec: PlatformCliSpec): Promise<StoreLookupState> => {
    const how = spec.store_lookup
    const at = now()
    if (how === undefined) return { status: 'failed', stores: [], checked_at: at }
    const found = new Map<string, SiteThemeStoreChoice>()
    let unresolved = false
    const collect = (out: unknown, orgName?: string): void => {
      const o = (typeof out === 'object' && out !== null ? out : {}) as Record<string, unknown>
      if (typeof o.notice === 'string' && /resolve a shopify account/i.test(o.notice))
        unresolved = true
      const org = o.organization as { name?: unknown } | undefined
      for (const row of Array.isArray(o.stores) ? o.stores : []) {
        const choice = storeChoiceOf(row, typeof org?.name === 'string' ? org.name : orgName)
        if (choice !== undefined && !found.has(choice.store)) found.set(choice.store, choice)
      }
    }
    try {
      try {
        collect(await lookupRun(spec, how.stores_args))
      } catch (e) {
        if (!(e instanceof StoreLookupFailure) || !/organization[ -]id/i.test(e.detail)) throw e
        // 好几个组织：先列组织，再逐个组织列店（最多 10 个组织）
        const orgsOut = (await lookupRun(spec, how.organizations_args)) as {
          organizations?: unknown
        }
        const orgs = (Array.isArray(orgsOut?.organizations) ? orgsOut.organizations : [])
          .map(orgOf)
          .filter((x): x is { id: string; name?: string } => x !== undefined)
          .slice(0, 10)
        if (orgs.length === 0) throw e
        for (const org of orgs)
          collect(
            await lookupRun(spec, [...how.stores_args, how.organization_flag, org.id]),
            org.name,
          )
      }
    } catch (e) {
      if (e instanceof ShopifyThemeError && e.code === 'cli_missing')
        return { status: 'failed', stores: [], checked_at: at, message: NEED_TEXT.install_cli }
      const detail = e instanceof StoreLookupFailure ? e.detail : ''
      if (LOGIN_HINT.test(detail))
        return {
          status: 'failed',
          stores: [],
          checked_at: at,
          message: NEED_TEXT.login,
          need_login: true,
        }
      return { status: 'failed', stores: [], checked_at: at, message: STORE_LOOKUP_TEXT.failed }
    }
    if (found.size === 0 && unresolved)
      return {
        status: 'failed',
        stores: [],
        checked_at: at,
        message: NEED_TEXT.login,
        need_login: true,
      }
    const stores = [...found.values()].sort((a, b) => a.store.localeCompare(b.store))
    return stores.length === 0
      ? { status: 'none', stores: [], checked_at: at }
      : { status: 'ok', stores, checked_at: at }
  }

  /**
   * 找完之后定店：**手填的永远不动**；自动取的 / 人选的那家不在这个账号下了（换了账号）就清掉；
   * 只有一家 → 就它；好几家 → 与官网读到的那个对上就默认选它，对不上就等人在下拉框里选。
   */
  const settle = (lookup: StoreLookupState): void => {
    settings.lookup = lookup
    const by = storeBy()
    if (by === 'manual') return
    if (by !== undefined) {
      if (lookup.status === 'failed') return
      if (lookup.stores.some((s) => s.store === settings.store)) return
      delete settings.store
      delete settings.store_by
    }
    if (lookup.status !== 'ok') return
    const site = options.siteStore?.()
    const match = site === undefined ? undefined : lookup.stores.find((s) => s.store === site)
    const pick = lookup.stores.length === 1 ? lookup.stores[0] : match
    if (pick === undefined) return
    settings.store = pick.store
    settings.store_by = 'cli'
    emit('site_theme.store_auto', {
      workspace_id: ws,
      stores: lookup.stores.length,
      matched_site: match !== undefined,
    })
  }

  let lookupInFlight: Promise<StoreLookupState | undefined> | undefined
  const refreshStores = (
    opts: { relogin?: boolean } = {},
  ): Promise<StoreLookupState | undefined> => {
    if (lookupInFlight !== undefined) return lookupInFlight
    const spec = options.cliSpec()
    if (spec?.store_lookup === undefined) return Promise.resolve(undefined)
    if (options.connectedShops().length > 0) return Promise.resolve(undefined)
    if (!options.loggedIn(spec.id)) return Promise.resolve(undefined)
    // 手填过的永远以手填为准（不去找，也就不会被覆盖）
    if (storeBy() === 'manual') return Promise.resolve(undefined)
    lookupInFlight = (async () => {
      const probe = await options.probe(spec)
      if (!probe.installed || !probe.node_ok) return undefined
      const lookup = await lookupStores(spec)
      settle(lookup)
      save()
      emit('site_theme.store_lookup', {
        workspace_id: ws,
        status: lookup.status,
        stores: lookup.stores.length,
        ...(lookup.need_login === true ? { need_login: true } : {}),
        ...(opts.relogin === true ? { after_login: true } : {}),
      })
      return lookup
    })().finally(() => {
      lookupInFlight = undefined
    })
    return lookupInFlight
  }

  /** 什么时候顺手找一次：没找过、`fresh`、或上次没找成且过了 5 分钟。手填过 / 连了店就不找。 */
  const shouldLookup = (fresh: boolean): boolean => {
    if (storeBy() === 'manual') return false
    const last = settings.lookup
    if (last === undefined) return true
    if (fresh) return true
    return last.status === 'failed' && Date.parse(now()) - Date.parse(last.checked_at) > 5 * 60_000
  }

  const readiness = async (opts: { fresh?: boolean } = {}): Promise<ThemeReadiness> => {
    const spec = options.cliSpec()
    const probe = spec === undefined ? undefined : await options.probe(spec, opts.fresh === true)
    const cliOk = probe?.installed === true && probe.node_ok
    // WP258：登好了、没连店、没手填 → 顺手找一次这个账号下的店（找过就用存下的那一份）
    if (
      spec?.store_lookup !== undefined &&
      cliOk &&
      options.connectedShops().length === 0 &&
      options.loggedIn(spec.id) &&
      (lookupInFlight !== undefined || shouldLookup(opts.fresh === true))
    )
      await refreshStores()
    const store = storeOf()
    const state = store === undefined ? undefined : settings.stores[store.store]
    const files =
      store === undefined || !existsSync(themeWorkspaceRoot(options.dataDir, ws, store.store))
        ? 0
        : themeFiles(themeWorkspaceRoot(options.dataDir, ws, store.store)).length
    const lookup =
      store?.source === 'connection' || store?.source === 'manual' ? undefined : settings.lookup
    const site = options.siteStore?.()
    const base = {
      workspace: { files, ...(state?.base === undefined ? {} : { base: state.base }) },
      ...(store === undefined ? {} : { store: store.store, store_source: store.source }),
      ...(state?.pushes.length ? { last_push: state.pushes[state.pushes.length - 1] } : {}),
      ...(lookup === undefined
        ? {}
        : {
            store_lookup: {
              status: lookup.status,
              stores: lookup.stores,
              checked_at: lookup.checked_at,
              ...(lookup.message === undefined ? {} : { message: lookup.message }),
            },
          }),
      ...(site === undefined ? {} : { site_store: site }),
    }
    if (spec === undefined || probe === undefined)
      return { applicable: false, cli: 'missing', ...base }
    const cli: ThemeReadiness['cli'] = !probe.installed
      ? 'missing'
      : !probe.node_ok
        ? 'node_old'
        : !options.loggedIn(spec.id)
          ? 'needs_login'
          : 'ready'
    const next: ThemeNeed | undefined =
      cli === 'missing'
        ? 'install_cli'
        : cli === 'node_old'
          ? 'node'
          : cli === 'needs_login'
            ? 'login'
            : store !== undefined
              ? undefined
              : // WP258：找店时 CLI 说会话过期 → 回到「登录 Shopify」
                lookup?.need_login === true
                ? 'login'
                : 'store'
    return {
      applicable: true,
      cli,
      ...(probe.source === undefined ? {} : { cli_source: probe.source }),
      ...base,
      ...(next === undefined ? {} : { next }),
    }
  }

  /**
   * 要动手之前先问一句还差什么。`remote` = 要碰店铺（列 / 拉 / 推 / 发布）：CLI、登录、店铺都得有；
   * `local` = 只在本机（检查要 CLI 但不要登录）；`files` = 只要知道是哪家店（目录按店分）。
   */
  const need = async (
    level: 'remote' | 'local' | 'files',
  ): Promise<{ shop: string; spec: PlatformCliSpec | undefined }> => {
    const r = await readiness()
    if (!r.applicable && level !== 'files')
      throw new SiteThemeError('needs', '这个品牌的建站平台不是 Shopify，主题工具用不了。')
    if (level !== 'files' && (r.cli === 'missing' || r.cli === 'node_old'))
      throw new SiteThemeError(
        'needs',
        NEED_TEXT[r.cli === 'missing' ? 'install_cli' : 'node'],
        r.cli === 'missing' ? 'install_cli' : 'node',
      )
    if (level === 'remote' && (r.cli === 'needs_login' || r.next === 'login'))
      throw new SiteThemeError('needs', NEED_TEXT.login, 'login')
    if (r.store === undefined) {
      // WP258：找过店的，照找到的情况说（没有店 / 好几家要选 / 没找成）
      const found = r.store_lookup
      const text =
        found?.status === 'none'
          ? STORE_LOOKUP_TEXT.none
          : found?.status === 'ok'
            ? STORE_LOOKUP_TEXT.pick
            : found?.status === 'failed'
              ? STORE_LOOKUP_TEXT.failed
              : NEED_TEXT.store
      throw new SiteThemeError('needs', text, 'store')
    }
    return { shop: r.store, spec: options.cliSpec() }
  }

  const theme = (spec: PlatformCliSpec | undefined): ShopifyTheme => {
    if (spec === undefined) throw new SiteThemeError('needs', NEED_TEXT.install_cli, 'install_cli')
    return cliFor(spec)
  }

  /** CLI 的错误 → 人话（原文只在 detail 里，已经抹过令牌）。 */
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ShopifyThemeError) {
        if (e.code === 'cli_missing')
          throw new SiteThemeError('needs', NEED_TEXT.install_cli, 'install_cli')
        const text = `${e.message}${e.detail === undefined ? '' : `\n${e.detail}`}`
        if (/log ?in|logged|auth|session|unauthori[sz]ed|401/i.test(e.detail ?? ''))
          throw new SiteThemeError('needs', NEED_TEXT.login, 'login')
        throw new SiteThemeError(e.code === 'invalid_input' ? 'invalid_input' : 'cli', text)
      }
      throw e
    }
  }

  /** 列主题，并把没有预览链接的副本补成 `https://<店>/?preview_theme_id=<id>`（Shopify 的预览链接就长这样）。 */
  const listWithPreview = async (shop: string, t: ShopifyTheme): Promise<ThemeSummary[]> => {
    const rows = await wrap(() => t.list(shop))
    const pushes = stateOf(shop).pushes
    return rows.map((row) => {
      if (row.preview_url !== undefined) return row
      const pushed = pushes.find((p) => p.theme_id === row.id)?.preview_url
      return { ...row, preview_url: pushed ?? `https://${shop}/?preview_theme_id=${row.id}` }
    })
  }

  /**
   * 起底包：先从 GitHub（codeload，按 commit）下；下不来、或下来的校验不对，就用随安装包带的那一份
   * （`localBaseDir/<repo名>-<commit>.tgz`，Luoye 决定 140 的兜底）——两份认的是同一个 sha256。
   */
  const downloadBase = async (): Promise<Uint8Array> => {
    const fetchImpl: ThemeFetch =
      options.fetch ?? ((url) => fetch(url, { signal: AbortSignal.timeout(120_000) }))
    let reason: string
    let tampered = false
    try {
      const res = await fetchImpl(themeBaseUrl(pin))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (sha256(bytes) === pin.sha256) return bytes
      tampered = true
      reason = '校验没过'
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e)
    }
    const local = localBaseFile()
    if (local !== undefined && existsSync(local)) {
      const bytes = new Uint8Array(readFileSync(local))
      if (sha256(bytes) === pin.sha256) {
        emit('site_theme.base_local', {
          workspace_id: ws,
          reason: tampered ? 'integrity' : 'network',
        })
        return bytes
      }
    }
    if (tampered)
      throw new SiteThemeError(
        'integrity',
        '下来的开源主题和钉死的那一版对不上（校验没过），一个文件都没放。',
      )
    throw new SiteThemeError(
      'network',
      `下不来开源主题 agentsws-theme（${reason}）。看一下网络，再让我试一次。`,
    )
  }
  const localBaseFile = (): string | undefined =>
    options.localBaseDir === undefined
      ? undefined
      : join(options.localBaseDir, `${pin.repo.split('/')[1]}-${pin.commit}.tgz`)

  return {
    readiness,

    async setStore(raw, opts = {}) {
      let shop: string
      try {
        shop = normalizeShopDomain(raw)
      } catch (e) {
        throw new SiteThemeError('invalid_input', e instanceof Error ? e.message : '店铺地址看不懂')
      }
      const fromList = opts.source === 'list'
      // WP258：从下拉框选的必须是这个账号下找到的那几家之一
      if (fromList && settings.lookup?.stores.some((s) => s.store === shop) !== true)
        throw new SiteThemeError(
          'invalid_input',
          '这家店不在登录账号下找到的店里。换一家，或者选「都不是？手动填」。',
        )
      settings.store = shop
      settings.store_by = fromList ? 'picked' : 'manual'
      save()
      emit('site_theme.store_set', { workspace_id: ws, source: fromList ? 'list' : 'manual' })
      return readiness()
    },

    refreshStores,

    async initFromBase({ replace }) {
      const { shop } = await need('files')
      const root = rootOf(shop)
      const existing = readdirSync(root)
      let moved = false
      if (existing.length > 0 && replace !== true)
        throw new SiteThemeError(
          'invalid_input',
          '主题工作目录里已经有东西了，没覆盖。要从 agentsws-theme 重新起底，带 replace=true（旧的会挪到一边，不删）。',
        )
      // 先下好、校验过，再动工作目录（下不来时原来的东西一个字节不动）
      const bytes = await downloadBase()
      if (existing.length > 0) {
        // 旧的挪到工作区外面的「旧版」目录（不删；变更审阅只看 themes/<ws>/ 下的店铺目录）
        const aside = join(
          options.dataDir,
          'theme-work',
          ws,
          'aside',
          `${shop}-${Date.parse(now())}`,
        )
        mkdirSync(dirname(aside), { recursive: true })
        renameSync(root, aside)
        mkdirSync(root, { recursive: true })
        moved = true
      }
      const staging = join(options.dataDir, 'theme-work', ws, 'staging', String(Date.parse(now())))
      mkdirSync(staging, { recursive: true })
      try {
        extractTgz(bytes, staging)
        const top = join(staging, `${pin.repo.split('/')[1]}-${pin.commit}`)
        if (!existsSync(top) || !statSync(top).isDirectory())
          throw new SiteThemeError('integrity', '开源主题的包里没有预期的那一层目录')
        for (const name of readdirSync(top)) renameSync(join(top, name), join(root, name))
      } finally {
        // 只删这一次自己建的暂存目录
        rmSync(staging, { recursive: true, force: true })
      }
      const state = stateOf(shop)
      state.base = {
        repo: pin.repo,
        version: pin.version,
        commit: pin.commit,
        license: pin.license,
        at: now(),
      }
      state.baseline = manifestOf(root)
      save()
      emit('site_theme.initialized', { workspace_id: ws, version: pin.version })
      return {
        base: {
          repo: pin.repo,
          version: pin.version,
          commit: pin.commit,
          license: pin.license,
        },
        files: Object.keys(state.baseline).length,
        moved_aside: moved,
      }
    },

    async list() {
      const { shop, spec } = await need('remote')
      return listWithPreview(shop, theme(spec))
    },

    async pull({ theme_id }) {
      const { shop, spec } = await need('remote')
      await wrap(() => theme(spec).pull({ shop, ...(theme_id === undefined ? {} : { theme_id }) }))
      const state = stateOf(shop)
      state.baseline = manifestOf(rootOf(shop))
      save()
      return { files: Object.keys(state.baseline).length }
    },

    async check() {
      const { shop, spec } = await need('local')
      return wrap(() => theme(spec).check({ shop }))
    },

    async files(dir) {
      const { shop } = await need('files')
      const root = rootOf(shop)
      const prefix =
        dir === undefined || dir.trim() === '' ? '' : `${resolveInside(root, dir).rel}/`
      const all = themeFiles(root).filter((f) => f.startsWith(prefix))
      // 根目录下给 AI 看的说明文件也列上（AGENTS.md / CATALOG.json / LICENSE …）
      const top =
        prefix === ''
          ? readdirSync(root)
              .filter((n) => !n.startsWith('.') && statSync(join(root, n)).isFile())
              .sort()
          : []
      const files = [...top, ...all]
      return { files: files.slice(0, 500), truncated: files.length > 500 }
    },

    async readFile(path) {
      const { shop } = await need('files')
      const { abs, rel } = resolveInside(rootOf(shop), path)
      if (!existsSync(abs) || !statSync(abs).isFile())
        throw new SiteThemeError('invalid_input', `主题工作目录里没有「${rel}」`)
      if (statSync(abs).size > MAX_THEME_FILE_BYTES)
        throw new SiteThemeError('invalid_input', `「${rel}」太大了（超过 512 KB），不读`)
      return { path: rel, content: readFileSync(abs, 'utf8') }
    },

    async writeFile(path, content) {
      const { shop } = await need('files')
      const root = rootOf(shop)
      const { abs, rel } = resolveInside(root, path)
      const top = rel.split('/')[0] ?? ''
      if (!(THEME_DIRS as readonly string[]).includes(top) || !rel.includes('/'))
        throw new SiteThemeError(
          'outside',
          `只许写主题那几个目录（${THEME_DIRS.join(' / ')}）里的文件，「${rel}」不在里面`,
        )
      if (!WRITABLE_EXT.test(rel))
        throw new SiteThemeError(
          'invalid_input',
          `「${rel}」不是主题文件（liquid / json / css / js / svg）`,
        )
      if (stateOf(shop).base !== undefined && !baseWritable(rel))
        throw new SiteThemeError(
          'invalid_input',
          `「${rel}」是 agentsws-theme 的核心文件，升级会被覆盖，不许改。新东西写成 custom-* 文件，或改 templates / locales / settings_data.json。`,
        )
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > MAX_THEME_FILE_BYTES)
        throw new SiteThemeError('invalid_input', `内容太大了（超过 512 KB）`)
      const created = !existsSync(abs)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
      emit('site_theme.file_written', { workspace_id: ws, path: rel, created })
      return { path: rel, bytes, created }
    },

    async push({ name, request }) {
      const trimmed = name.trim()
      if (trimmed === '')
        throw new SiteThemeError('invalid_input', '副本得有个名字，人在后台要认得出它')
      const { shop, spec } = await need('remote')
      const t = theme(spec)
      const root = rootOf(shop)
      if (themeFiles(root).length === 0)
        throw new SiteThemeError(
          'invalid_input',
          '主题工作目录是空的：先起底（theme_init_from_base）或拉一份（theme_pull）',
        )
      const state = stateOf(shop)
      // 同名再推一次：那份副本还在、而且**不是线上那一份**，就推到它上面（不在店里堆一份又一份）
      const earlier = [...state.pushes].reverse().find((p) => p.theme_name === trimmed)
      let pushed: PushedTheme
      if (earlier !== undefined) {
        const rows = await wrap(() => t.list(shop))
        const still = rows.find((r) => r.id === earlier.theme_id)
        pushed =
          still !== undefined && still.role !== 'main' && still.role !== 'live'
            ? await wrap(() => t.pushToTheme({ shop, theme_id: earlier.theme_id }))
            : await wrap(() => t.pushUnpublished({ shop, name: trimmed }))
      } else {
        pushed = await wrap(() => t.pushUnpublished({ shop, name: trimmed }))
      }
      const record: ThemePushRecord = {
        theme_id: pushed.theme_id,
        theme_name: pushed.theme_name === pushed.theme_id ? trimmed : pushed.theme_name,
        preview_url: pushed.preview_url ?? `https://${shop}/?preview_theme_id=${pushed.theme_id}`,
        at: now(),
        changed_files: changedFiles(state.baseline, manifestOf(root)),
      }
      state.pushes = [...state.pushes.filter((p) => p.theme_id !== record.theme_id), record].slice(
        -20,
      )
      save()
      emit('site_theme.preview_ready', {
        workspace_id: ws,
        theme_id: record.theme_id,
        changed: record.changed_files.length,
      })
      const matter = request?.work_item?.id
      if (matter !== undefined && record.preview_url !== undefined)
        options.notePreview?.(matter, {
          text: `预览好了：未发布主题「${record.theme_name}」（线上没动）。`,
          url: record.preview_url,
          label: record.theme_name,
        })
      return record
    },

    async proposePublish({ theme_id, request }) {
      const { shop, spec } = await need('remote')
      // `before` 来自这一次真读（15 §1），不是模型说的
      const themes = await listWithPreview(shop, theme(spec))
      const ready = publishReadiness(themes as ThemeSummaryLike[], theme_id)
      if (!ready.ok) return { status: 'blocked', message: ready.message ?? '这一份提不了发布' }
      const target = themes.find((t) => t.id === theme_id) as ThemeSummary
      const live = themeLanes(themes as ThemeSummaryLike[]).published
      const state = stateOf(shop)
      const record = state.pushes.find((p) => p.theme_id === theme_id)
      const files = record?.changed_files ?? []
      const preview = record?.preview_url ?? target.preview_url
      const assignment_id = request.actor.assignment_id
      let mandate: Mandate = { caps: {} }
      let level: 'L1' | 'L2' | 'L3' = 'L1'
      try {
        const config = options.effectiveConfig(assignment_id)
        mandate = config.actions.find((a) => a.id === 'stage_publish_theme')?.mandate ?? mandate
        level = config.automation.stage_publish_theme?.level ?? 'L1'
      } catch {
        // 查不到按最严那一档（L1）
      }
      const title = `将把主题「${target.name}」设为线上主题`
      const fileLines =
        record === undefined
          ? ['改了哪些文件：没有记录（这份副本不是在工坊里推的）']
          : files.length === 0
            ? ['相对起底 / 拉下来的那一份没改文件（原样）。']
            : [
                `改了 ${files.length} 个文件：`,
                ...files.slice(0, 12).map((f) => `· ${f}`),
                ...(files.length > 12 ? [`· 还有 ${files.length - 12} 个`] : []),
              ]
      const notes = [
        live === undefined
          ? `这家店线上还没有主题；批了之后「${target.name}」就是线上那一份。`
          : `把线上主题从「${live.name}」换成「${target.name}」——按下去顾客立刻就看得到。`,
        preview === undefined
          ? '批之前去后台点开这份副本看一眼。'
          : `批之前先点开预览看一眼：${preview}`,
        ...fileLines,
      ]
      const run_id = request.id
      const outcome = await options.ledger.stage({
        workspace_id: ws as never,
        role_id: request.actor.role_id,
        assignment_id,
        run_id,
        change_set_id: `cs_${run_id}_publish_${theme_id}`,
        kind: 'publish_theme',
        target: { type: 'theme', id: theme_id },
        field: 'live_theme',
        before:
          live === undefined
            ? { theme_id: '', theme_name: '' }
            : { theme_id: live.id, theme_name: live.name },
        after: {
          theme_id,
          theme_name: target.name,
          ...(preview === undefined ? {} : { preview_url: preview }),
          store: shop,
          files,
        },
        notes,
        created_by: { kind: 'agent', id: `agent_${request.actor.role_id}` },
        mandate,
        level,
        provenance: {
          run_id,
          seen: { theme: [theme_id, ...(live === undefined ? [] : [live.id])] },
          read_full: [`theme:${theme_id}`],
          recorded_at: now(),
        },
        approval: {
          title,
          summary: notes.join('\n'),
          recipients: [{ person: request.actor.person_id as never, via: 'owner' }],
          proposer: {
            kind: 'agent',
            id: `agent_${request.actor.role_id}`,
            assignment_id,
          },
          rule: 'owner',
          separation_of_duties: false,
          source_events: [],
        },
      } as StageInput)
      if (!outcome.ok) return { status: 'blocked', message: outcome.message }
      emit('site_theme.publish_staged', {
        workspace_id: ws,
        theme_id,
        change_id: outcome.change.id,
      })
      return {
        status: 'staged',
        message: `出了一张卡：${title}。你批了才换，批之前先点开预览看一眼。`,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async apply(change) {
      if (change.kind !== 'publish_theme' || change.workspace_id !== ws) return undefined
      const after =
        change.after !== null && typeof change.after === 'object'
          ? (change.after as Record<string, unknown>)
          : {}
      const theme_id =
        typeof after.theme_id === 'string' && after.theme_id !== 'pending'
          ? after.theme_id
          : undefined
      const fromCommand =
        typeof after.command === 'string'
          ? /--store[= ]([^\s]+)/.exec(after.command)?.[1]
          : undefined
      const shop = typeof after.store === 'string' ? after.store : (fromCommand ?? storeOf()?.store)
      if (theme_id === undefined || shop === undefined)
        return {
          status: 'failed',
          error: { message: '卡上没写清发布哪一份主题、哪家店', retryable: false },
        }
      const r = await readiness()
      if (r.next !== undefined && r.next !== 'store')
        return { status: 'failed', error: { message: NEED_TEXT[r.next], retryable: true } }
      const spec = options.cliSpec()
      if (spec === undefined)
        return { status: 'failed', error: { message: NEED_TEXT.install_cli, retryable: true } }
      try {
        const t = cliFor(spec)
        const rows = await wrap(() => t.list(shop))
        const target = rows.find((row) => row.id === theme_id)
        if (target === undefined)
          return {
            status: 'failed',
            error: {
              message: `店里找不到这份主题（${theme_id}），可能已经被人删了`,
              retryable: false,
            },
          }
        if (target.role !== 'main' && target.role !== 'live')
          await wrap(() => t.publish({ shop, theme_id }))
        emit('site_theme.published', { workspace_id: ws, theme_id, change_id: change.id })
        return {
          status: 'ok',
          execution_id: `theme_publish_${change.id}`,
          outcome_ref: { type: 'theme', id: theme_id },
        }
      } catch (e) {
        return {
          status: 'failed',
          error: { message: e instanceof Error ? e.message : String(e), retryable: false },
        }
      }
    },
  }
}
