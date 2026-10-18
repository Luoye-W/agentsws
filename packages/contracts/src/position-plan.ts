/**
 * WP234（docs/54 §6.3）：**岗位划分建议**——一份算法，工作台第 ③ 步与服务端都调它。
 *
 * 岗位不再是「模板直出」，是**按这个人要做的事拼出来的职责组合**。这里给一个合理的
 * 第一版拼法，用户在界面上随便改（拖动 / 移动 / 新建 / 改名 / 删空），改完以用户为准。
 *
 * 纯函数：不碰时钟、不碰随机源、不读库——同一组输入在两台机器上算出同一份清单。
 */

/** 一个岗位里最多放几条职责；超过就建议拆（可调，见 docs/54 §6.3 为什么是 6）。 */
export const MAX_DUTIES_PER_POSITION = 6

/** 类别（= 随软件带的岗位模板，只当目录用）。 */
export interface PositionCatalogEntry {
  id: string
  name: string
  /** WP395：`default` 给了就用来认「这条职责的家」（挂在几个类别里时归默认勾的那个）。 */
  roles: readonly { id: string; default?: boolean }[]
}

/** 第 ③ 步的产出：一个岗位 = 名字 + 几条职责（+ 从哪个类别来的，复用模板时用）。 */
export interface PlannedPosition {
  name: string
  role_ids: string[]
  template_id?: string
}

/**
 * 认得出的渠道（职责 id 的后缀 → 显示名）。只用来判「这几条是不是同一个渠道」与起名，
 * 认不出的后缀（`support`、`store`……）不算渠道。
 */
const CHANNELS: Readonly<Record<string, string>> = {
  reddit: 'Reddit',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  amazon: 'Amazon',
}

/** 这条职责是哪个渠道的（`pr.reddit` → `reddit`）；不是渠道职责回 `undefined`。 */
export function channelOfRole(role_id: string): string | undefined {
  const suffix = role_id.slice(role_id.lastIndexOf('.') + 1)
  return CHANNELS[suffix] === undefined ? undefined : suffix
}

/** 渠道岗位的默认名（「Reddit 运营」/ "Reddit Ops"）。 */
export function channelPositionName(channel: string, lang: 'zh' | 'en' = 'zh'): string {
  const label = CHANNELS[channel] ?? channel
  return lang === 'en' ? `${label} Ops` : `${label} 运营`
}

/**
 * WP235：合并后那个岗位的建议名——几条职责都是同一个渠道（`pr.reddit` + `social.reddit`）就叫
 * 「Reddit 运营」；否则用 `fallback`（合并目标原来的名字）。公司页合并对话框预填它，服务端不给名字时也用它。
 */
export function mergedPositionName(
  role_ids: readonly string[],
  fallback: string,
  lang: 'zh' | 'en' = 'zh',
): string {
  const channels = new Set(role_ids.map(channelOfRole))
  const only = [...channels][0]
  return role_ids.length > 0 && channels.size === 1 && only !== undefined
    ? channelPositionName(only, lang)
    : fallback
}

/**
 * 一条职责归哪个类别（挂在几个模板里时归第一个）。WP395：挂在几个模板里、其中只在一个里默认勾
 * （`amz.support`：客服默认勾、Amazon 运营只列着）→ 归默认勾的那个，与目录顺序无关。
 */
export function categoryOfRole(
  role_id: string,
  catalog: readonly PositionCatalogEntry[],
): PositionCatalogEntry | undefined {
  const hits = catalog.filter((c) => c.roles.some((r) => r.id === role_id))
  if (hits.length <= 1) return hits[0]
  const home = hits.filter((c) => c.roles.some((r) => r.id === role_id && r.default !== false))
  return home.length === 1 ? home[0] : hits[0]
}

/**
 * WP395（docs/104 C2）：一句话里算不算「提到了 Amazon」。FBA / ASIN / 卖家后台 / Seller Central
 * 是 Amazon 才有的说法；「Listing」不算（独立站也这么说）。首次设置推荐与模拟同一份。
 */
export function mentionsAmazon(text: string): boolean {
  return /amazon|亚马逊|\bFBA\b|\bASINs?\b|卖家后台|seller\s*central/i.test(text)
}

/** 超过阈值就按顺序切成几堆（「社媒运营 · 1」「社媒运营 · 2」），模板 id 只留给第一堆。 */
function chunk(position: PlannedPosition, max: number): PlannedPosition[] {
  if (position.role_ids.length <= max) return [position]
  const out: PlannedPosition[] = []
  const parts = Math.ceil(position.role_ids.length / max)
  // 均分：9 条切成 5 + 4，而不是 6 + 3
  const size = Math.ceil(position.role_ids.length / parts)
  for (let i = 0; i < parts; i += 1) {
    out.push({
      name: `${position.name} · ${String(i + 1)}`,
      role_ids: position.role_ids.slice(i * size, (i + 1) * size),
    })
  }
  return out
}

/**
 * 按选中的职责给一份岗位划分（docs/54 §6.3 那四步）：
 *
 * 1. 按类别分堆；
 * 2. 同一个渠道、来自不同类别、而且**在各自类别里只选了这个渠道** → 并成「X 运营」；
 * 3. 一堆超过 `max` 就拆；
 * 4. 名字用类别名 / 渠道名。
 *
 * 认不出类别的职责（目录里没有）单独成一堆「其他」——不丢，也不替人猜。
 */
