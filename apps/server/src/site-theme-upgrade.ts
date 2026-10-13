/**
 * WP296：已经起过底的品牌碰上新版 agentsws-theme（例如 v0.9.2 → v0.10.0，breaking）时的那几件纯计算。
 *
 * 规矩（派工单 WP296 第 4 条）：**不自动升级**。运行里照实说一句「这份主题是 v0.9.2，新版 v0.10.0 要迁移」，
 * 出一张 `upstream_upgrade` 卡「升级到 v0.10.0（会跑迁移）」，人点了才升。升的那一下（`site-theme.ts` 的
 * `upgradeBase`）：
 *
 * 1. 先下新版起底包（同一个钉子、同一个 sha256），在暂存目录里解开；
 * 2. 把这个品牌自己的东西叠上去（{@link overlayStoreFiles}）：templates / section 组 / settings_data /
 *    custom-* 文件原样带过去（人没改过的就用新版的）；locales 按 {@link mergeLocale} 合；核心文件一律用新版；
 * 3. 在暂存目录里跑主题自带的 `npm run migrate`（= `node scripts/migrate-blocks.mjs`，只用 node 内置模块，
 *    不要 npm install）；跑不成 → 暂存目录删掉，工作目录一个字节不动；
 * 4. 跑成了：旧工作目录整份挪去 `theme-work/<ws>/backup/…`（这就是备份，不删），暂存目录换上来。
 *
 * 线上主题一个字节不动：升完照常推一份未发布预览，人看过再发布。
 */
import type { ApprovalItem } from '@agentsws/contracts'

/** `upstreams.yml` 里这个上游的 id（卡上的 `upstream_id`）。 */
export const THEME_UPSTREAM_ID = 'agentsws-theme'

/** 新版发版说明（卡上给人点开看改了什么）。 */
export const themeReleaseUrl = (repo: string, tag: string): string =>
  `https://github.com/${repo}/releases/tag/${tag}`

/** `0.9.2` 比 `0.10.0` 旧（只比 major.minor.patch 三段数字；`-fixture` 之类的尾巴不看）。 */
export function versionOlder(a: string, b: string): boolean {
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      ?.split('.')
      .map((x) => Number.parseInt(x, 10) || 0) ?? []
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * 店铺自己的内容（升级时带过去）：templates、section 组、settings_data、custom-* 文件。
 * 与 `baseWritable` 同一张表，只是 locales 另算（{@link mergeLocale}）。
 */
export function storeOwned(rel: string): boolean {
  const name = rel.split('/').pop() ?? ''
  if (rel.startsWith('templates/')) return true
  if (rel === 'config/settings_data.json') return true
  if (/^sections\/[^/]+\.json$/.test(rel)) return true
  if (/^(sections|blocks|snippets|assets)\/[^/]+$/.test(rel)) return /^_?custom-/.test(name)
  return false
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

function leaves(
  o: Json,
  prefix: string[] = [],
  out: [string[], unknown][] = [],
): [string[], unknown][] {
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v)) leaves(v, [...prefix, k], out)
    else out.push([[...prefix, k], v])
  }
  return out
}

function leafAt(o: Json, path: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = o
  for (const k of path) {
    if (!isObj(cur) || !(k in cur)) return { found: false }
    cur = cur[k]
  }
  return isObj(cur) ? { found: false } : { found: true, value: cur }
}

function setAt(o: Json, path: string[], value: unknown): void {
  let cur = o
  for (const k of path.slice(0, -1)) {
    const next = cur[k]
    if (!isObj(next)) cur[k] = {}
    cur = cur[k] as Json
  }
  const last = path[path.length - 1]
  if (last !== undefined) cur[last] = value
}

const CUSTOM_KEY = /^_?custom[-_]/

/**
 * 一份 locales 文件：以新版为底，再把这个品牌的那几条叠上去——
 *
 * - 带 `custom-` 段的键（自己写的 custom 分区 / 块的标签与文案）一律带上；
 * - 店面文案（`locales/*.json`，不是 `.schema.json`）里新版**还有**的键，用这个品牌改过的那一句；
 * - 新版删掉的键（v0.10.0 合并了重复的编辑器标签：3469 → 2769 条）不带回来——带回来会撞 Shopify 的 3400 条上限。
 *
 * 任一边不是 JSON 对象 → `undefined`（调用方保留新版那一份、记一条「要人看」）。
 */
export function mergeLocale(rel: string, upstream: string, mine: string): string | undefined {
  let up: unknown
  let own: unknown
  try {
    up = JSON.parse(upstream)
    own = JSON.parse(mine)
  } catch {
    return undefined
  }
  if (!isObj(up) || !isObj(own)) return undefined
  const storefront = !rel.endsWith('.schema.json')
  for (const [path, value] of leaves(own)) {
    const custom = path.some((k) => CUSTOM_KEY.test(k))
    if (custom || (storefront && leafAt(up, path).found)) setAt(up, path, value)
  }
  return `${JSON.stringify(up, null, 2)}\n`
}

