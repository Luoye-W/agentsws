/**
 * WP479（决策 1625，Luoye 10-23）：订阅 / API 的模型改成「用户勾选启用」——这里是不碰状态的那几条规则。
 *
 * - **系列**：同一家同一条产品线。按模型 id 认：把版本号那一段（`5.6`、`6`、`4-5`、`v4`）和日期快照
 *   （`20251101`、`2024-08-06`、`0613`）拿掉，剩下的字连起来就是系列——
 *   `gpt-5.6-luna` 与 `gpt-6-luna` 是一条（`gpt-luna`），`gpt-6-astra` 是另一条，
 *   `gpt-5.3-codex-spark` 自己一条（`gpt-codex-spark`），`gpt-5.5` 是不带后缀的那条（`gpt`）。
 *   `claude-opus-4-5` 与老式的 `claude-3-opus` 同一条（`claude-opus`），`deepseek-v4-flash` 是 `deepseek-flash`。
 * - **最新**：同一条里版本号最大的那一个；版本一样时，不带日期的别名（跟着上游升级）优先，都带日期取最近的。
 *   认不出版本号的模型自己一条，算它自己最新。
 * - **首次默认勾**：每条只勾最新那一版；**正在用的**（默认、按用途选的、某件事选着的）即使旧也勾上。
 *
 * 纯函数，单测直接测（夹具就是 Luoye 截图里那一串 ChatGPT 订阅模型）。
 */

/** 一个模型落在哪条线上、是第几版。 */
export interface ModelSeries {
  /** 系列（去掉版本与日期之后的字，小写，`-` 连起来）。 */
  key: string
  /** 版本号（`6.1` → `[6, 1]`；`claude-opus-4-5` → `[4, 5]`；认不出 = 空）。 */
  version: number[]
  /** 日期快照（`20251101`；没有 = 0）。 */
  date: number
}

/** 字母开头、紧跟版本号的一段（`qwen3.7`、`o3`、`llama3.1`）。 */
const PREFIXED_VERSION = /^([a-z]+)(\d{1,3}(?:\.\d+)*)$/
/** 纯版本号的一段（`5.6`、`6`、`v4`、`v4.1`）。 */
const VERSION = /^v?(\d{1,3}(?:\.\d+)*)$/

export function seriesOf(id: string): ModelSeries {
  const tokens = id
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((t) => t !== '')
  const key: string[] = []
  const version: number[] = []
  let date = 0
  /** 版本号只认第一段连续的（`claude-3-7-sonnet` 的 3、7）；后面再有数字算名字的一部分。 */
  let run = 'before' as 'before' | 'in' | 'after'
  const endRun = (): void => {
    if (run === 'in') run = 'after'
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as string
    // 日期快照：8 位（20251101）、年-月-日三段（2024-08-06）、4 位（0613）
    if (/^\d{8}$/.test(t)) {
      date = Number(t)
      endRun()
      continue
    }
    const mm = tokens[i + 1]
    const dd = tokens[i + 2]
    if (
      /^(19|20)\d{2}$/.test(t) &&
      mm !== undefined &&
      /^\d{2}$/.test(mm) &&
      dd !== undefined &&
      /^\d{2}$/.test(dd)
    ) {
      date = Number(`${t}${mm}${dd}`)
      i += 2
      endRun()
      continue
    }
    if (/^\d{4,}$/.test(t)) {
      date = Number(t)
      endRun()
      continue
    }
    const plain = VERSION.exec(t)
    if (plain !== null && run !== 'after') {
      version.push(...(plain[1] as string).split('.').map(Number))
      run = 'in'
      continue
    }
    const prefixed = PREFIXED_VERSION.exec(t)
    if (prefixed !== null && run === 'before') {
      key.push(prefixed[1] as string)
      version.push(...(prefixed[2] as string).split('.').map(Number))
      run = 'in'
      continue
    }
    endRun()
    key.push(t)
  }
  return { key: key.length === 0 ? id.toLowerCase() : key.join('-'), version, date }
}

