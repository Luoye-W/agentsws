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
  describeKolRun,
  type KolIntent,
  type KolTaskContext,
  kolChannelOfRole,
  type PlannedKolCall,
  parseFollowerBand,
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
}

const TOOL_ZH: Readonly<Record<string, string>> = {
  search_creators: '找人',
  get_creator: '看这个人的资料',
  list_collaborations: '看合作清单',
  list_deliverables: '看交付物',
  score_creator: '打分',
  add_to_campaign: '进候选池',
  draft_outreach: '起草开发信',
  advance_collaboration: '推进合作阶段',
  register_deliverable: '登记交付物',
  review_deliverable: '验收交付物',
  create_tracked_link: '建追踪链接',
  search_policies: '查政策',
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
}): string {
  const lines: string[] = []
  for (const f of input.findings) {
    const what = TOOL_ZH[f.tool] ?? f.tool
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
  const head =
    input.band === undefined
      ? `${input.channel} 这条渠道上，我按你说的做了这几件事：`
      : `${input.channel} 这条渠道上，按粉丝 ${input.band.min.toLocaleString('en-US')}–${input.band.max.toLocaleString('en-US')} 这个区间，我做了这几件事：`
  return [head, ...lines].join('\n')
}

export { describeKolRun, parseFollowerBand }
