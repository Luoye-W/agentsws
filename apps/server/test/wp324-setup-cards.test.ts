/**
 * WP324（决策 690）：连接卡 / 配置卡的出现规则与补完接着做（单元：替身审批总线，不起服务）。
 *
 * - 同一缺项不重复出卡（第二件事挂到同一张上）；已经连上的不出；
 * - 在别处连好（连接清单变了）→ 卡自己收起、等着的都接着做，只做一次；
 * - 先不连 → 说一句、不接着做；
 * - 配置卡不收秘密格；保存时只认登记过的格子，没改的用建议值，必填空着就再出一张；
 * - 结构化缺项（`needs_setup` / `needs_connection` / 建站 / 管店 / 开发信）认得出，人话不认。
 */
import type { ApprovalBus, ApprovalItem, ConnectNeed } from '@agentsws/contracts'
import { isSecretLikeSetupKey } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { RunBlockLog, setupNeedOf } from '../src/run-blocked.js'
import { createSetupCards, type SetupTarget, valuesOf } from '../src/setup-cards.js'

const actor = { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'growth.ads' } as never

function fakeBus(): ApprovalBus & { items: Map<string, ApprovalItem> } {
  const items = new Map<string, ApprovalItem>()
  let n = 0
  const bus = {
    items,
    async create(raw: Partial<ApprovalItem>) {
      n += 1
      const item = { ...raw, id: `apr_${n}`, state: 'pending', revision: 1 } as ApprovalItem
      items.set(item.id, item)
      return item
    },
    async get(id: string) {
      return items.get(id)
    },
    async withdraw(id: string) {
      const it = items.get(id) as ApprovalItem
      it.state = 'withdrawn'
      return it
    },
  }
  return bus as never
}

const decide = (bus: ReturnType<typeof fakeBus>, id: string, action: string, edited?: unknown) => {
  const it = bus.items.get(id) as ApprovalItem
  it.state = action === 'reject' ? 'rejected' : 'approved'
  it.decision = { action, ...(edited === undefined ? {} : { edited_payload: edited }) } as never
  return it
}

function setup(connected: Record<string, boolean | undefined> = {}) {
  const bus = fakeBus()
  const resumed: { matter_id: string; text: string }[] = []
  const notes: string[] = []
  const cards = createSetupCards({
    workspace_id: 'ws_1',
    clock: { now: () => '2026-10-14T09:00:00.000Z' },
    approvals: () => bus,
    isConnected: async (need: ConnectNeed) => connected[need.kind],
    resume: async (t) => {
      resumed.push({ matter_id: t.matter_id, text: t.text })
    },
    note: (_m, text) => notes.push(text),
  })
  return { bus, cards, resumed, notes, connected }
}

const ADS: ConnectNeed = { kind: 'ads', service: 'meta_ads', name: 'Meta 广告', required: true }

