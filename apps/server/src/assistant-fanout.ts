/**
 * WP350（决策 900）：「我的助理」**一次拆成多份**——服务端那一半。
 *
 * Luoye 10-16：「我派出一个任务，并不是只有一个岗位去工作。」给助理一段话 / 一份会议记录，
 * 里面的事往往要交给好几个岗位、好几个岗位都要记住一些口径。三步：
 *
 * 1. **拆**（`plan`）：模型调 `plan_fanout` 给出一条一条（要做的事 / 要记的口径 / 个人偏好，带它猜的岗位名）
 *    → `@agentsws/roles` 的 `resolveFanout` 认到本人名下的岗位（认不出标「归属待定」，不猜）
 *    → 方案卡（`FreeChatFanoutView`）挂在那条回复上。**这一步什么都不发**。
 * 2. **确认后扇出**（`send`）：人点「就这样」（可能勾掉 / 改归属 / 改文字，`applyFanoutEdits`）→
 *    - 要做的事：按岗位各开一件（走 WP343 同一个交办入口，`mode: task`、不等跑完），同一批带同一个来源批次，
 *      事项描述里有那一段原文；
 *    - 要记的口径：以 `proposed` 写进对应岗位 / 品牌知识库（`fanoutNoteCard`，出处 = 这份资料），
 *      再出**一张**「要记的 N 条」确认卡（通过 = 这一批生效）；
 *    - 个人偏好：进助理记忆（由调用方写，WP343 那一层）。
 * 3. **汇总**：回一张汇总（派了哪几个岗位几件事、各进了几条知识、哪几条没发、为什么）。
 *    之后各件事的回报照 WP343 回到这段对话，带着批次（界面按批次聚在一起）。
 *
 * 助理自己仍然没有任何对外写口：开事项、写待确认的知识都是工坊内部的事，改外部的由岗位照旧出审批。
 */
import type {
  FreeChatActor,
  FreeChatDispatchView,
  FreeChatFanoutEditInput,
  FreeChatFanoutItemView,
  FreeChatFanoutSummaryView,
  FreeChatFanoutView,
} from '@agentsws/api'
import type { Clock, Iso8601, PersonId, PositionInstance, WorkspaceId } from '@agentsws/contracts'
import {
  applyFanoutEdits,
  type FanoutDraftItem,
  type FanoutItem,
  type FanoutNoteCard,
  fanoutNoteCard,
  type PickPosition,
  resolveFanout,
} from '@agentsws/roles'

export interface FanoutSource {
  name: string
  kind: 'meeting' | 'document' | 'human'
}

export interface FanoutDeps {
  clock: Clock
  newId(prefix: string): string
  /** 本人在做的岗位（有本人名下职责的）。 */
  mine(actor: FreeChatActor): Promise<PositionInstance[]>
  toPick(p: PositionInstance): PickPosition
  /** 走岗位交办入口开一件事（与 WP343 派活同一个）。 */
  open(
    actor: FreeChatActor,
    input: { position_id: string; role_id?: string; text: string; summary?: string },
  ): Promise<{ matter_id: string; title: string; role_id?: string; role_name?: string }>
  /**
   * 要记的那几条：以 `proposed` 写进知识库，再出一张确认卡。回卡 id 与那张确认卡的 id。
   * 不给 = 这个进程写不了知识（要记的照实算进「没发」）。
   */
  proposeNotes?(
    actor: FreeChatActor,
    input: {
      batch_id: string
      title: string
      source: FanoutSource
      cards: FanoutNoteCard[]
      groups: { name: string; notes: { text: string; quote?: string }[] }[]
    },
  ): Promise<{ card_ids: string[]; approval_id?: string }>
}

export interface FanoutSent {
  summary: FreeChatFanoutSummaryView
  dispatches: FreeChatDispatchView[]
  /** 进助理记忆的那几句（调用方写）。 */
  memories: string[]
  /** 汇总那一句人话。 */
  text: string
}

const json = (v: unknown): string => JSON.stringify(v)

/** 方案卡上那一条（带人话名字）。 */
function itemView(
  item: FanoutItem,
  positions: readonly PositionInstance[],
): FreeChatFanoutItemView {
  const p = positions.find((x) => x.position_id === item.position_id)
  const duty = p?.roles.find((r) => r.role_id === item.role_id)?.role_name
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    ...(item.why === undefined ? {} : { why: item.why }),
    ...(item.due === undefined ? {} : { due: item.due }),
    ...(item.quote === undefined ? {} : { quote: item.quote }),
    ...(p === undefined ? {} : { position_id: p.position_id, position_name: p.name.zh }),
    ...(item.role_id === undefined || p === undefined ? {} : { role_id: item.role_id }),
    ...(duty === undefined ? {} : { duty_name: duty }),
    ...(item.brand === true ? { brand: true } : {}),
    ...(item.unsure === undefined ? {} : { unsure: { reason: item.unsure.reason } }),
    ...(item.secret === true ? { secret: true } : {}),
  }
}