export interface OverlayPlan {
  /** 原样带过去的（这个品牌改过 / 新加的）。 */
  kept: string[]
  /** 合过的 locales。 */
  merged: string[]
  /** 这个品牌删掉过、新版里又有的店铺内容（照旧删掉）。 */
  removed: string[]
  /** 合不了、用了新版那一份的（要人看一眼）。 */
  manual: string[]
}

/**
 * 把旧工作目录里属于店铺的东西叠到新版上。`files` / `read` / `write` / `remove` 都是相对路径的读写口
 * （测试直接用内存，`site-theme.ts` 用真目录）。`baseline` 是起底 / 拉下来那一刻每个文件的 sha256。
 */
export function overlayStoreFiles(io: {
  oldFiles: readonly string[]
  newHas(rel: string): boolean
  readOld(rel: string): Buffer
  readNew(rel: string): Buffer
  write(rel: string, bytes: Buffer | string): void
  remove(rel: string): void
  hash(bytes: Buffer): string
  baseline: Record<string, string> | undefined
}): OverlayPlan {
  const plan: OverlayPlan = { kept: [], merged: [], removed: [], manual: [] }
  const old = new Set(io.oldFiles)
  const untouched = (rel: string, bytes: Buffer): boolean =>
    io.baseline !== undefined && io.baseline[rel] === io.hash(bytes)
  for (const rel of io.oldFiles) {
    const isLocale = /^locales\/[^/]+\.json$/.test(rel)
    if (!isLocale && !storeOwned(rel)) continue // 核心文件：用新版
    const bytes = io.readOld(rel)
    // 人没改过、新版也有 → 用新版（新版已经是新写法）
    if (untouched(rel, bytes) && io.newHas(rel)) continue
    if (isLocale && io.newHas(rel)) {
      const merged = mergeLocale(rel, io.readNew(rel).toString('utf8'), bytes.toString('utf8'))
      if (merged === undefined) plan.manual.push(rel)
      else {
        io.write(rel, merged)
        plan.merged.push(rel)
      }
      continue
    }
    io.write(rel, bytes)
    plan.kept.push(rel)
  }
  // 起底时有、这个品牌后来删掉的店铺内容：新版里又带了也照旧删掉（人删的就是不要）
  for (const rel of Object.keys(io.baseline ?? {})) {
    if (old.has(rel) || !storeOwned(rel) || !io.newHas(rel)) continue
    io.remove(rel)
    plan.removed.push(rel)
  }
  for (const k of ['kept', 'merged', 'removed', 'manual'] as const) plan[k].sort()
  return plan
}

/** `npm run migrate` 的输出 → 改了哪些文件、哪几处要人手动挪。 */
export function parseMigrateOutput(stdout: string): { updated: string[]; manual: string[] } {
  const updated: string[] = []
  const manual: string[] = []
  let into: string[] | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (/^(Updated|Would update) \d+ file/.test(line)) into = updated
    else if (/^Needs a person:/.test(line)) into = manual
    else if (into !== undefined && /^\s+- /.test(line)) into.push(line.replace(/^\s+- /, '').trim())
    else if (line.trim() !== '') into = undefined
  }
  return { updated, manual }
}

/** 升级卡上的那一份（`upstream_upgrade` 的 payload；字段照 docs/14 §3 那一行，再加这一家店）。 */
export interface ThemeUpgradeCardPayload {
  upstream_id: typeof THEME_UPSTREAM_ID
  from: string
  to: string
  classification: 'breaking'
  store: string
  release_url: string
  recommendation: string
  test_results: string[]
  run_id?: string
}

export const isThemeUpgradeCard = (item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean =>
  item.kind === 'upstream_upgrade' &&
  isObj(item.payload) &&
  item.payload.upstream_id === THEME_UPSTREAM_ID

export const themeUpgradeTitle = (to: string): string => `升级到 v${to}（会跑迁移）`

/** 运行里照实说的那一句（工具回话带给模型）。`card`：出了卡 / 人上次点了先不升 / 这个进程出不了卡。 */
export const themeUpgradeNotice = (
  from: string,
  to: string,
  card: 'carded' | 'declined' | 'none',
): string =>
  `这份主题是 v${from}，新版 v${to} 要迁移（块名、设置名改了）。` +
  (card === 'carded'
    ? `出了一张卡「${themeUpgradeTitle(to)}」，人点了才升，升之前自动留一份备份。`
    : card === 'declined'
      ? '人上次点了先不升，过一天会再问一次。'
      : '这里出不了升级卡，要升请人到建站岗位里跟我说。') +
  `这一次接着用 v${from} 这一份做，别自己升级、别重新起底。`