describe('WP324 连接卡', () => {
  it('同一缺项第二件事不再出卡，挂到同一张上；已经连上的不出', async () => {
    const { bus, cards } = setup({ ads: false, shop: true })
    const one = await cards.askConnect({ actor, needs: [ADS], matter_id: 'mat_1' })
    const two = await cards.askConnect({ actor, needs: [ADS], matter_id: 'mat_2' })
    const again = await cards.askConnect({ actor, needs: [ADS], matter_id: 'mat_2' })
    expect(one?.attach).toBe(true)
    expect(two?.item.id).toBe(one?.item.id)
    expect(two?.attach).toBe(true)
    expect(again?.attach).toBe(false)
    expect(bus.items.size).toBe(1)
    // 广告这一路带一句风险告知；卡里没有任何凭据格
    const p = one?.item.payload as { risk?: string; needs: ConnectNeed[] }
    expect(p.risk).toMatch(/先出卡等你点头/)
    expect(JSON.stringify(p)).not.toMatch(/secret|token|password/i)
    const shop = await cards.askConnect({
      actor,
      needs: [{ kind: 'shop', service: 'shopify_admin', name: '店铺', required: true }],
      matter_id: 'mat_3',
    })
    expect(shop).toBeUndefined()
  })

  it('在别处连好 → 卡自己收起、等着的都接着做，只做一次', async () => {
    const env = setup({ ads: false })
    const one = await env.cards.askConnect({ actor, needs: [ADS], matter_id: 'mat_1' })
    await env.cards.askConnect({ actor, needs: [ADS], matter_id: 'mat_2' })
    expect(await env.cards.recheck()).toBe(0)
    env.connected.ads = true
    expect(await env.cards.recheck()).toBe(1)
    expect(env.bus.items.get(one?.item.id ?? '')?.state).toBe('withdrawn')
    expect(env.resumed.map((r) => r.matter_id)).toEqual(['mat_1', 'mat_2'])
    expect(env.resumed[0]?.text).toBe('连好了，接着做')
    // 人前后脚又点了「接着做」：不再跑第二遍
    await env.cards.onDecided(decide(env.bus, one?.item.id ?? '', 'approve'))
    expect(await env.cards.recheck()).toBe(0)
    expect(env.resumed).toHaveLength(2)
  })

  it('认不出连没连上（没有办法查）→ 人点「接着做」就信人；先不连 → 说一句、不接着做', async () => {
    const env = setup({})
    const one = await env.cards.askConnect({
      actor,
      needs: [{ kind: 'im:feishu', service: 'im:feishu', name: '飞书', required: true }],
      matter_id: 'mat_1',
    })
    await env.cards.onDecided(decide(env.bus, one?.item.id ?? '', 'approve'))
    expect(env.resumed).toHaveLength(1)
    const two = await env.cards.askConnect({ actor, needs: [ADS], matter_id: 'mat_9' })
    await env.cards.onDecided(decide(env.bus, two?.item.id ?? '', 'reject'))
    expect(env.notes.at(-1)).toMatch(/先不连了/)
    expect(env.resumed).toHaveLength(1)
  })
})

describe('WP324 配置卡', () => {
  const target = (saved: Record<string, string>[]): SetupTarget => ({
    id: 'x.region',
    name: '目标市场',
    why: '要知道往哪卖。',
    fields: async () => [
      {
        key: 'region',
        label: '目标市场',
        kind: 'select',
        options: [
          { value: 'us', label: '美国' },
          { value: 'de', label: '德国' },
        ],
        suggested: 'us',
        required: true,
      },
      { key: 'note', label: '备注', kind: 'text', required: false },
    ],
    satisfied: async () => saved.length > 0,
    apply: async (values) => {
      saved.push(values)
    },
  })

  it('建议值预填、调用方建议压过目标自己的；保存只认登记过的格子、接着做；设好了不再出', async () => {
    const env = setup()
    const saved: Record<string, string>[] = []
    env.cards.registerTarget(target(saved))
    const out = await env.cards.askSetup({
      actor,
      target: 'x.region',
      suggestions: { region: 'de' },
      matter_id: 'mat_1',
    })
    const p = out?.item.payload as { fields: { key: string; suggested?: string }[] }
    expect(p.fields[0]?.suggested).toBe('de')
    await env.cards.onDecided(
      decide(env.bus, out?.item.id ?? '', 'approve_edited', {
        ...(out?.item.payload as object),
        values: { region: 'us', api_key: 'sk-xxx', extra: 'y' },
      }),
    )
    expect(saved).toEqual([{ region: 'us' }])
    expect(env.resumed).toEqual([{ matter_id: 'mat_1', text: '设好了，接着做' }])
    expect(
      await env.cards.askSetup({ actor, target: 'x.region', matter_id: 'mat_2' }),
    ).toBeUndefined()
  })

  it('不收秘密格（改走连接卡的本机表单）', async () => {
    const env = setup()
    env.cards.registerTarget({
      id: 'x.secret',
      name: '钥匙',
      why: '',
      fields: async () => [{ key: 'api_key', label: 'API Key', kind: 'text', required: true }],
      satisfied: async () => false,
      apply: async () => undefined,
    })
    await expect(env.cards.askSetup({ actor, target: 'x.secret' })).rejects.toThrow(/连接卡/)
    expect(env.bus.items.size).toBe(0)
    expect(isSecretLikeSetupKey('password')).toBe(true)
    expect(isSecretLikeSetupKey('app_secret')).toBe(true)
    expect(isSecretLikeSetupKey('x', '飞书密钥')).toBe(true)
    expect(isSecretLikeSetupKey('postal_address', '公司实体地址')).toBe(false)
    expect(isSecretLikeSetupKey('store', '店铺地址')).toBe(false)
  })

  it('必填空着 → 不存、再出一张（等着的带过去）', async () => {
    const env = setup()
    const saved: Record<string, string>[] = []
    env.cards.registerTarget({
      ...target(saved),
      fields: async () => [{ key: 'region', label: '目标市场', kind: 'text', required: true }],
    })
    const out = await env.cards.askSetup({ actor, target: 'x.region', matter_id: 'mat_1' })
    await env.cards.onDecided(decide(env.bus, out?.item.id ?? '', 'approve'))
    expect(saved).toHaveLength(0)
    expect(env.notes.at(-1)).toMatch(/还没填/)
    expect(env.bus.items.size).toBe(2)
    expect(() =>
      valuesOf({
        form: 'setup_request',
        target: 'x',
        why: '',
        fields: [{ key: 'a', label: 'A', kind: 'text', required: true, suggested: 'ok' }],
      }),
    ).not.toThrow()
  })
})