/** 方案卡上的一条 → 认岗位那一层的形状（回到 `applyFanoutEdits` 用）。 */
function itemOf(v: FreeChatFanoutItemView): FanoutItem {
  return {
    id: v.id,
    kind: v.kind,
    text: v.text,
    ...(v.why === undefined ? {} : { why: v.why }),
    ...(v.due === undefined ? {} : { due: v.due }),
    ...(v.quote === undefined ? {} : { quote: v.quote }),
    ...(v.position_id === undefined ? {} : { position_id: v.position_id }),
    ...(v.role_id === undefined ? {} : { role_id: v.role_id }),
    ...(v.brand === true ? { brand: true as const } : {}),
    ...(v.unsure === undefined ? {} : { unsure: { reason: v.unsure.reason, candidates: [] } }),
    ...(v.secret === true ? { secret: true as const } : {}),
  }
}

/** 模型给的 `items` → 草稿（字段不对的丢掉）。 */
function draftsOf(input: Record<string, unknown>): FanoutDraftItem[] {
  const raw = Array.isArray(input.items) ? input.items : []
  const str = (o: Record<string, unknown>, k: string): string | undefined =>
    typeof o[k] === 'string' && (o[k] as string).trim() !== '' ? (o[k] as string).trim() : undefined
  const out: FanoutDraftItem[] = []
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    const text = str(o, 'text')
    if (text === undefined) continue
    const kind = o.kind === 'note' || o.kind === 'memory' ? o.kind : 'task'
    const position = str(o, 'position')
    const duty = str(o, 'duty')
    const why = str(o, 'why')
    const due = str(o, 'due')
    const quote = str(o, 'quote')
    out.push({
      kind,
      text,
      ...(position === undefined ? {} : { position }),
      ...(duty === undefined ? {} : { duty }),
      ...(why === undefined ? {} : { why }),
      ...(due === undefined ? {} : { due }),
      ...(quote === undefined ? {} : { quote }),
    })
  }
  return out
}

/** 开出去的那件事的描述：为什么、截止、来自哪份资料的哪一段原文。 */
export function taskSummaryOf(
  item: FanoutItem,
  ctx: { source: FanoutSource; title: string; positions: number },
): string {
  const lines: string[] = []
  if (item.why !== undefined) lines.push(item.why)
  if (item.due !== undefined) lines.push(`截止：${item.due}`)
  lines.push(
    `来自「${ctx.title}」${ctx.positions > 1 ? `（同一批拆给了 ${ctx.positions} 个岗位）` : ''}：`,
  )
  lines.push(`> ${(item.quote ?? item.text).replace(/\n/gu, '\n> ')}`)
  return lines.join('\n')
}

