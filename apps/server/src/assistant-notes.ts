/**
 * WP350（决策 900）：「我的助理」把一份资料拆给几个岗位时，**要记的那几条**怎么进知识库。
 *
 * 照知识库的老规矩（19 §4 / 70 §3.5，与品牌分析建首批条目、FAQ 导入同一套）：
 *
 * 1. **一律 `proposed`**：人在方案卡上点的是「这样分」，不是「这句口径就是我们的」——
 *    在人点头之前，它不该被任何岗位当成口径引用；
 * 2. **每条都带出处**：出处 = 这份资料（`assistant:<批次>`，locator = 资料名，quote = 原文那一段）；
 * 3. **一批一张确认卡**（`knowledge_update` + `form: 'assistant_notes'`，与 FAQ 导入 ③ 的整批卡同一个样子）：
 *    通过 = 这一批全部生效；不要 = 这一批全部作废（退役留痕，不删）。各岗位第三栏「知识」里看得到「待你确认」。
 *
 * 归哪个岗位记在条目的 `subject.id`（岗位 id；品牌公共是 `brand`），`subject.type = assistant_note`。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  AssistantNotesPayload,
  Clock,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { ASSISTANT_NOTES_FORM, isAssistantNotesPayload } from '@agentsws/contracts'
import type { Knowledge } from '@agentsws/knowledge'
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

export function createAssistantNotes(deps: {
  clock: Clock
  knowledge: Knowledge
  approvals: ApprovalBus
  /** 这条分配是哪条职责（卡挂在哪条职责上）。 */
  roleOf(assignment_id: string): string | undefined
}) {
  const { knowledge, clock } = deps

  const propose: NonNullable<FanoutDeps['proposeNotes']> = async (actor, input) => {
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

  return { propose, onDecided }
}
