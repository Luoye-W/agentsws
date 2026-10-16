/**
 * WP350（决策 900）：「我的助理」把一份资料拆给几个岗位时，**要记的那几条**怎么进知识库。
 *
 * **WP357（决策 902，Luoye 10-16 改）**：方案卡上点一次「就这样」= 事派出去 + 口径**直接生效**，
 * 不再出第二张「要记的 N 条」确认卡（同 FAQ 导入 ① ② 人自己点了就生效的做法）：
 *
 * 1. **写进去就是 `active`**：照知识库入口先 `propose`（出处闸、冲突检测、状态词降级都照走），
 *    紧接着以**点「就这样」的那个人**的名义 `activate`——是人点的头，不是 Agent 自动激活；
 * 2. **每条都带出处**：出处 = 这份资料（`assistant:<批次>`，locator = 资料名，quote = 原文那一段）；
 * 3. **可改可删、能撤销**：`edit`（就地改正文，改之前那句留在 `structured.previous`，出处不变）、
 *    `retire`（退役 = 删，留痕不真删）；
 *    汇总卡上「撤销」= 这一批还生效的全部退役。只认 `assistant_note` 这一类、只认让助理记的那个人
 *    （别的知识照旧「写只经审批项」，19 §4）。
 *
 * 归哪个岗位记在条目的 `subject.id`（岗位 id；品牌公共是 `brand`），`subject.type = assistant_note`。
 *
 * WP350 那张整批确认卡（`form: 'assistant_notes'`）的处理（`onDecided`）留着：只在还有老卡没点时用得到。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  AssistantNotesPayload,
  Clock,
  FactCard,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { ASSISTANT_NOTES_FORM, isAssistantNotesPayload } from '@agentsws/contracts'
import { extractFactFingerprint, type Knowledge } from '@agentsws/knowledge'
import { FANOUT_NOTE_SUBJECT } from '@agentsws/roles'
import type { FanoutDeps } from './assistant-fanout.js'

const APPROVED = new Set(['approved', 'approved_edited', 'applying', 'applied'])

type RecordApply = (
  id: string,
  state: 'applying' | 'applied' | 'apply_failed',
  apply: ApprovalItem['apply'],
) => Promise<unknown>

/** 这张是不是助理扇出的「要记的 N 条」确认卡。 */
export function isAssistantNotesCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return item.kind === 'knowledge_update' && isAssistantNotesPayload(item.payload)
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 改 / 删一条助理记下的口径时，为什么不行（路由翻成 404 / 403 / 400）。 */
export class AssistantNoteError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid_input',
    message: string,
  ) {
    super(message)
  }
}

/** 一条改过的口径最长多少字（与方案卡上一条同一道）。 */
export const ASSISTANT_NOTE_MAX = 300

