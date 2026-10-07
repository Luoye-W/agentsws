/**
 * WP257（决策 156）：Telegram 群「群里的帖子」自动进帖（服务层：真 Telegram 适配器 + 内存里的 Telegram 替身，
 * 一个真 key 都不用、一跳都不出去）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 登记过的群里别人说的话进帖并打标签；机器人 / 系统消息 / 私聊 / 没登记的群不进；再读不重记 | 入库与去重 |
 * | 一跳写请求都没有、不出卡；事件不含正文 | 只读，不回复 |
 * | 按机器人记读到哪儿（`offset`），每页存一次；读到一半 500 了下一轮接着读，「重启」后照样接着读 | 断点续读 |
 * | 429 停下、隔两个周期再读；频率可调（5 分钟），改频率不冲掉读到哪儿 | 限速退避 |
 * | 隐私模式开着：照实说、写明怎么关；@它的那几条照样进；设成管理员后下一轮恢复 | privacy mode 提示 |
 * | 不在群里 / 设了 webhook（这一轮一跳 getUpdates 都不打；读的时候撞上 409 也照实说） | 缺什么照实说 |
 * | 一个群都没登记：不读（读走即确认，不白白读掉） | 不吞消息 |
 * | 登记时读群名、`@用户名` 换成数字 id；没连上时用默认名，连上后下一轮补 | 登记入口 |
 */
import type { ChangeKind, WorkspaceId } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSocialStore, type SocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import { createSocialService, type SocialServiceAssembly } from '../src/social-service.js'
import { createFakeTelegram, type FakeTelegram, TG_TOKEN } from './fake-telegram-api.js'

const WS = 'ws_1' as WorkspaceId
const T0 = '2026-10-07T10:00:00.000Z'
const GROUP = -1001234567890
const OTHER = -1009999999999
const MIN = 60_000

const actor = {
  workspace_id: WS,
  person_id: 'p_1',
  assignment_id: 'as_1',
  role_id: 'social.telegram-group',
} as never

let nowMs: number
let tg: FakeTelegram
let store: SocialStore
let connected: boolean
let events: { type: string; payload: Record<string, unknown> }[]

const now = () => new Date(nowMs).toISOString()

function service(): SocialServiceAssembly {
  const channels = createSocialChannels({
    workspace_id: WS,
    clock: { now },
    connections: () =>
      connected ? [{ id: 'conn_tg', service: 'telegram_bot', status: 'connected' }] : [],
    secrets: {
      available: true,
      get: () => ({ bot_token: TG_TOKEN }),
    } as unknown as Parameters<typeof createSocialChannels>[0]['secrets'],
    fetch: tg.fetch,
  })
  return createSocialService({
    workspace_id: WS,
    store,
    channels,
    clock: { now },
    approvals: {} as never,
    ledger: {
      stage: async () => {
        throw new Error('自动进帖不该出卡')
      },
      list: async (_f: { kind?: ChangeKind }) => [],
    },
    effectiveConfig: () => {
      throw new Error('不查生效配置')
    },
    appendEvent: (e) =>
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> }),
    random: () => 0.5,
    holdersOf: () => [],
    owner: async () => 'p_1',
    brandName: () => 'INMO',
  })
}

function register(chat = GROUP, id = 'sa_tg', name = 'INMO 用户群'): void {
  store.saveAccount({
    id,
    workspace_id: WS,
    channel: 'telegram_group',
    handle: String(chat),
    display_name: name,
    url: `https://t.me/c/${String(chat).replace(/^-100/u, '')}`,
    external_id: String(chat),
    observed_at: T0,
  })
}

const rows = (account_id = 'sa_tg') =>
  store.threads({ account_id }).sort((a, b) => Number(a.external_id) - Number(b.external_id))
const texts = (account_id = 'sa_tg') => rows(account_id).map((t) => t.text)
const reads = () => tg.calls.filter((c) => c === 'getUpdates').length

beforeEach(() => {
  nowMs = Date.parse(T0)
  tg = createFakeTelegram({ now })
  tg.chats.set(GROUP, {
    id: GROUP,
    title: 'INMO 用户群',
    username: 'inmo_users',
    type: 'supergroup',
  })
  tg.chats.set(OTHER, { id: OTHER, title: '别人的群', type: 'supergroup' })
  tg.botStatus.set(GROUP, 'member')
  tg.botStatus.set(OTHER, 'member')
  store = createSocialStore({ workspace_id: WS })
  connected = true
  events = []
})

