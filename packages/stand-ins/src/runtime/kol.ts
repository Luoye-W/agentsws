/**
 * WP117（66 断点 #1）：stub 运行时的**红人剧本**。
 *
 * 断点 #1 的现象：让红人岗位「找 20 个频道」，回的是客服的话——因为 stub 里只有
 * 一条路（订单 → 退货窗口 → 回信），红人岗位掉进同一条路，于是问出了退款窗口。
 *
 * 这个文件是那条路的**岔口**：`kolBranch` 认出这是红人的活儿之后，stub 走这一边，
 * 客服那一半一行都不执行。同 `support.ts` 的分工——判定与措辞在这里，
 * 真正干活（建卡、进账本）仍由注入的回调与工具执行器负责（本包碰不到库与凭据）。
 *
 * 与客服那条路的三处不同，都是有意的：
 *
 * 1. **不 `stage`、不 `createDraft`**。红人的每一个写动作（起草开发信、推进合作、
 *    验收交付物、建追踪链接）在服务端都已经是一条走过 guardrail 的路
 *    （`kol-service` 的 `outreach` / `advanceCollaboration` / …），而那条路自己就建卡。
 *    运行时**调工具**就够了，另开一条 stage 通道等于同一件事两条路，卡会出两张。
 * 2. **回执从工具结果里读**。工具回的 data 带 `approval_item_id` / `change_id` 时，
 *    这里把它翻成 `proposal.created` / `change.staged` 事件——66 断点 #5、#7 的
 *    「接口 200 但界面什么也没发生」就是因为没人把这一步翻出来。
 * 3. **找人这类只读的活儿出 `answer`**，不出草稿：没有人要批「我找到了 12 个人」。
 */
import type { ContextItem, ObjectRef, RunRequest } from '@agentsws/contracts'
import {
  classifyKolTask,
  describeFindReply,
  describeKolRun,
  type KolFoundCreator,
  type KolIntent,
  type KolReplyLinks,
  type KolTaskContext,
  kolChannelOfRole,
  kolToolZh,
  type PlannedKolCall,
  parseFollowerBand,
  parseWantedCount,
  planKolTools,
} from '@agentsws/kol-core'

/** 一个 ContextItem 的 ObjectRef（字符串 source_ref 的那种没有）。 */
function refOf(item: ContextItem): ObjectRef | undefined {
  return typeof item.source_ref === 'string' ? undefined : item.source_ref
}

/** 现场钉着的第一个某类对象。 */
function pinnedId(req: RunRequest, type: string): string | undefined {
  for (const item of req.context) {
    const ref = refOf(item)
    if (ref?.type === type) return ref.id
  }
  return undefined
}

export interface KolBranch {
  channel: NonNullable<ReturnType<typeof kolChannelOfRole>>
  intent: KolIntent
  signals: string[]
  ctx: KolTaskContext
  calls: PlannedKolCall[]
}

/**
 * 这次运行是不是红人的活儿；是的话连带把意图与工具计划算出来。
 *
 * 判据只有 `role_id`（`kol.youtube` → 是）。**不看意图词**：一件事被岗位路由落到
 * 这条职责上之后，它就是红人的活儿——哪怕正文里一个红人相关的词都没有
 * （那种情况判成 `unknown`，去读一条合作清单然后说人话，见 `planKolTools`）。
 */
export function kolBranch(req: RunRequest, text: string): KolBranch | undefined {
  const channel = kolChannelOfRole(req.actor.role_id)
  if (channel === undefined) return undefined
  const hit = classifyKolTask(text)
  const creator_id = pinnedId(req, 'creator')
  const collaboration_id = pinnedId(req, 'collaboration')
  const deliverable_id = pinnedId(req, 'deliverable')
  const ctx: KolTaskContext = {
    channel,
    text,
    ...(creator_id === undefined ? {} : { creator_id }),
    ...(collaboration_id === undefined ? {} : { collaboration_id }),
    ...(deliverable_id === undefined ? {} : { deliverable_id }),
  }
  return {
    channel,
    intent: hit.intent,
    signals: hit.signals,
    ctx,
    calls: planKolTools(hit.intent, ctx),
  }
}

/** 工具结果里的卡 id / 变更 id（66 断点 #5、#7：回执必须翻出来）。 */
export function receiptOf(data: unknown): {
  approval_item_id?: string
  change_id?: string
  kind?: string
} {
  if (data === null || typeof data !== 'object') return {}
  const o = data as Record<string, unknown>
  const pick = (k: string): string | undefined => (typeof o[k] === 'string' ? o[k] : undefined)
  const approval_item_id = pick('approval_item_id')
  const change_id = pick('change_id')
  const kind = pick('kind')
  return {
    ...(approval_item_id === undefined ? {} : { approval_item_id }),
    ...(change_id === undefined ? {} : { change_id }),
    ...(kind === undefined ? {} : { kind }),
  }
}

/** 工具结果里能认出来的红人实体 → provenance（15 §6 只证明「读过」）。 */
export function kolRefs(data: unknown): ObjectRef[] {
  if (data === null || typeof data !== 'object') return []
  const o = data as Record<string, unknown>
  const refs: ObjectRef[] = []
  const collect = (rows: unknown, type: string): void => {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      const r =
        row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : undefined
      const id = r?.id ?? r?.creator_id
      if (typeof id === 'string') refs.push({ type, id })
    }
  }
  collect(o.rows, typeof o.object === 'string' ? o.object : 'creator')
  collect(o.creators, 'creator')
  collect(o.collaborations, 'collaboration')
  collect(o.deliverables, 'deliverable')
  if (typeof o.creator_id === 'string') refs.push({ type: 'creator', id: o.creator_id })
  if (typeof o.collaboration_id === 'string')
    refs.push({ type: 'collaboration', id: o.collaboration_id })
  return refs
}