export function createFanout(deps: FanoutDeps) {
  const { clock } = deps

  return {
    /** 模型调了 `plan_fanout`：认岗位 → 方案卡（什么都不发）。 */
    async plan(
      actor: FreeChatActor,
      input: Record<string, unknown>,
      source: FanoutSource,
    ): Promise<{ content: string; fanout?: FreeChatFanoutView }> {
      const list = await deps.mine(actor)
      const items = resolveFanout(list.map(deps.toPick), draftsOf(input))
      if (items.length === 0)
        return { content: json({ planned: false, reason: '没拆出任何一条（items 是空的）' }) }
      const title =
        typeof input.title === 'string' && input.title.trim() !== ''
          ? input.title.trim().slice(0, 40)
          : source.name
      const view: FreeChatFanoutView = {
        batch_id: deps.newId('fan'),
        title,
        source,
        items: items.map((i) => itemView(i, list)),
        positions: list
          .filter((p) => p.roles.some((r) => r.my_assignment_id !== undefined))
          .filter(
            (p) =>
              !p.roles
                .filter((r) => r.my_assignment_id !== undefined)
                .every((r) => r.role_id.startsWith('common.')),
          )
          .map((p) => ({
            position_id: p.position_id,
            name: p.name.zh,
            duties: p.roles
              .filter((r) => r.my_assignment_id !== undefined)
              .map((r) => ({ role_id: r.role_id, name: r.role_name })),
          })),
        status: 'proposed',
        at: clock.now(),
      }
      const count = (k: FanoutItem['kind']) => items.filter((i) => i.kind === k).length
      return {
        content: json({
          planned: true,
          note: '方案卡已经摆给用户：他点「就这样」才派、才记。不要再调派活工具重复派；简短说一句让他看一眼、可以勾掉或改归属。',
          tasks: count('task'),
          notes: count('note'),
          memories: count('memory'),
          unsure: items.filter((i) => i.unsure !== undefined).length,
          positions: [...new Set(view.items.flatMap((i) => i.position_name ?? []))],
        }),
        fanout: view,
      }
    },

    /** 人点了「就这样」：按（改过的）方案扇出。 */
    async send(
      actor: FreeChatActor,
      view: FreeChatFanoutView,
      edits: readonly FreeChatFanoutEditInput[],
    ): Promise<FanoutSent> {
      const list = await deps.mine(actor)
      const { send, skipped } = applyFanoutEdits(
        list.map(deps.toPick),
        view.items.map(itemOf),
        edits,
      )
      const at = clock.now()
      const nameOf = (id: string | undefined): string =>
        list.find((p) => p.position_id === id)?.name.zh ?? '岗位'
      const tasks = send.filter((i) => i.kind === 'task')
      const notes = send.filter((i) => i.kind === 'note')
      const touched = new Set([...tasks, ...notes].flatMap((i) => i.position_id ?? []))
      const groups = new Map<string, FreeChatFanoutSummaryView['groups'][number]>()
      const group = (id: string) => {
        let g = groups.get(id)
        if (g === undefined) {
          g = { position_id: id, name: nameOf(id), tasks: [], notes: 0 }
          groups.set(id, g)
        }
        return g
      }
      const failed: string[] = []
      const dispatches: FreeChatDispatchView[] = []
      for (const item of tasks) {
        const position_id = item.position_id as string
        try {
          const opened = await deps.open(actor, {
            position_id,
            ...(item.role_id === undefined ? {} : { role_id: item.role_id }),
            text: item.text,
            summary: taskSummaryOf(item, {
              source: view.source,
              title: view.title,
              positions: touched.size,
            }),
          })
          const p = list.find((x) => x.position_id === position_id)
          const duty =
            opened.role_name ?? p?.roles.find((r) => r.role_id === opened.role_id)?.role_name
          dispatches.push({
            matter_id: opened.matter_id,
            title: opened.title,
            position_id,
            position_name: nameOf(position_id),
            ...(opened.role_id === undefined ? {} : { role_id: opened.role_id }),
            ...(duty === undefined ? {} : { duty_name: duty }),
            at,
            batch_id: view.batch_id,
          })
          group(position_id).tasks.push({ matter_id: opened.matter_id, title: opened.title })
        } catch (e) {
          failed.push(
            `「${item.text.slice(0, 20)}」没交给${nameOf(position_id)}：${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      let knowledge_card_id: string | undefined
      let brand_notes = 0
      if (notes.length > 0) {
        if (deps.proposeNotes === undefined)
          failed.push(`要记的 ${notes.length} 条没写进去：这里没有知识库`)
        else {
          const cards = notes.map((item) =>
            fanoutNoteCard(item, {
              workspace_id: actor.workspace_id as WorkspaceId,
              owner: actor.person_id as PersonId,
              at: at as Iso8601,
              batch_id: view.batch_id,
              source_name: view.title,
              source_kind: view.source.kind,
              ...(item.brand === true
                ? { position_name: '品牌公共' }
                : { position_name: nameOf(item.position_id) }),
            }),
          )
          const byGroup = new Map<string, { text: string; quote?: string }[]>()
          for (const item of notes) {
            const name = item.brand === true ? '品牌公共' : nameOf(item.position_id)
            byGroup.set(name, [
              ...(byGroup.get(name) ?? []),
              { text: item.text, ...(item.quote === undefined ? {} : { quote: item.quote }) },
            ])
          }
          try {
            const out = await deps.proposeNotes(actor, {
              batch_id: view.batch_id,
              title: view.title,
              source: view.source,
              cards,
              groups: [...byGroup].map(([name, rows]) => ({ name, notes: rows })),
            })
            knowledge_card_id = out.approval_id
            for (const item of notes)
              if (item.brand === true) brand_notes += 1
              else group(item.position_id as string).notes += 1
          } catch (e) {
            failed.push(
              `要记的 ${notes.length} 条没写进去：${e instanceof Error ? e.message : String(e)}`,
            )
          }
        }
      }
      const memories = send.filter((i) => i.kind === 'memory').map((i) => i.text)
      const count = (k: 'dropped' | 'unsure' | 'secret') =>
        skipped.filter((s) => s.why_skipped === k).length
      const summary: FreeChatFanoutSummaryView = {
        batch_id: view.batch_id,
        title: view.title,
        groups: [...groups.values()],
        brand_notes,
        memories: memories.length,
        skipped: { dropped: count('dropped'), unsure: count('unsure'), secret: count('secret') },
        ...(knowledge_card_id === undefined ? {} : { knowledge_card_id }),
        ...(failed.length === 0 ? {} : { failed }),
        at,
      }
      const parts = summary.groups.map(
        (g) =>
          `${g.name}${g.tasks.length > 0 ? ` ${g.tasks.length} 件事` : ''}${g.notes > 0 ? ` ${g.notes} 条知识` : ''}`,
      )
      if (brand_notes > 0) parts.push(`品牌公共 ${brand_notes} 条知识`)
      if (memories.length > 0) parts.push(`我记下 ${memories.length} 条你的习惯`)
      const text =
        parts.length === 0
          ? '这一批什么都没发。'
          : `按「${view.title}」派好了：${parts.join('，')}。${
              notes.length > 0 && knowledge_card_id !== undefined ? '要记的那几条等你确认。' : ''
            }做完或要你拍板时，我在这里告诉你。`
      return { summary, dispatches, memories, text }
    },
  }
}

export type Fanout = ReturnType<typeof createFanout>