describe('WP257 Telegram 自动进帖：入库、打标签、去重', () => {
  it('登记过的群里别人说的话进帖并打标签；其余不进；再读不重记；一跳写都没有、不出卡', async () => {
    tg.say(GROUP, '我的订单什么时候到？')
    tg.say(GROUP, '新品周五上架', { bot: true })
    tg.say(GROUP, '', { service: true })
    tg.say(GROUP, '进群看福利 t.me/+AbCd123')
    tg.say(GROUP, '这个能连 iPhone 吗？', { mentionBot: true })
    tg.say(OTHER, '别人的群里的话')
    tg.say(777, '私聊机器人')
    register()
    const svc = service()

    const first = await svc.ingest.sweep()
    expect(first.ingested).toBe(3)
    expect(texts()).toEqual([
      '我的订单什么时候到？',
      '进群看福利 t.me/+AbCd123',
      '@inmo_helper_bot 这个能连 iPhone 吗？',
    ])
    expect(rows().map((r) => [r.triage, r.triage_by])).toEqual([
      ['customer_question', 'rule'],
      ['spam', 'rule'],
      ['customer_question', 'rule'],
    ])
    expect(rows()[0]?.id).toBe(`ct_telegram_${GROUP}_1`)
    expect(rows()[0]).toMatchObject({
      channel: 'telegram_group',
      status: 'open',
      surface: 'thread',
    })
    // 只打标签：不转客服（状态还是 open、没有卡 id）
    expect(rows().every((r) => r.status === 'open' && r.routed_approval_id === undefined)).toBe(
      true,
    )

    nowMs += 15 * MIN
    tg.say(GROUP, '颜色好看', { replyTo: { message_id: 1 } })
    const second = await svc.ingest.sweep()
    expect(second.ingested).toBe(1)
    expect(rows().at(-1)).toMatchObject({ text: '颜色好看', surface: 'comment', triage: 'other' })
    nowMs += 15 * MIN
    expect((await svc.ingest.sweep()).ingested).toBe(0)
    expect(texts()).toHaveLength(4)

    expect(tg.writes).toEqual([])
    expect(events.find((e) => e.type === 'social.threads_ingested')?.payload).toEqual({
      channel: 'telegram_group',
      account_id: 'sa_tg',
      count: 3,
    })
    expect(JSON.stringify(events)).not.toContain('订单')
    expect(svc.ingest.view(actor, 'telegram_group')).toMatchObject({
      auto: true,
      connected: true,
      every_minutes: 15,
      accounts: [{ account_id: 'sa_tg', state: 'ok' }],
    })
  })

  it('一个群都没登记：一跳 getUpdates 都不打（读走即确认，不白白读掉）', async () => {
    tg.say(GROUP, 'hello')
    await service().ingest.sweep()
    expect(reads()).toBe(0)
    expect(tg.pending).toHaveLength(1)
  })

  it('没连上：一跳不打，视图说没连上', async () => {
    connected = false
    register()
    tg.say(GROUP, 'hello')
    const svc = service()
    await svc.ingest.sweep()
    expect(tg.calls).toEqual([])
    expect(svc.ingest.view(actor, 'telegram_group')).toMatchObject({
      auto: true,
      connected: false,
      accounts: [{ state: 'not_connected' }],
    })
  })
})

describe('WP257 Telegram 自动进帖：断点续读与限速', () => {
  it('积压 650 条：一轮最多 5 页；读到一半 500 了下一轮接着读；「重启」后照样接着读；不漏不重', async () => {
    register()
    for (let i = 0; i < 650; i += 1) tg.say(GROUP, `第 ${i + 1} 条`)
    const r1 = await service().ingest.sweep()
    expect(r1.ingested).toBe(500)
    expect(reads()).toBe(5)

    // 下一轮：第一页成了、第二页 500 → 第一页那 100 条已记下，位置也存了
    nowMs += 15 * MIN
    tg.failNext = []
    const calls = tg.calls.length
    // 让第二次 getUpdates 失败
    const realFetch = tg.fetch
    let n = 0
    tg.fetch = async (input, init) => {
      if (input.endsWith('/getUpdates')) {
        n += 1
        if (n === 2) tg.failNext.push(500)
      }
      return realFetch(input, init)
    }
    const r2 = await service().ingest.sweep()
    expect(r2.ingested).toBe(100)
    expect(r2.skipped[0]?.reason).toContain('Telegram')
    expect(store.ingestState('sa_tg')).toMatchObject({ state: 'failed' })
    expect(tg.calls.length).toBeGreaterThan(calls)

    // 「重启」：新的服务实例、同一个库，从记下的位置接着读
    tg.fetch = realFetch
    nowMs += 15 * MIN
    const r3 = await service().ingest.sweep()
    expect(r3.ingested).toBe(50)
    const all = texts()
    expect(all).toHaveLength(650)
    expect(new Set(all).size).toBe(650)
    expect(all[649]).toBe('第 650 条')
    expect(store.ingestState('sa_tg')).toMatchObject({ state: 'ok', ingested_total: 650 })
  })

  it('429：停下，隔两个周期再读，读到的不丢；能改成 5 分钟、改频率不冲掉读到哪儿', async () => {
    register()
    tg.say(GROUP, 'first')
    const svc = service()
    await svc.ingest.sweep()
    const cursor = store.ingestState('settings:telegram_group')?.cursor
    expect(cursor).toBeDefined()

    nowMs += 15 * MIN
    tg.say(GROUP, 'second')
    tg.failNext.push(429)
    await svc.ingest.sweep()
    expect(store.ingestState('sa_tg')).toMatchObject({ state: 'limited' })
    expect(texts()).toEqual(['first'])
    // 一个周期后还不读
    nowMs += 15 * MIN
    const before = reads()
    await svc.ingest.sweep()
    expect(reads()).toBe(before)
    // 两个周期后读
    nowMs += 15 * MIN
    await svc.ingest.sweep()
    expect(texts()).toEqual(['first', 'second'])

    const view = svc.port.setIngestInterval?.(actor, {
      channel: 'telegram_group',
      every_minutes: 5,
    })
    expect(view).toMatchObject({ every_minutes: 5 })
    expect(store.ingestState('settings:telegram_group')?.cursor).toBeDefined()
    expect(store.ingestState('settings:telegram_group')?.cursor).not.toBe(cursor)
    nowMs += 5 * MIN
    tg.say(GROUP, 'third')
    await svc.ingest.sweep()
    expect(texts()).toEqual(['first', 'second', 'third'])
  })
})

