import { describe, expect, it } from 'vitest'
import type {
  ApprovalItem,
  ApprovalKind,
  Assignment,
  Invite,
  KnowledgeGap,
  KnownEventType,
  MembershipRequest,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeKind,
  RunRequest,
  StagedChange,
  TokenInfo,
  Workspace,
  WorkspacePolicy,
  WorkspaceProfile,
} from '../src/index.js'
import { parseMarketId, SENSITIVITY_ORDER } from '../src/index.js'

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

describe('WP47 范围模型（44）', () => {
  it('RangeKind 多了 product_line，品牌不是范围种类', () => {
    const kinds: RangeKind[] = ['store', 'department', 'account', 'market', 'product_line']
    expect(kinds).toHaveLength(5)
  })

  it('market 的 id 是 `账号id:站点`（G4）', () => {
    expect(parseMarketId('amz_na:US')).toEqual({ account: 'amz_na', site: 'US' })
    // 没冒号、开头冒号、结尾冒号都不是合法市场 id
    expect(parseMarketId('amz_na')).toBeUndefined()
    expect(parseMarketId(':US')).toBeUndefined()
    expect(parseMarketId('amz_na:')).toBeUndefined()
  })

  it('范围组是一组范围的名字；产品线是账号 / 店铺内部的子集', () => {
    const group: Pick<RangeGroup, 'id' | 'name' | 'members'> = {
      id: 'rg_brand_b',
      name: '品牌乙',
      members: [
        { kind: 'account', id: 'amz_na' },
        { kind: 'store', id: 'store_b' },
      ],
    }
    expect(group.members.map((m) => m.kind)).toEqual(['account', 'store'])

    const shopify: ProductLineRule = { platform: 'shopify', tags: ['kitchen'] }
    const amazon: ProductLineRule = { platform: 'amazon', asins: ['B0001'] }
    const manual: ProductLineRule = { platform: 'manual', product_ids: ['prod_1'] }
    const line: Pick<ProductLine, 'id' | 'parent' | 'rule'> = {
      id: 'pl_kitchen',
      parent: { kind: 'market', id: 'amz_na:US' },
      rule: amazon,
    }
    expect([shopify.platform, manual.platform, line.rule.platform]).toEqual([
      'shopify',
      'manual',
      'amazon',
    ])
  })

  it('分配记得住范围是从哪个品牌展开的；六条事件 + 一条留痕事件在册', () => {
    const assignment: Pick<Assignment, 'ranges' | 'range_groups'> = {
      ranges: [{ kind: 'store', id: 'store_b' }],
      range_groups: ['rg_brand_b'],
    }
    expect(assignment.range_groups).toEqual(['rg_brand_b'])

    const types: KnownEventType[] = [
      'range_group.created',
      'range_group.updated',
      'range_group.deleted',
      'product_line.created',
      'product_line.updated',
      'product_line.deleted',
      'assignment.range_expanded',
    ]
    expect(types).toHaveLength(7)
  })

  it('WP51 / 46：公司档案、邀请码、申请加入，九条事件 + membership 这一种审批项', () => {
    // 46 §1 ①：公司全称 + 可选域名 + 发现开关；设过就有 set_at
    const profile: WorkspaceProfile = {
      legal_name: '深圳市诺伏特科技有限公司',
      domain: 'nordvolt.cn',
      discoverable: true,
      set_at: '2026-09-11T01:00:00.000Z',
    }
    const workspace: Pick<Workspace, 'profile'> = { profile }
    expect(workspace.profile?.discoverable).toBe(true)

    // 46 §2 I2：8 位人类可读码，24h，默认 5 次
    const invite: Invite = {
      code: 'K7M2PQR4',
      workspace_id: 'ws_1',
      created_by: 'p_1',
      expires_at: '2026-09-12T01:00:00.000Z',
      uses_left: 5,
    }
    expect(invite.code).toHaveLength(8)

    // 46 §2 I3：申请里只有名字与邮箱，一条业务数据都没有
    const request: MembershipRequest = {
      id: 'mrq_1',
      workspace_id: 'ws_1',
      person: { name: '李默', email: 'li@nordvolt.cn' },
      via: 'lan',
      status: 'pending',
      created_at: '2026-09-11T01:05:00.000Z',
    }
    expect(Object.keys(request.person).sort()).toEqual(['email', 'name'])

    const types: KnownEventType[] = [
      'workspace.profile_set',
      'discovery.enabled',
      'discovery.disabled',
      'discovery.peer_seen',
      'invite.created',
      'invite.redeemed',
      'membership.requested',
      'membership.approved',
      'membership.rejected',
    ]
    expect(types).toHaveLength(9)

    const kind: ApprovalKind = 'membership'
    expect(kind).toBe('membership')
  })
})