/** 版本号比大小（缺的段当 0：`6` 与 `6.0` 一样大）。 */
export function compareVersion(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 同一条线里谁更新：版本号大的；一样大时不带日期的别名优先，都带日期取近的。 */
function newer(a: ModelSeries, b: ModelSeries): boolean {
  const v = compareVersion(a.version, b.version)
  if (v !== 0) return v > 0
  const da = a.date === 0 ? Number.POSITIVE_INFINITY : a.date
  const db = b.date === 0 ? Number.POSITIVE_INFINITY : b.date
  return da > db
}

/** 每条线最新那一个（顺序照传进来的）。 */
export function latestPerSeries(ids: readonly string[]): string[] {
  const best = new Map<string, { id: string; s: ModelSeries }>()
  for (const id of ids) {
    const s = seriesOf(id)
    const cur = best.get(s.key)
    if (cur === undefined || newer(s, cur.s)) best.set(s.key, { id, s })
  }
  const keep = new Set([...best.values()].map((x) => x.id))
  return ids.filter((id) => keep.has(id))
}

/** 首次连接（或老用户升级后第一次）默认勾哪些：每条线最新那一版 + 正在用的。顺序照目录。 */
export function defaultEnabledModels(
  catalog: readonly string[],
  inUse: ReadonlySet<string> = new Set(),
): string[] {
  const latest = new Set(latestPerSeries(catalog))
  return catalog.filter((m) => latest.has(m) || inUse.has(m))
}

/**
 * 一个已连接来源的勾选与「看过没有」（落在 `models.json` 的 `enabled_models` 里，按 provider id）。
 *
 * - `enabled`：订阅 / 账号那几条勾上的；API key 那几条不用这一格（照 WP370 的 `picker_models`，同一份真源）；
 * - `seen`：人在设置里看过的（不再标「新」）；
 * - `notified`：已经出过提醒的（铃铛不重复出）；
 * - `notice`：最近一批新模型（铃铛那一条，同一批合成一条）；人看过就收掉。
 */
export interface ModelEnableEntry {
  enabled?: string[]
  seen: string[]
  notified: string[]
  notice?: { models: string[]; at: string }
}

/** 目录里有、人还没看过的（设置里标「新」）。 */
export function freshModels(
  known: readonly string[],
  entry: ModelEnableEntry | undefined,
): string[] {
  if (entry === undefined) return []
  const seen = new Set(entry.seen)
  return known.filter((m) => !seen.has(m))
}

/**
 * 目录刷新之后对一遍：多出来的（既没看过、也没提醒过）记进 `notified`，并合进这一批的提醒。
 * `quiet` = 人自己刚点了「拉取模型列表」：照样标「新」，但不进铃铛（人就在设置里看着）。
 * 回 `true` = 有变化（调用方落盘）。
 */
export function noteNewModels(
  entry: ModelEnableEntry,
  known: readonly string[],
  at: string,
  quiet = false,
): boolean {
  const seen = new Set(entry.seen)
  const notified = new Set(entry.notified)
  const fresh = known.filter((m) => !seen.has(m) && !notified.has(m))
  if (fresh.length === 0) return false
  entry.notified = [...entry.notified, ...fresh]
  if (!quiet) {
    const pending = (entry.notice?.models ?? []).filter((m) => !seen.has(m))
    entry.notice = { models: [...new Set([...pending, ...fresh])], at }
  }
  return true
}

/** 提醒里还没看过、目录里也还在的那几个（没有就不出铃铛那一条）。 */
export function pendingNotice(
  entry: ModelEnableEntry | undefined,
  known: readonly string[],
): string[] {
  if (entry?.notice === undefined) return []
  const seen = new Set(entry.seen)
  const have = new Set(known)
  return entry.notice.models.filter((m) => !seen.has(m) && have.has(m))
}
