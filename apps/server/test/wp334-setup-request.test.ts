/**
 * WP334（决策 724 / 726）：AI 自己要连接卡 / 配置卡（单元：替身审批总线，不起服务）。
 *
 * - `request_setup` 认得出要的是哪一样（连接目录 / 内置几样 / 登记过的设置目标），认不出就把能要的列给模型；
 * - 已经连上 / 设好了 → 不要卡，直接接着做；
 * - 「为什么」「建议值」里像口令 / 密钥的整条拒收，回话里不回显那段字；像秘密的设置键也拒；
 * - 工具回的结构化缺项（带为什么 / 建议值）→ 运行时那一路出卡：卡面用 AI 那句为什么、配置卡预填 AI 的建议值；
 * - 新认的几种机器码：`needs_connection:<service>`、`not_linked`、开发信一只邮箱都没有。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  ConnectNeed,
  SetupRequestPayload,
} from '@agentsws/contracts'
import { looksLikeSecretValue } from '@agentsws/contracts'
import { setupRequestBranch, type ToolExecution } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { RunBlockLog, setupNeedOf } from '../src/run-blocked.js'
import { createSetupCards, type SetupTarget } from '../src/setup-cards.js'
import { createSetupRequestTool } from '../src/setup-request-tool.js'
import { builtinSetupTargets } from '../src/setup-targets.js'

const actor = { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'common.owner' } as never

function fakeBus(): ApprovalBus & { items: Map<string, ApprovalItem> } {
  const items = new Map<string, ApprovalItem>()
  let n = 0
  return {
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
  } as never
}

const profile: SetupTarget & { saved?: Record<string, string>; done: boolean } = {
  id: 'company.profile',
  name: '公司档案',
  why: '默认那句',
  done: false,
  async fields() {
    return [
      { key: 'one_liner', label: '一句话介绍', kind: 'text', required: true },
      {
        key: 'currency',
        label: '币种',
        kind: 'select',
        options: [
          { value: 'USD', label: 'USD' },
          { value: 'EUR', label: 'EUR' },
        ],
        suggested: 'USD',
        required: false,
      },
    ]
  },
  async satisfied() {
    return profile.done
  },
  async apply(values) {
    profile.saved = values
    profile.done = true
  },
}

function rig(connected: Record<string, boolean | undefined> = {}) {
  const bus = fakeBus()
  const resumed: string[] = []
  const cards = createSetupCards({
    workspace_id: 'ws_1',
    clock: { now: () => '2026-10-15T09:00:00.000Z' },
    approvals: () => bus,
    isConnected: async (need: ConnectNeed) => connected[need.kind],
    resume: async (t) => {
      resumed.push(t.matter_id)
    },
  })
  cards.registerTarget(profile)
  const tool = createSetupRequestTool({
    directory: async () => [{ kind: 'email', service: 'imap_smtp', name: '邮箱' }],
    isConnected: async (need) => connected[need.kind],
    target: async (id) => cards.target(id),
    targetIds: async () => cards.targetIds(),
  })
  const call = (input: Record<string, unknown>) =>
    tool({ name: 'request_setup', input, request: { id: 'run_1' } as never })
  return { bus, cards, tool, call, resumed, connected }
}

/** 照运行时那一路走一遍：工具回执 → 结构化缺项 → 这一轮收尾出卡。 */
async function runBlocked(env: ReturnType<typeof rig>, res: ToolExecution, matter_id: string) {
  const log = new RunBlockLog()
  const need = setupNeedOf('request_setup', res)
  if (need !== undefined) log.noteSetup('request_setup', need)
  const block = log.block()
  if (block === undefined) return undefined
  return env.cards.onRunBlocked({
    run_id: 'run_1',
    matter_id,
    actor,
    block,
    needs: log.connectNeeds(),
    targets: log.setupTargets(),
    ...log.asked(),
  })
}

