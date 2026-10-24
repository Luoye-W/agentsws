/**
 * WP506（决策 1796 C）：**AI 提议停用 / 启用知识** → 一张确认卡 → 人点了才生效。
 *
 * - 工具 `propose_knowledge_toggle`（`knowledge-learn-tools.ts`）调 {@link KnowledgeToggle.propose}：
 *   按关键词 / id 找到这几条（看得见、没退役、确实要变的；最多 20 条），出一张
 *   `knowledge_update` + `form: 'knowledge_toggle'` 的卡（L1，一定要人点），**不改任何东西**；
 * - 卡批了 → {@link KnowledgeToggle.onDecided} 用批卡那个人的名义逐条 `setDisabled`（和知识库面板同一处）；
 *   不批 → 什么都不变；
 * - 批了之后的「撤销」在卡身里，人点、走只给人点的那个停用 / 启用接口。
 *
 * 真停用 / 启用的 HTTP 接口仍然只给人（AI 运行的令牌 403）：AI 这一路唯一能做的就是出这张卡。
 */
import {
  type ApprovalBus,
  type ApprovalItem,
  type CreateApprovalInput,
  type FactCard,
  isKnowledgeTogglePayload,
  KNOWLEDGE_TOGGLE_FORM,
  type KnowledgeTogglePayload,
  type PermissionScope,
  type RangeRef,
  type RoleId,
} from '@agentsws/contracts'
import type { Knowledge } from '@agentsws/knowledge'
import type { LearnActor } from './knowledge-learn.js'
import type { KnowledgeToggleInput, KnowledgeToggleProposal } from './knowledge-learn-tools.js'

/** 一张卡最多列几条（多了让人缩小范围再说）。 */
export const KNOWLEDGE_TOGGLE_MAX = 20

export function isKnowledgeToggleCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return item.kind === 'knowledge_update' && isKnowledgeTogglePayload(item.payload)
}

export interface KnowledgeToggle {
  propose(actor: LearnActor, input: KnowledgeToggleInput): Promise<KnowledgeToggleProposal>
  /** 卡定了：批了才逐条停用 / 启用；没批什么都不做。回真改了的那几条 id。 */
  onDecided(item: ApprovalItem): Promise<string[]>
}

export function createKnowledgeToggle(deps: {
  knowledge: Knowledge
  approvals: ApprovalBus
  /** 这条分配看得见哪些知识（同网关那一份：不做跨分配并集）。 */
  grantsOf(assignment_id: string): { scopes: PermissionScope[]; ranges: RangeRef[] }
  random(): number
}): KnowledgeToggle {
  const needle = (s: string): string => s.trim().toLowerCase()
  const want = (card: FactCard, action: KnowledgeToggleInput['action']): boolean =>
    action === 'disable' ? card.disabled_at === undefined : card.disabled_at !== undefined

  return {
    async propose(actor, input) {
      const config = deps.grantsOf(actor.assignment_id)
      const granted = {
        person_id: actor.person_id,
        workspace_id: actor.workspace_id,
        assignment_id: actor.assignment_id,
        role_id: actor.role_id,
        grants: config.scopes,
        ranges: config.ranges,
      }
      const all = (
        await deps.knowledge.store.list({ workspace_id: actor.workspace_id }, granted as never)
      ).filter((c) => c.status !== 'retired')
      const q = needle(input.query ?? '')
      const ids = new Set(input.ids ?? [])
      const hits = all.filter(
        (c) =>
          ids.has(c.id) ||
          (q !== '' && (needle(c.statement).includes(q) || needle(c.subject.key).includes(q))),
      )
      const verb = input.action === 'disable' ? '停用' : '启用'
      const todo = hits.filter((c) => want(c, input.action))
      if (todo.length === 0)
        return {
          ok: false,
          count: 0,
          message:
            hits.length === 0
              ? '知识库里没找到对得上的条目，没出卡。'
              : `找到的 ${hits.length} 条都已经是${verb}的了，没出卡。`,
        }
      if (todo.length > KNOWLEDGE_TOGGLE_MAX)
        return {
          ok: false,
          count: todo.length,
          message: `对得上的有 ${todo.length} 条，太多了（一张卡最多 ${KNOWLEDGE_TOGGLE_MAX} 条）。换个更具体的关键词再提。`,
        }
      const after = `${verb} ${todo.length} 条知识`
      const payload: KnowledgeTogglePayload = {
        form: KNOWLEDGE_TOGGLE_FORM,
        action: input.action,
        reason: input.reason,
        items: todo.map((c) => ({
          id: c.id,
          statement: c.statement.slice(0, 200),
          ...(c.stage === undefined ? {} : { stage: c.stage }),
        })),
        before: null,
        after,
      }
      const key = `${Math.floor(deps.random() * 0xffffffff).toString(36)}${Math.floor(deps.random() * 0xffffff).toString(36)}`
      const card: CreateApprovalInput<KnowledgeTogglePayload> = {
        workspace_id: actor.workspace_id,
        schema_version: 1,
        kind: 'knowledge_update',
        role_id: actor.role_id as RoleId,
        subject: { object: { type: 'policy', id: `knowledge_toggle:${key}` } },
        dedupe_key: `${actor.workspace_id}:knowledge_update:knowledge_toggle:${key}`,
        title: `${verb} ${todo.length} 条知识？`,
        // 界面少字：标题说了几条，这一句只说点了之后怎样
        summary:
          input.action === 'disable'
            ? '停用后回复和起草都不再用它们，随时能启用回来。'
            : '启用后回复和起草又会用到它们。',
        payload,
        evidence: {
          source_events: [],
          provenance: { seen: todo.map((c) => ({ type: 'fact_card' as const, id: c.id })) },
          diff: { before: null, after, summary: after },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
        proposer: {
          kind: 'agent',
          id: `agent_${actor.role_id}`,
          assignment_id: actor.assignment_id as never,
        },
        // L1：改的是客服回什么——一定要人点（同 1772「审核只人点」的理由）
        automation: { level_at_creation: 'L1' },
        routing: {
          recipients: [{ person: actor.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'queue',
      }
      const item = await deps.approvals.create(card)
      if (item.state === 'blocked')
        return { ok: false, count: todo.length, message: '这张卡被拦下了，没出。' }
      return {
        ok: true,
        approval_item_id: item.id,
        count: todo.length,
        message: `出了一张「${after}？」的卡，用户点了才生效。`,
      }
    },

    async onDecided(item) {
      if (!isKnowledgeToggleCard(item)) return []
      if (item.state !== 'approved' && item.state !== 'approved_edited') return []
      const by = item.decision?.by
      if (by === undefined || by === 'mandate') return []
      const payload = item.payload as KnowledgeTogglePayload
      const disabled = payload.action === 'disable'
      const done: string[] = []
      for (const { id } of payload.items) {
        // 只动这个品牌的、没退役的（卡上列的那几条；中间被删了 / 退役了就跳过）
        const card = deps.knowledge.store.getUnchecked(id)
        if (card === undefined || card.workspace_id !== item.workspace_id) continue
        if (card.status === 'retired') continue
        await deps.knowledge.store.setDisabled(id, by, disabled)
        done.push(id)
      }
      return done
    },
  }
}