describe('WP324 结构化缺项', () => {
  it('认机器码与结构化原因，不认人话', () => {
    expect(
      setupNeedOf('anything', { status: 'error', reason: 'needs_setup:company.address 先填地址' }),
    ).toEqual({
      kind: 'setup',
      target: 'company.address',
    })
    expect(
      setupNeedOf('sink_write', {
        status: 'ok',
        data: { needs_connection: 'im:feishu', connection_name: '飞书' },
      }),
    ).toMatchObject({ kind: 'connect', need: { service: 'im:feishu', name: '飞书' } })
    expect(
      setupNeedOf('theme_init_from_base', {
        status: 'error',
        reason: '…',
        data: { needs: 'login' },
      }),
    ).toMatchObject({ kind: 'connect', need: { service: 'site_theme' } })
    expect(
      setupNeedOf('theme_push', { status: 'error', reason: '…', data: { needs: 'store' } }),
    ).toEqual({
      kind: 'setup',
      target: 'site.store',
    })
    expect(
      setupNeedOf('shop_save_product', {
        status: 'error',
        reason: '…',
        data: { needs: 'authorize' },
      }),
    ).toMatchObject({ kind: 'connect', need: { service: 'shop_admin' } })
    expect(
      setupNeedOf('b2b_send', { status: 'ok', data: { queued_reason: 'company_address' } }),
    ).toEqual({
      kind: 'setup',
      target: 'company.address',
    })
    expect(
      setupNeedOf('x', { status: 'error', reason: '请到建站岗位页点「一键安装」' }),
    ).toBeUndefined()
  })

  it('一轮里攒下的：没连上比缺设置根本；接法去重', () => {
    const log = new RunBlockLog()
    log.noteSetup('theme_pull', {
      kind: 'connect',
      need: { kind: 'site_theme', service: 'site_theme', name: '建站工具', required: true },
    })
    log.noteSetup('theme_push', {
      kind: 'connect',
      need: { kind: 'site_theme', service: 'site_theme', name: '建站工具', required: true },
    })
    expect(log.block()).toMatchObject({ reason: 'needs_setup', services: ['site_theme'] })
    log.note('ads_report', 'not_connected', ['Meta 广告'], [ADS])
    expect(log.block()).toMatchObject({
      reason: 'not_connected',
      services: ['site_theme', 'meta_ads'],
    })
    expect(log.connectNeeds().map((n) => n.kind)).toEqual(['site_theme', 'ads'])
  })
})