describe('WP334 request_setup：认得出要什么', () => {
  it('连接目录里的、内置那几样都认；认不出就把能要的列给模型', async () => {
    const env = rig({ email: false, 'im:wecom': false })
    const mail = await env.call({ connect: 'imap_smtp', why: '要用邮箱发开发信' })
    expect(mail.data).toMatchObject({
      ok: false,
      needs_connection: 'imap_smtp',
      connection_name: '邮箱',
      setup_why: '要用邮箱发开发信',
    })
    const wecom = await env.call({ connect: 'im:wecom', why: '要发到企业微信群' })
    expect(wecom.data).toMatchObject({ needs_connection: 'im:wecom', connection_name: '企业微信' })
    const bad = await env.call({ connect: 'myspace', why: '随便' })
    expect(bad.status).toBe('error')
    expect(bad.reason).toMatch(/^invalid_input：认不出「myspace」/)
    expect(bad.reason).toContain('workshop_account')
    const badSetting = await env.call({ setting: 'nope', why: '随便' })
    expect(badSetting.reason).toContain('company.profile')
    // 两个都给 / 都不给 / 没写为什么
    expect(
      (await env.call({ connect: 'model', setting: 'company.profile', why: 'x' })).status,
    ).toBe('error')
    expect((await env.call({ connect: 'model' })).reason).toMatch(/why/)
  })

  it('已经连上 / 设好了 → 不要卡，直接接着做', async () => {
    const env = rig({ model: true })
    const res = await env.call({ connect: 'model', why: '要用模型写稿' })
    expect(res.data).toMatchObject({ ok: true, already: true })
    expect(setupNeedOf('request_setup', res)).toBeUndefined()
  })

  it('口令永不进 AI 上下文：像秘密的为什么 / 建议值整条拒收，回话里不回显', async () => {
    const env = rig({ 'im:wecom': false })
    const leak = 'sk-live-9f8e7d6c5b4a3210ffeeddcc'
    const a = await env.call({ connect: 'im:wecom', why: `Secret 是 ${leak}，帮我连上` })
    expect(a.status).toBe('error')
    expect(a.reason).toMatch(/^secret_in_input/)
    expect(JSON.stringify(a)).not.toContain(leak)
    const b = await env.call({
      setting: 'company.profile',
      why: '要用公司介绍',
      suggestions: [{ key: 'api_key', value: 'abc' }],
    })
    expect(b.reason).toMatch(/^secret_in_input/)
    const c = await env.call({
      setting: 'company.profile',
      why: '要用公司介绍',
      suggestions: [{ key: 'one_liner', value: 'password: hunter2hunter2' }],
    })
    expect(c.reason).toMatch(/^secret_in_input/)
    expect(JSON.stringify(c)).not.toContain('hunter2')
    // 人话里正常的字不误拦
    expect(looksLikeSecretValue('要把每天的待办发到企业微信群里')).toBe(false)
    expect(looksLikeSecretValue('店铺是 6suegp-md.myshopify.com')).toBe(false)
  })
})

describe('WP334 AI 要卡 → 出卡 → 补完接着做', () => {
  it('连接卡：卡面用 AI 那句为什么；第二件事同一缺项挂到同一张；连好按原话接着做', async () => {
    const env = rig({ 'im:wecom': false })
    const res = await env.call({ connect: 'im:wecom', why: '要把日报发到企业微信群里' })
    const one = await runBlocked(env, res, 'mat_1')
    const two = await runBlocked(
      env,
      await env.call({ connect: 'im:wecom', why: '另一句' }),
      'mat_2',
    )
    expect(one?.item.kind).toBe('connect_request')
    expect(two?.item.id).toBe(one?.item.id)
    expect(env.bus.items.size).toBe(1)
    expect(one?.item.payload).toMatchObject({
      form: 'connect_request',
      why: '要把日报发到企业微信群里',
      needs: [{ kind: 'im:wecom', service: 'im:wecom', name: '企业微信' }],
    })
    env.connected['im:wecom'] = true
    expect(await env.cards.recheck()).toBe(1)
    expect(env.resumed).toEqual(['mat_1', 'mat_2'])
  })

  it('配置卡：AI 的建议值预填（下拉只认可选的）；保存 = 存进去、接着做', async () => {
    profile.done = false
    const env = rig()
    const res = await env.call({
      setting: 'company.profile',
      why: '写落地页要用公司一句话介绍',
      suggestions: [
        { key: 'one_liner', value: '给户外玩家做的轻量帐篷' },
        { key: 'currency', value: 'XYZ' },
        { key: 'not_a_field', value: '扔掉' },
      ],
    })
    const out = await runBlocked(env, res, 'mat_9')
    const payload = out?.item.payload as SetupRequestPayload
    expect(payload.why).toBe('写落地页要用公司一句话介绍')
    expect(payload.fields.find((f) => f.key === 'one_liner')?.suggested).toBe(
      '给户外玩家做的轻量帐篷',
    )
    expect(payload.fields.find((f) => f.key === 'currency')?.suggested).toBe('USD')
    expect(JSON.stringify(payload)).not.toContain('not_a_field')
    const item = env.bus.items.get(out?.item.id ?? '') as ApprovalItem
    item.state = 'approved'
    item.decision = { action: 'approve' } as never
    await env.cards.onDecided(item)
    expect(profile.saved).toEqual({ one_liner: '给户外玩家做的轻量帐篷', currency: 'USD' })
    expect(env.resumed).toEqual(['mat_9'])
  })
})

