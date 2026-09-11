import { describe, expect, it } from 'vitest'
import type {
  ApprovalItem,
  Assignment,
  JoinExportBundle,
  JoinMappingPayload,
  JoinObjectComparison,
  KnowledgeGap,
  KnownEventType,
  ObjectOrigin,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeKind,
  RunRequest,
  StagedChange,
  TokenInfo,
  WorkspacePolicy,
} from '../src/index.js'
import { JOIN_OBJECT_KINDS, parseMarketId, SENSITIVITY_ORDER } from '../src/index.js'

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

  // ── WP50 / 45：个人用 → 公司用 ────────────────────────────────────
  it('45 H3：品牌与产品线记得住"被谁取代"和"谁带进来的"', () => {
    const origin: ObjectOrigin = { workspace_id: 'ws_solo', person_id: 'p_sun', object_id: 'rg_1' }
    const personal: Pick<RangeGroup, 'id' | 'superseded_by' | 'origin'> = {
      id: 'rg_1',
      superseded_by: 'rg_company_b',
    }
    const company: Pick<RangeGroup, 'id' | 'origin'> = { id: 'rg_company_b', origin }
    const line: Pick<ProductLine, 'id' | 'superseded_by'> = {
      id: 'pl_solo_kitchen',
      superseded_by: 'pl_company_kitchen',
    }
    expect([personal.superseded_by, company.origin?.person_id, line.superseded_by]).toEqual([
      'rg_company_b',
      'p_sun',
      'pl_company_kitchen',
    ])
    // 没合并过的那份两个字段都不在（`exactOptionalPropertyTypes`：不存在 ≠ undefined）
    expect(Object.keys(company)).not.toContain('superseded_by')
  })

  it('45 H2：join_mapping 的 payload 一张卡装三类对象 + 连接开关', () => {
    expect(JOIN_OBJECT_KINDS).toEqual(['range_group', 'product_line', 'store_range'])
    const brand: JoinObjectComparison = {
      kind: 'range_group',
      unique_key: 'brand:品牌乙',
      verdict: 'similar',
      mine: { id: 'rg_solo_b', name: '品牌乙', summary: '店 A、店 B' },
      theirs: { id: 'rg_b', name: '品牌B', summary: '店 A、店 C', holders: 2 },
      similarity: 0.6667,
      reasons: ['成员重合 50%'],
      suggested: 'merge_union',
      options: ['merge_union', 'adopt_company', 'keep_both'],
    }
    const payload: JoinMappingPayload = {
      join_id: 'join_1',
      source_workspace_id: 'ws_solo',
      target_workspace_id: 'ws_co',
      person_id: 'p_sun',
      objects: [brand],
      // 45 H2 第三条：凭据不自动走，默认开关是关的
      connections: [
        {
          connection_id: 'c_1',
          service: 'shopify_admin',
          label: 'Shopify · 店 B',
          transfer: false,
        },
      ],
      counts: { same: 0, similar: 1, missing: 0 },
    }
    expect(payload.connections[0]?.transfer).toBe(false)
    expect(payload.counts.similar).toBe(1)

    const bundle: Pick<JoinExportBundle, 'schema_version' | 'store_ranges'> = {
      schema_version: 1,
      store_ranges: [
        {
          range: { kind: 'store', id: 'store_b' },
          platform: 'shopify',
          external_id: 'glass-bowl.myshopify.com',
          name: '店 B',
        },
      ],
    }
    expect(bundle.store_ranges[0]?.external_id).toBe('glass-bowl.myshopify.com')
  })

  it('45 的三条新事件在册', () => {
    const types: KnownEventType[] = [
      'range_group.merged',
      'product_line.merged',
      'range.alias_resolved',
    ]
    expect(types).toHaveLength(3)
  })
})