export function proposePositions(
  role_ids: readonly string[],
  catalog: readonly PositionCatalogEntry[],
  options: { max?: number; lang?: 'zh' | 'en' } = {},
): PlannedPosition[] {
  const max = Math.max(1, options.max ?? MAX_DUTIES_PER_POSITION)
  const lang = options.lang ?? 'zh'
  const picked = [...new Set(role_ids)]
  // 1. 按类别分堆（顺序：类别在目录里的顺序 → 职责在类别里的顺序）
  const byCategory = new Map<string, string[]>()
  const loose: string[] = []
  for (const id of picked) {
    const cat = categoryOfRole(id, catalog)
    if (cat === undefined) {
      loose.push(id)
      continue
    }
    const list = byCategory.get(cat.id)
    if (list === undefined) byCategory.set(cat.id, [id])
    else list.push(id)
  }
  // 1bis. WP395（docs/106 A3）：挂在几个类别里的职责，在第一个类别里**孤零零一条**、而后面另一个
  //   也挂着它的类别里已经有别的职责被选中 → 改归那个类别。只做 Amazon、没设客服岗的公司，
  //   `amz.support` 就跟着亚马逊店铺运营进「Amazon 运营」，不单独成一个只有它的「客服」。
  for (const [catId, ids] of [...byCategory]) {
    const only = ids.length === 1 ? ids[0] : undefined
    if (only === undefined) continue
    const home = catalog.find(
      (c) =>
        c.id !== catId &&
        (byCategory.get(c.id) ?? []).length > 0 &&
        c.roles.some((r) => r.id === only),
    )
    if (home === undefined) continue
    const order = home.roles.map((r) => r.id)
    const moved = [...(byCategory.get(home.id) ?? []), only].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    )
    byCategory.set(home.id, moved)
    byCategory.delete(catId)
  }
  // 2. 同渠道并岗：找出「整个类别只选了这一个渠道」的那些类别
  const soleChannel = new Map<string, string>()
  // 按目录顺序走，于是并出来的那个岗位里职责的顺序与目录一致（与谁先被点中无关）
  for (const cat of catalog) {
    const ids = byCategory.get(cat.id)
    if (ids === undefined) continue
    const channels = new Set(ids.map(channelOfRole))
    const only = [...channels][0]
    if (channels.size === 1 && only !== undefined) soleChannel.set(cat.id, only)
  }
  const channelGroups = new Map<string, string[]>()
  for (const [catId, channel] of soleChannel) {
    const list = channelGroups.get(channel)
    if (list === undefined) channelGroups.set(channel, [catId])
    else list.push(catId)
  }
  const merged = new Set<string>()
  const out: PlannedPosition[] = []
  for (const cat of catalog) {
    const ids = byCategory.get(cat.id)
    if (ids === undefined || merged.has(cat.id)) continue
    const channel = soleChannel.get(cat.id)
    const partners = channel === undefined ? [] : (channelGroups.get(channel) ?? [])
    if (channel !== undefined && partners.length > 1) {
      const all = partners.flatMap((c) => byCategory.get(c) ?? [])
      for (const c of partners) merged.add(c)
      out.push(...chunk({ name: channelPositionName(channel, lang), role_ids: all }, max))
      continue
    }
    merged.add(cat.id)
    out.push(...chunk({ name: cat.name, role_ids: [...ids], template_id: cat.id }, max))
  }
  if (loose.length > 0)
    out.push(...chunk({ name: lang === 'en' ? 'Other' : '其他', role_ids: loose }, max))
  return out
}

/**
 * AI 给的划分先过这一道（docs/54 §6.3）：每条职责恰好出现一次、只用 `allowed` 里的职责、
 * 每个岗位不超阈值、名字非空且不超 64 字。过不了回一句为什么——调用方整份换成
 * {@link proposePositions}，不半信半疑地拼。
 */
export function checkSuggestedPositions(
  positions: readonly PlannedPosition[],
  allowed: readonly string[],
  options: { max?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  const max = Math.max(1, options.max ?? MAX_DUTIES_PER_POSITION)
  const seen = new Set<string>()
  for (const p of positions) {
    const name = p.name.trim()
    if (name === '' || name.length > 64) return { ok: false, reason: '岗位名为空或太长' }
    if (p.role_ids.length === 0) return { ok: false, reason: `「${name}」里一条职责都没有` }
    if (p.role_ids.length > max) return { ok: false, reason: `「${name}」超过 ${String(max)} 条` }
    for (const id of p.role_ids) {
      if (!allowed.includes(id)) return { ok: false, reason: `「${id}」不在推荐里` }
      if (seen.has(id)) return { ok: false, reason: `「${id}」出现了两次` }
      seen.add(id)
    }
  }
  const missing = allowed.filter((id) => !seen.has(id))
  if (missing.length > 0) return { ok: false, reason: `漏了 ${missing.join('、')}` }
  return { ok: true }
}

/** 一份岗位清单展开后的全部职责（去重、顺序稳定）——第 ④ 步清单与「完成」按它算。 */
export function rolesOfPlan(positions: readonly { role_ids: readonly string[] }[]): string[] {
  return [...new Set(positions.flatMap((p) => p.role_ids))]
}