export function createAssistantNotes(deps: {
  clock: Clock
  knowledge: Knowledge
  approvals: ApprovalBus
  /** 这条分配是哪条职责（卡挂在哪条职责上）。 */
  roleOf(assignment_id: string): string | undefined
}) {
  const { knowledge, clock } = deps

  /** 决策 902：写进去就生效（人点的「就这样」）。 */
  const write: NonNullable<FanoutDeps['writeNotes']> = async (actor, input) => {
    const card_ids: string[] = []
    for (const card of input.cards) {
      const id = (await knowledge.store.propose(card)).id
      await knowledge.store.activate(id, actor.person_id as PersonId)
      card_ids.push(id)
    }
    return { card_ids }
  }

  /** 这条是不是这个人让助理记的、还没退役的口径。 */
  const mine = (
    actor: { workspace_id: string; person_id: string },
    id: string,
  ): FactCard & { status: 'proposed' | 'active' } => {
    const card = knowledge.store.getUnchecked(id)
    if (
      card === undefined ||
      card.workspace_id !== actor.workspace_id ||
      card.subject.type !== FANOUT_NOTE_SUBJECT ||
      card.status === 'retired'
    )
      throw new AssistantNoteError('not_found', '没有这条（可能已经删了）')
    if (card.owner !== actor.person_id)
      throw new AssistantNoteError('forbidden', '这条是别人让助理记的，改不了')
    return card as FactCard & { status: 'proposed' | 'active' }
  }

  /** 删一条（退役留痕，不真删）。 */
  const retire = async (
    actor: { workspace_id: string; person_id: string },
    id: string,
  ): Promise<FactCard> => {
    mine(actor, id)
    return knowledge.store.retire(id, actor.person_id as PersonId)
  }

  /**
   * 改一条：就地改正文（id、出处、归属、批次都不变，汇总卡上的「撤销」照样撤得到它），
   * 改之前那句记进 `structured.previous`（留痕，最多留 10 次），事实指纹按新正文重抽。
   */
  const edit = async (
    actor: { workspace_id: string; person_id: string },
    id: string,
    statement: string,
  ): Promise<FactCard> => {
    const text = statement.trim()
    if (text === '') throw new AssistantNoteError('invalid_input', '改成空的不行；不要这条就删掉')
    if (text.length > ASSISTANT_NOTE_MAX)
      throw new AssistantNoteError('invalid_input', `一条最多 ${ASSISTANT_NOTE_MAX} 字`)
    const old = mine(actor, id)
    if (text === old.statement) return old
    const previous = Array.isArray(old.structured?.previous)
      ? (old.structured.previous as unknown[])
      : []
    return knowledge.store.patch(id, {
      statement: text,
      fact_fingerprint: extractFactFingerprint(text),
      structured: {
        ...(old.structured ?? {}),
        previous: [
          ...previous,
          { statement: old.statement, at: clock.now(), by: actor.person_id },
        ].slice(-10),
      },
    })
  }

  /** 汇总卡上「撤销」：这一批里还没退役的全部退役；回撤了几条。 */
  const retireMany: NonNullable<FanoutDeps['retireNotes']> = async (actor, ids) => {
    let n = 0
    for (const id of ids) {
      const card = knowledge.store.getUnchecked(id)
      if (
        card === undefined ||
        card.status === 'retired' ||
        card.workspace_id !== actor.workspace_id ||
        card.subject.type !== FANOUT_NOTE_SUBJECT
      )
        continue
      await knowledge.store.retire(id, actor.person_id as PersonId)
      n += 1
    }
    return n
  }

  /** WP350 的老路：写成待确认 + 一张整批确认卡。决策 902 之后服务进程不再走这里（测试与老数据用）。 */
  const propose = async (
    actor: Parameters<NonNullable<FanoutDeps['writeNotes']>>[0],
    input: Parameters<NonNullable<FanoutDeps['writeNotes']>>[1],
  ): Promise<{ card_ids: string[]; approval_id?: string }> => {
    const card_ids: string[] = []
    for (const card of input.cards) card_ids.push((await knowledge.store.propose(card)).id)
    if (card_ids.length === 0) return { card_ids }
    const after = input.groups.map((g) => `${g.name} ${g.notes.length} 条`).join(' · ')
    const payload: AssistantNotesPayload = {
      form: ASSISTANT_NOTES_FORM,
      batch_id: input.batch_id,
      source: input.title,
      card_ids,
      groups: input.groups.map((g) => ({
        name: g.name,
        notes: g.notes.slice(0, 20).map((n) => ({
          text: clip(n.text, 200),
          ...(n.quote === undefined ? {} : { quote: clip(n.quote, 200) }),
        })),
      })),
      before: null,
      after,
    }
    const item = await deps.approvals.create<AssistantNotesPayload>({
      workspace_id: actor.workspace_id as WorkspaceId,
      schema_version: 1,
      kind: 'knowledge_update',
      role_id: (deps.roleOf(actor.assignment_id) ?? 'common.member') as RoleId,
      subject: { object: { type: 'policy', id: `assistant_notes:${input.batch_id}` } },
      dedupe_key: `${actor.workspace_id}:knowledge_update:assistant_notes:${input.batch_id}`,
      title: `「${clip(input.title, 30)}」里要记的 ${card_ids.length} 条`,
      summary: '通过后各岗位就照这几条说；不要就作废。',
      payload,
      evidence: {
        source_events: [],
        provenance: {
          seen: card_ids.slice(0, 20).map((id) => ({ type: 'fact_card' as const, id })),
        },
        diff: { before: null, after, summary: after },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: 'assistant' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: actor.person_id as PersonId, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
    return { card_ids, approval_id: item.id }
  }

  /** 确认卡被点了：通过 = 这一批生效；不要 = 作废（还是 `proposed` 的才动）。 */
  const onDecided = async (item: ApprovalItem): Promise<void> => {
    if (!isAssistantNotesCard(item)) return
    const by = item.decision?.by
    if (by === undefined || item.state === 'applied') return
    const p = item.payload as AssistantNotesPayload
    const still = p.card_ids.filter((id) => knowledge.store.getUnchecked(id)?.status === 'proposed')
    if (APPROVED.has(item.state)) {
      for (const id of still) await knowledge.store.activate(id, by)
      const record = (deps.approvals as Partial<{ recordApply: RecordApply }>).recordApply
      await record?.call(deps.approvals, item.id, 'applied', {
        attempts: [
          {
            at: clock.now(),
            by_executor: 'assistant-notes',
            idempotency_key: item.id,
            result: 'ok' as const,
          },
        ],
      })
    } else if (item.state === 'rejected')
      for (const id of still) await knowledge.store.retire(id, by)
  }

  return { write, edit, retire, retireMany, propose, onDecided }
}