/** 一次搜索结果里有几个人（`answer` 里那个数）。 */
export function countOf(data: unknown): number | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const o = data as Record<string, unknown>
  for (const key of ['rows', 'creators', 'collaborations', 'deliverables']) {
    if (Array.isArray(o[key])) return (o[key] as unknown[]).length
  }
  return undefined
}

/** 一条工具结果里读出来的、要写进 `answer` 的那几行。 */
export interface KolFinding {
  tool: string
  status: 'ok' | 'error' | 'blocked'
  count?: number
  reason?: string
  receipt?: { approval_item_id?: string; change_id?: string }
  /** WP142：找人那一步找到的是谁（回话里点名前 5 个）。 */
  creators?: KolFoundCreator[]
  /** WP142：这一份从哪来（`local_library` = 这条渠道没接数据来源，退到了自己的库）。 */
  source?: string
}

/** WP142：找人结果里的人（名字 + 粉丝数）与来源。认不出就不给。 */
export function foundOf(data: unknown): { creators?: KolFoundCreator[]; source?: string } {
  if (data === null || typeof data !== 'object') return {}
  const o = data as Record<string, unknown>
  const source = typeof o.source === 'string' ? o.source : undefined
  const rows = Array.isArray(o.rows) ? o.rows : undefined
  const creators = rows?.flatMap((row): KolFoundCreator[] => {
    if (row === null || typeof row !== 'object') return []
    const r = row as Record<string, unknown>
    const name =
      typeof r.display_name === 'string'
        ? r.display_name
        : typeof r.handle === 'string'
          ? `@${r.handle}`
          : undefined
    if (name === undefined) return []
    return [{ name, ...(typeof r.followers === 'number' ? { followers: r.followers } : {}) }]
  })
  return {
    ...(creators === undefined ? {} : { creators }),
    ...(source === undefined ? {} : { source }),
  }
}

/** 渠道 id → 名字（回话里不露小写的 `youtube`）。 */
const CHANNEL_ZH: Readonly<Record<string, string>> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  x: 'X',
}

/**
 * 这次运行给人看的那段话（36 §3「算不出就说没有」）。
 *
 * 三条纪律：① 每一步都写清「干了什么 + 结果」；② 失败照实说，不掩成成功
 * （66 断点 #6、#7 的「界面把错误吞了」就是这一条没做到）；③ 出了卡就说「在待办里等你」，
 * 让人知道下一步在哪。
 */
export function renderKolAnswer(input: {
  intent: KolIntent
  channel: string
  findings: readonly KolFinding[]
  band?: { min: number; max: number }
  /** WP142：用户点名要几个（「找 20 个」）；没说就不给。 */
  wanted?: number
  /** WP142：候选池 / 关联官方数据接口 / 导入一张表的站内链接。 */
  links?: KolReplyLinks
}): string {
  /*
   * WP142（docs/78 §1 #5）：**找人那一步成了，回话就说是谁**——前 5 个名字 + 去候选池的链接；
   * 不够数说为什么、给两个动作。其余几步（进候选池等）照旧一行一件事。
   */
  const search = input.findings.find((f) => f.tool === 'search_creators' && f.status === 'ok')
  if (search !== undefined) {
    const rest = input.findings.filter((f) => f !== search)
    const lines = describeFindReply({
      channel: input.channel,
      band: input.band,
      wanted: input.wanted,
      found: search.creators ?? [],
      source: search.source,
      links: input.links,
    })
    const tail =
      rest.length === 0
        ? []
        : renderKolAnswer({ ...input, findings: rest })
            .split('\n')
            .slice(1)
    return [...lines, ...tail].join('\n')
  }
  const lines: string[] = []
  for (const f of input.findings) {
    const what = kolToolZh(f.tool)
    if (f.status !== 'ok') {
      lines.push(`- ${what}：没成——${f.reason ?? '这个进程没接这一步'}。`)
      continue
    }
    const bits: string[] = []
    if (f.count !== undefined) bits.push(`${f.count} 条`)
    if (f.receipt?.approval_item_id !== undefined) bits.push('已出一张待你批的卡')
    if (f.receipt?.change_id !== undefined) bits.push('已记进变更账本')
    lines.push(`- ${what}：${bits.length > 0 ? bits.join('，') : '完成'}。`)
  }
  if (lines.length === 0) lines.push('- 这次没有一步能走通，下面没有可看的结果。')
  // 找人没成：同样给下一步（关联官方数据接口 / 导入一张表），不停在一句「没成」
  const failedFind = input.findings.some((f) => f.tool === 'search_creators' && f.status !== 'ok')
  if (failedFind) {
    const actions = [
      input.links?.linkAccount === undefined
        ? undefined
        : `[关联官方数据接口](${input.links.linkAccount})`,
      input.links?.importTable === undefined
        ? undefined
        : `[导入一张表](${input.links.importTable})`,
    ].filter((a): a is string => a !== undefined)
    if (actions.length > 0) lines.push(`想找人可以先：${actions.join(' · ')}`)
  }
  const where = CHANNEL_ZH[input.channel] ?? input.channel
  const head =
    input.band === undefined
      ? `${where} 这条渠道上，我按你说的做了这几件事：`
      : `${where} 这条渠道上，按粉丝 ${input.band.min.toLocaleString('en-US')}–${input.band.max.toLocaleString('en-US')} 这个区间，我做了这几件事：`
  return [head, ...lines].join('\n')
}

export { describeKolRun, parseFollowerBand, parseWantedCount }
