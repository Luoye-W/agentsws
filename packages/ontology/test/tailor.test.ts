/**
 * 47 J1「按岗位裁剪」与 J3「给模型的那段话」。
 *
 * 两条纪律在这里各有一组断言：
 * - 裁剪**只做减法**：售后看不见主题、动不了发布主题；
 * - 那段话**是纪律不是装饰**：超长时先砍对象清单，"先查状态再查政策"永远留着。
 */
import type { EffectiveAction, PermissionScope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  BRIEF_MAX_CHARS,
  ORDER_RULE,
  ontology,
  ontologyBrief,
  ontologyFor,
  ontologyForRun,
  orderTools,
  runOntologyBrief,
  toolGroup,
} from '../src/index.js'

const scope = (
  domain: PermissionScope['domain'],
  ops: PermissionScope['ops'],
  range: PermissionScope['range'],
): PermissionScope => ({ domain, ops, range, max_sensitivity: 'internal' })

const action = (id: string, over: Partial<EffectiveAction> = {}): EffectiveAction => ({
  id,
  target: 'order',
  kind: 'staged_change',
  mandate: { caps: {} },
  risk_class: 'medium',
  route_to: 'scope_manager',
  requires_record_read: true,
  protected_fields: [],
  review_cannot_be_disabled: false,
  ...over,
})

/** 与 `packages/roles/roles/dtc/aftersales.yml` 同形（那一份才是真源，这里只是复述）。 */
const AFTERSALES = {
  assignment_id: 'asg_1',
  role_id: 'dtc.aftersales',
  scopes: [
    scope('order', ['read'], 'assigned'),
    scope('shipment', ['read'], 'assigned'),
    scope('customer', ['read', 'stage'], 'assigned'),
    scope('knowledge', ['read', 'stage'], 'workspace'),
    scope('approval', ['read', 'stage', 'approve'], 'own'),
  ],
  actions: [
    action('stage_refund'),
    action('stage_reship'),
    action('reply_customer', { target: 'customer', kind: 'outbound_message', risk_class: 'low' }),
    // 售后压根没有这条（它是建站岗位的）——裁剪不该把它变出来
    action('stage_publish_theme', { target: 'content', risk_class: 'high' }),
  ],
}

describe('47 J1 按岗位裁剪', () => {
  const tailored = ontologyFor(AFTERSALES)

  it('只列有 read 权限的对象，范围取最宽的那条 scope', () => {
    const ids = tailored.objects.map((o) => o.id)
    expect(ids).toContain('order')
    expect(ids).toContain('customer')
    expect(ids).toContain('fact_card')
    // content 域没在 scopes 里 → 主题看不见
    expect(ids).not.toContain('theme')
    expect(tailored.objects.find((o) => o.id === 'order')?.read_range).toBe('assigned')
    expect(tailored.objects.find((o) => o.id === 'fact_card')?.read_range).toBe('workspace')
  })

  it('动作只留这条岗位声明过、且目标对象它读得到的那些', () => {
    const ids = tailored.actions.map((a) => a.id)
    expect(ids).toContain('stage_refund')
    expect(ids).toContain('reply_customer')
    // 主题读不到 → 发布主题就算写在 actions 里也走不了（15 §6 provenance 会拒）
    expect(ids).not.toContain('stage_publish_theme')
    // 登记表里根本没有的动作不会冒出来
    expect(ids).not.toContain('grant_assignment')
  })

  it('链接两端都得是他看得见的对象', () => {
    for (const l of tailored.links) {
      const ids = tailored.objects.map((o) => o.id)
      expect(ids).toContain(l.from)
      expect(ids).toContain(l.to)
    }
  })

  it('岗位越窄，看得见的东西越少', () => {
    const narrow = ontologyFor({
      assignment_id: 'asg_2',
      role_id: 'common.member',
      scopes: [scope('knowledge', ['read'], 'workspace')],
      actions: [],
    })
    expect(narrow.objects.length).toBeLessThan(tailored.objects.length)
    expect(narrow.actions).toEqual([])
  })
})