describe('WP334 新认的几种机器码（认码不认人话）', () => {
  it('needs_connection:<service> / not_linked / 一只邮箱都没有', () => {
    const viaReason = setupNeedOf('generate_image', {
      status: 'error',
      reason: 'needs_connection:workshop_account 生图还没配。',
    })
    expect(viaReason).toMatchObject({
      kind: 'connect',
      need: { kind: 'workshop_account', name: 'Agents 工坊账号' },
    })
    expect(
      setupNeedOf('search_creators', { status: 'error', reason: 'not_linked：还没关联' }),
    ).toMatchObject({ kind: 'connect', need: { kind: 'workshop_account' } })
    expect(
      setupNeedOf('browse_public', {
        status: 'ok',
        data: { ok: false, reason: 'not_linked', message: '…' },
      }),
    ).toMatchObject({ need: { kind: 'workshop_account' } })
    expect(
      setupNeedOf('start_outreach_round', {
        status: 'ok',
        data: { status: 'queued', queued_reason: 'sender_choice' },
      }),
    ).toMatchObject({ need: { kind: 'email', service: 'imap_smtp' } })
    // 有邮箱、出了「用哪只发」选择卡的不归这里
    expect(
      setupNeedOf('start_outreach_round', {
        status: 'ok',
        data: { status: 'queued', queued_reason: 'sender_choice', approval_item_id: 'apr_x' },
      }),
    ).toBeUndefined()
    // 人话里说「还没关联」不算
    expect(
      setupNeedOf('x', { status: 'error', reason: '还没关联 Agents 工坊账号' }),
    ).toBeUndefined()
  })
})

describe('WP334 公司档案配置卡 / stub 剧本', () => {
  it('公司档案：现有的值当建议值；一句话太短 / 邮箱不对就拒；存进去', async () => {
    let facts: { one_liner?: string; support_email?: string; currency?: string } = {
      support_email: 'hi@example.test',
    }
    const target = builtinSetupTargets({
      theme: async () => undefined,
      postalAddress: () => undefined,
      setPostalAddress: () => false,
      brandFacts: () => facts,
      setBrandFacts: (f) => {
        facts = { ...facts, ...f }
        return true
      },
    }).find((t) => t.id === 'company.profile')
    expect(target).toBeDefined()
    expect(await target?.satisfied()).toBe(false)
    const fields = (await target?.fields()) ?? []
    expect(fields.map((f) => f.key)).toEqual(['one_liner', 'support_email', 'currency'])
    expect(fields.find((f) => f.key === 'support_email')?.suggested).toBe('hi@example.test')
    await expect(target?.apply({ one_liner: '短' })).rejects.toThrow(/太短/)
    await expect(
      target?.apply({ one_liner: '给户外玩家做的帐篷', support_email: 'nope' }),
    ).rejects.toThrow(/邮箱/)
    await target?.apply({ one_liner: '给户外玩家做的帐篷', currency: 'EUR' })
    expect(facts).toMatchObject({ one_liner: '给户外玩家做的帐篷', currency: 'EUR' })
    expect(await target?.satisfied()).toBe(true)
  })

  it('stub 剧本：明说「先连上 X / 先填好 Y」才要卡；工具面里没有就一个字节不变', () => {
    const req = (allow: string[]) => ({ tools: { allow } }) as never
    const on = req(['request_setup'])
    expect(setupRequestBranch(on, '先连上企业微信，再发群里')?.input).toMatchObject({
      connect: 'im:wecom',
    })
    expect(setupRequestBranch(on, '帮我扫码绑上微信')?.input).toMatchObject({
      connect: 'im:wechat',
    })
    expect(setupRequestBranch(on, '先关联工坊账号')?.input).toMatchObject({
      connect: 'workshop_account',
    })
    expect(setupRequestBranch(on, '要先填好公司档案')?.input).toMatchObject({
      setting: 'company.profile',
    })
    expect(setupRequestBranch(on, '把企业微信群里的消息总结一下')).toBeUndefined()
    expect(setupRequestBranch(req([]), '先连上企业微信')).toBeUndefined()
  })
})
