import { describe, expect, it } from 'vitest'
import type {
  ApprovalItem,
  KnowledgeGap,
  KnownEventType,
  RunRequest,
  StagedChange,
  TokenInfo,
  WorkspacePolicy,
} from '../src/index.js'
import { SENSITIVITY_ORDER } from '../src/index.js'

describe('contracts', () => {
  it('sensitivity order is total', () => {
    expect(SENSITIVITY_ORDER).toEqual(['public', 'internal', 'confidential', 'restricted'])
  })
  it('types compile for the canonical example (14 §12 / 15 §9)', () => {
    const change: Pick<StagedChange, 'kind' | 'risk_class' | 'status'> = {
      kind: 'refund',
      risk_class: 'medium',
      status: 'staged',
    }
    const item: Pick<ApprovalItem, 'kind' | 'state' | 'revision'> = {
      kind: 'outbound_draft',
      state: 'pending',
      revision: 1,
    }
    const req: Pick<RunRequest, 'kind' | 'tools'> = {
      kind: 'work_item',
      tools: { allow: [], connect_token: 't', side_effect_policy: 'executor' },
    }
    expect([change.kind, item.kind, req.kind]).toEqual(['refund', 'outbound_draft', 'work_item'])
  })

  it('WP35 收口的几处：事件名 / 缺口 / token 状态 / 保留期', () => {
    // 工作模型与对账的事件名进了 KnownEventType（摘要级，正文不进日志）
    const types: KnownEventType[] = [
      'todo.created',
      'todo.updated',
      'todo.done',
      'todo.dropped',
      'matter.opened',
      'matter.closed',
      'matter.message',
      'reconcile.started',
      'reconcile.finished',
    ]
    expect(types).toHaveLength(9)

    // 19 §4 的缺口对象（WP33 时只在网关包里）
    const gap: Pick<KnowledgeGap, 'status' | 'domain'> = { status: 'open', domain: 'company' }
    expect(gap.status).toBe('open')

    // 20 §3 的 token 状态（`IdentityService.tokenInfo?`）
    const info: Pick<TokenInfo, 'kind' | 'revoked'> = { kind: 'session', revoked: false }
    expect(info.revoked).toBe(false)

    // 保留期是显式字段，不是额度
    const policy: Pick<WorkspacePolicy, 'raw_retention_days'> = { raw_retention_days: 90 }
    expect(policy.raw_retention_days).toBe(90)
  })
})