describe('47 J3 给模型的紧凑文本', () => {
  const brief = ontologyBrief(ontologyFor(AFTERSALES))

  it('不超过 1500 字', () => {
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
  })

  it('三段都在：能查什么 / 能做什么 / 顺序', () => {
    expect(brief).toContain('能查')
    expect(brief).toContain('能做')
    expect(brief).toContain(ORDER_RULE)
  })

  it('固定那一段是从登记表生成的，不是手写在提示词里的', () => {
    expect(ORDER_RULE).toContain('先查它的当前状态，再查相关政策')
    expect(ORDER_RULE).toContain('以当前状态为准')
    expect(ORDER_RULE).toContain('把矛盾报出来')
  })

  it('两次渲染逐字节相同（静态前缀要稳，22 §2）', () => {
    expect(ontologyBrief(ontologyFor(AFTERSALES))).toBe(brief)
  })

  it('超上限先砍对象清单，顺序那一段永远留着', () => {
    const squeezed = ontologyBrief(ontologyFor(AFTERSALES), 400)
    expect(squeezed.length).toBeLessThanOrEqual(400)
    expect(squeezed).toContain(ORDER_RULE)
  })

  it('按工具面裁剪：只说这次运行真摆出来的那些口', () => {
    const text = runOntologyBrief({
      assignment_id: 'asg_1',
      role_id: 'dtc.aftersales',
      tools: ['get_order', 'search_policies', 'stage_refund', 'draft_reply'],
    })
    expect(text).toContain('订单')
    expect(text).toContain('事实卡')
    expect(text).toContain('stage_refund')
    expect(text).toContain(ORDER_RULE)
    // 这次运行没摆商品的口 → 不许在提示词里许诺他查得到商品
    expect(text).not.toContain('商品')
  })

  it('一个工具都没有就不往 prompt 里塞废话', () => {
    expect(runOntologyBrief({ assignment_id: 'a', role_id: 'r', tools: [] })).toBe('')
  })

  it('工具面裁剪不谈范围（RunRequest 里没有 scopes，编不出来就不说）', () => {
    const tailored = ontologyForRun({
      assignment_id: 'asg_1',
      role_id: 'dtc.aftersales',
      tools: ['get_order'],
    })
    expect(tailored.objects.every((o) => o.read_range === undefined)).toBe(true)
  })
})

describe('47 J3 工具面三组排列', () => {
  it('查对象 → 查知识 → 提议动作', () => {
    expect(toolGroup('shopify_admin.get_order')).toBe('object')
    expect(toolGroup('get_order')).toBe('object')
    expect(toolGroup('search_policies')).toBe('knowledge')
    expect(toolGroup('stage_refund')).toBe('action')
    expect(toolGroup('draft_reply')).toBe('action')
  })

  it('判不出来的按最严解释：排到提议那一组', () => {
    expect(toolGroup('do_something_weird')).toBe('action')
  })

  it('排出来就是三组，组内按名字（同一份输入两次相同）', () => {
    const names = ['stage_refund', 'search_policies', 'list_orders', 'draft_reply', 'get_order']
    const ordered = orderTools(names)
    expect(ordered).toEqual([
      'get_order',
      'list_orders',
      'search_policies',
      'draft_reply',
      'stage_refund',
    ])
    expect(orderTools(names)).toEqual(ordered)
    // 只换顺序，不换名字
    expect([...ordered].sort()).toEqual([...names].sort())
  })

  it('登记表里在册的读 Action 一律进"查对象"组', () => {
    const reads = ontology().actions.filter((a) => a.access === 'read' && a.object !== 'fact_card')
    for (const a of reads.slice(0, 20)) expect(toolGroup(a.id), a.id).toBe('object')
  })
})