describe('WP257 Telegram 自动进帖：缺什么照实说', () => {
  it('隐私模式开着：照实说、写明怎么关；@它的照样进；设成管理员后下一轮恢复，大家的话都进', async () => {
    tg.privacy = true
    register()
    tg.say(GROUP, '大家早')
    tg.say(GROUP, '怎么退货？', { mentionBot: true })
    const svc = service()
    await svc.ingest.sweep()
    const acc = svc.ingest.view(actor, 'telegram_group').accounts[0]
    expect(acc).toMatchObject({ state: 'missing_permissions', missing: ['privacy_mode'] })
    expect(acc?.message).toContain('/setprivacy')
    expect(acc?.message).toContain('BotFather')
    expect(texts()).toEqual(['@inmo_helper_bot 怎么退货？'])

    tg.botStatus.set(GROUP, 'administrator')
    nowMs += 15 * MIN
    tg.say(GROUP, '今天到货了')
    await svc.ingest.sweep()
    expect(svc.ingest.view(actor, 'telegram_group').accounts[0]).toMatchObject({ state: 'ok' })
    expect(svc.ingest.view(actor, 'telegram_group').accounts[0]?.missing).toBeUndefined()
    expect(texts()).toContain('今天到货了')
  })

  it('机器人不在群里 → 照实说；设了 webhook → 这一轮一跳 getUpdates 都不打', async () => {
    tg.botStatus.delete(GROUP)
    register()
    const svc = service()
    await svc.ingest.sweep()
    expect(svc.ingest.view(actor, 'telegram_group').accounts[0]).toMatchObject({
      state: 'missing_permissions',
      missing: ['bot_not_in_server'],
    })
    expect(svc.ingest.view(actor, 'telegram_group').accounts[0]?.message).toContain('不在这个群里')

    tg.botStatus.set(GROUP, 'member')
    tg.webhook = 'https://example.invalid/hook'
    nowMs += 15 * MIN
    const before = reads()
    await svc.ingest.sweep()
    expect(reads()).toBe(before)
    expect(svc.ingest.view(actor, 'telegram_group').accounts[0]).toMatchObject({
      state: 'missing_permissions',
      missing: ['webhook_active'],
    })
  })

  it('读的时候撞上 409（权限查过之后别处才设的 webhook）：照实说，下一轮查出来缺 webhook', async () => {
    register()
    const svc = service()
    await svc.ingest.sweep()
    tg.webhook = 'https://example.invalid/hook'
    nowMs += 15 * MIN
    await svc.ingest.sweep()
    expect(svc.ingest.view(actor, 'telegram_group').accounts[0]).toMatchObject({
      state: 'missing_permissions',
      missing: ['webhook_active'],
    })
    expect(tg.writes).toEqual([])
  })
})

describe('WP257 Telegram 登记：读群名', () => {
  it('@用户名登记：读到群名、换成数字 id；之后按数字 id 进帖', async () => {
    const svc = service()
    const row = await svc.port.createAccount(actor, {
      channel: 'telegram_group',
      handle: '@inmo_users',
      display_name: '@inmo_users',
      url: 'https://t.me/inmo_users',
      external_id: '@inmo_users',
    })
    expect(row).toMatchObject({ display_name: 'INMO 用户群', external_id: String(GROUP) })
    expect(tg.calls).toEqual(['getChat'])
    tg.say(GROUP, 'hello')
    await svc.ingest.sweep()
    expect(texts(row.id)).toEqual(['hello'])
  })

  it('没连上时登记：用默认名「群 末四位」；连上之后下一轮补上群名', async () => {
    connected = false
    const svc = service()
    const row = await svc.port.createAccount(actor, {
      channel: 'telegram_group',
      handle: String(GROUP),
      display_name: `群 ${String(GROUP).slice(-4)}`,
      url: 'https://t.me/c/1234567890',
      external_id: String(GROUP),
    })
    expect(row.display_name).toBe('群 7890')
    connected = true
    await svc.ingest.sweep()
    expect(store.account(row.id)?.display_name).toBe('INMO 用户群')
  })
})
