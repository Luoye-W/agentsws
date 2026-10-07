/**
 * WP256（决策 147）：Discord「群里的帖子」自动进帖（服务层：真 Discord 适配器 + 内存里的 Discord 替身，
 * 一个真 key 都不用、一跳都不出去）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 第一次读只取眼前一页里 7 天内的；机器人自己的、系统消息不进 | 「新帖」是别人刚说的话 |
 * | 同一条只记一次（再读、经接口进过的都不重记） | 去重 |
 * | 记上次读到的位置：下一轮从它往后读；读到一半 500 了，下一轮接着读，不漏不重；「重启」后照样接着读 | 断点续读 |
 * | 默认 15 分钟一次、可调；一轮每频道最多 5 页；429 停下整轮、隔两个周期再读 | 限速 |
 * | 缺「读取消息历史」/ 没开正文开关 / 不在服务器 → 照实说缺哪个、不读；补上了下一轮就读 | 没权限提示 |
 * | 只读：一跳写请求都没有、不出卡 | 不回复、不加反应 |
 */
import type { ChangeKind, WorkspaceId } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSocialStore, type SocialStore } from '../src/social.js'
import { createSocialChannels } from '../src/social-channels.js'
import { createSocialService, type SocialServiceAssembly } from '../src/social-service.js'
import { createFakeDiscord, type FakeDiscord, READ_MESSAGE_HISTORY } from './fake-discord-api.js'

const WS = 'ws_1' as WorkspaceId
const T0 = '2026-10-07T10:00:00.000Z'
const GUILD = '900000000000000001'
const CH = '900000000000000002'
const CH2 = '900000000000000003'
const MIN = 60_000

const actor = {
  workspace_id: WS,
  person_id: 'p_1',
  assignment_id: 'as_1',
  role_id: 'social.discord',
} as never

let nowMs: number
let discord: FakeDiscord
let store: SocialStore
let connected: boolean
let events: { type: string; payload: Record<string, unknown> }[]

const now = () => new Date(nowMs).toISOString()

function service(): SocialServiceAssembly {
  const channels = createSocialChannels({
    workspace_id: WS,
    clock: { now },
    connections: () =>
      connected ? [{ id: 'conn_dc', service: 'discord_bot', status: 'connected' }] : [],
    secrets: {
      available: true,
      get: () => ({ bot_token: 'DISCORD-TEST-TOKEN' }),
    } as unknown as Parameters<typeof createSocialChannels>[0]['secrets'],
    fetch: discord.fetch,
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
  })
}

function register(channel = CH, id = 'sa_dc'): void {
  store.saveAccount({
    id,
    workspace_id: WS,
    channel: 'discord',
    handle: 'nordvolt-desk',
    display_name: `Nordvolt #${channel.slice(-1)}`,
    url: `https://discord.com/channels/${GUILD}/${channel}`,
    external_id: `${GUILD}/${channel}`,
    observed_at: T0,
  })
}

const texts = (account_id = 'sa_dc') =>
  store
    .threads({ account_id })
    .sort((a, b) => (BigInt(a.external_id) < BigInt(b.external_id) ? -1 : 1))
    .map((t) => t.text)

const messageReads = () => discord.calls.filter((c) => c.includes('/messages'))

beforeEach(() => {
  nowMs = Date.parse(T0)
  discord = createFakeDiscord({ guild: GUILD, now })
  discord.channels.set(CH, [])
  discord.channels.set(CH2, [])
  store = createSocialStore({ workspace_id: WS })
  connected = true
  events = []
})

describe('WP256 Discord 自动进帖：入库与去重', () => {
  it('第一次读：只取 7 天内、只记别人说的话；再读不重记；一跳写都没有、不出卡', async () => {
    discord.say(CH, '上个月的老消息', { at: '2026-09-01T00:00:00.000Z' })
    discord.say(CH, '这个支架能放 17 寸吗？')
    discord.say(CH, '新公告：周末发货', { bot: true })
    discord.say(CH, '', { type: 7 }) // 入群提示
    discord.say(CH, '颜色好看')
    register()
    const svc = service()

    const first = await svc.ingest.sweep()
    expect(first).toMatchObject({ read: 1, ingested: 2 })
    expect(texts()).toEqual(['这个支架能放 17 寸吗？', '颜色好看'])
    const row = store.threads({ account_id: 'sa_dc' })[0]
    expect(row).toMatchObject({ channel: 'discord', status: 'open', surface: 'thread' })
    expect(row?.id).toBe(`ct_discord_${row?.external_id}`)
    expect(row?.triage).toBeUndefined()

    // 15 分钟到了再读：没有新消息 → 不重记
    nowMs += 15 * MIN
    expect(await svc.ingest.sweep()).toMatchObject({ read: 1, ingested: 0 })
    expect(texts()).toHaveLength(2)
    expect(discord.writes).toEqual([])
    expect(events.find((e) => e.type === 'social.threads_ingested')?.payload).toEqual({
      channel: 'discord',
      account_id: 'sa_dc',
      count: 2,
    })
    // 事件里没有正文
    expect(JSON.stringify(events)).not.toContain('支架')
  })

  it('经接口进过的同一条不重记；「群里的帖子」列表里看得到', async () => {
    register()
    const id = discord.say(CH, 'hello from api')
    store.saveThread({
      id: 'ct_manual',
      account_id: 'sa_dc',
      channel: 'discord',
      external_id: id,
      surface: 'thread',
      author_external_id: 'u_1',
      author_handle: 'member1',
      text: 'hello from api',
      created_at: T0,
      status: 'open',
    })
    discord.say(CH, 'second')
    const svc = service()
    await svc.ingest.sweep()
    expect(texts()).toEqual(['hello from api', 'second'])
    const list = await svc.port.threads(actor, { channel: 'discord', open: true })
    expect(list.rows.map((r) => r.text).sort()).toEqual(['hello from api', 'second'])
  })
})

describe('WP256 Discord 自动进帖：断点续读与频率', () => {
  it('从上次读到的位置往后读；不到 15 分钟不读；能改成 5 分钟', async () => {
    register()
    discord.say(CH, 'm1')
    const svc = service()
    await svc.ingest.sweep()
    const cursor = store.ingestState('sa_dc')?.cursor
    expect(cursor).toBeDefined()

    discord.say(CH, 'm2')
    discord.say(CH, '我们发的', { bot: true })
    nowMs += 10 * MIN
    expect(await svc.ingest.sweep()).toMatchObject({ read: 0 })
    nowMs += 5 * MIN
    await svc.ingest.sweep()
    expect(texts()).toEqual(['m1', 'm2'])
    expect(messageReads().at(-1)).toContain(`after=${cursor}`)
    // 位置记到最后一条（含机器人那条），下一轮不再读它
    expect(store.ingestState('sa_dc')?.cursor).toBe(discord.channels.get(CH)?.at(-1)?.id)

    const view = svc.port.ingestStatus?.(actor, 'discord')
    expect(view).toMatchObject({ auto: true, connected: true, every_minutes: 15 })
    const changed = await svc.port.setIngestInterval?.(actor, {
      channel: 'discord',
      every_minutes: 5,
    })
    expect(changed).toMatchObject({ every_minutes: 5 })
    discord.say(CH, 'm3')
    nowMs += 5 * MIN
    await svc.ingest.sweep()
    expect(texts()).toEqual(['m1', 'm2', 'm3'])
    expect(() => svc.ingest.setInterval(actor, { channel: 'discord', every_minutes: 1 })).toThrow()
  })

  it('一轮最多 5 页；读到一半 500 了下一轮接着读；换一个进程（重启）也从记下的位置接着读', async () => {
    register()
    discord.say(CH, 'seed')
    await service().ingest.sweep()
    for (let i = 0; i < 650; i += 1) discord.say(CH, `n${i}`)

    // 第 3 页 500：前两页（200 条）已经记下、位置也记下了
    nowMs += 15 * MIN
    let n = 0
    discord.failAt = () => {
      n += 1
      return n === 3 ? 500 : undefined
    }
    const broken = await service().ingest.sweep()
    discord.failAt = undefined
    expect(broken.ingested).toBe(200)
    expect(store.ingestState('sa_dc')).toMatchObject({ state: 'failed' })
    expect(store.ingestState('sa_dc')?.message).toContain('500')

    // 「重启」：新的服务实例、同一个库
    nowMs += 15 * MIN
    const after = await service().ingest.sweep()
    // 一轮最多 5 页 × 100
    expect(after.ingested).toBe(450)
    expect(store.ingestState('sa_dc')?.state).toBe('ok')
    nowMs += 15 * MIN
    await service().ingest.sweep()
    const all = texts()
    expect(all).toHaveLength(651)
    expect(new Set(all).size).toBe(651)
    expect(all.at(-1)).toBe('n649')
  })

  it('429：这一轮所有频道都停下，隔两个周期再读，读到的不丢', async () => {
    register(CH, 'sa_a')
    register(CH2, 'sa_b')
    discord.say(CH, 'a1')
    discord.say(CH2, 'b1')
    const svc = service()
    await svc.ingest.sweep()
    discord.say(CH, 'a2')
    discord.say(CH2, 'b2')

    nowMs += 15 * MIN
    discord.failNext.push(429)
    const before = messageReads().length
    const limited = await svc.ingest.sweep()
    expect(messageReads().length - before).toBe(1)
    expect(limited.skipped[0]?.reason).toContain('429')
    expect(store.ingestState('sa_a')).toMatchObject({ state: 'limited' })
    expect(svc.ingest.view(actor, 'discord').accounts[0]).toMatchObject({ state: 'limited' })

    nowMs += 15 * MIN
    await svc.ingest.sweep()
    // 频道 b 照常读；频道 a 还在冷却
    expect(texts('sa_b')).toEqual(['b1', 'b2'])
    expect(texts('sa_a')).toEqual(['a1'])
    nowMs += 15 * MIN
    await svc.ingest.sweep()
    expect(texts('sa_a')).toEqual(['a1', 'a2'])
  })
})

describe('WP256 Discord 自动进帖：没权限 / 没连上 照实说', () => {
  it('缺「读取消息历史」→ 缺哪个、不读消息；补上之后下一轮就读', async () => {
    register()
    discord.say(CH, 'hidden question')
    discord.everyone = 1n << 10n
    discord.overwrites.set(CH, [
      { id: GUILD, type: 0, allow: '0', deny: READ_MESSAGE_HISTORY.toString() },
    ])
    const svc = service()
    const out = await svc.ingest.sweep()
    expect(out.ingested).toBe(0)
    expect(out.skipped[0]?.reason).toContain('「读取消息历史」权限')
    expect(messageReads()).toEqual([])
    const view = svc.port.ingestStatus?.(actor, 'discord')
    expect(view).toMatchObject({
      connected: true,
      accounts: [{ state: 'missing_permissions', missing: ['read_message_history'] }],
    })

    discord.overwrites.delete(CH)
    discord.everyone = (1n << 10n) | READ_MESSAGE_HISTORY
    nowMs += 15 * MIN
    await svc.ingest.sweep()
    expect(texts()).toEqual(['hidden question'])
    expect(svc.ingest.view(actor, 'discord').accounts[0]).toMatchObject({ state: 'ok' })
    expect(svc.ingest.view(actor, 'discord').accounts[0]?.missing).toBeUndefined()
  })

  it('没开 Message Content Intent / 机器人不在服务器里 → 各说各的', async () => {
    register()
    discord.say(CH, 'x')
    discord.appFlags = 0
    const svc = service()
    await svc.ingest.sweep()
    expect(svc.ingest.view(actor, 'discord').accounts[0]).toMatchObject({
      state: 'missing_permissions',
      missing: ['message_content'],
    })
    expect(svc.ingest.view(actor, 'discord').accounts[0]?.message).toContain(
      'Message Content Intent',
    )
    discord.appFlags = 1 << 19
    discord.botInGuild = false
    nowMs += 15 * MIN
    await svc.ingest.sweep()
    expect(svc.ingest.view(actor, 'discord').accounts[0]).toMatchObject({
      missing: ['bot_not_in_server'],
    })
    expect(store.threads()).toEqual([])
  })

  it('没连上：一跳不打，视图说没连上；只登记了服务器：说没给频道；别的渠道照实说不会自动拉', async () => {
    connected = false
    register()
    const svc = service()
    expect(await svc.ingest.sweep()).toMatchObject({ read: 0 })
    expect(discord.calls).toEqual([])
    expect(svc.ingest.view(actor, 'discord')).toMatchObject({
      connected: false,
      accounts: [{ state: 'not_connected' }],
    })

    connected = true
    store.saveAccount({ ...(store.account('sa_dc') as never), external_id: GUILD })
    await svc.ingest.sweep()
    expect(svc.ingest.view(actor, 'discord').accounts[0]).toMatchObject({ state: 'needs_channel' })
    expect(discord.calls).toEqual([])

    expect(svc.ingest.view(actor, 'telegram_group')).toMatchObject({ auto: false, accounts: [] })
  })

  it('还没轮到第一次读 → waiting；定时那一拍（publishDue）顺手读', async () => {
    register()
    discord.say(CH, 'via publishDue')
    const svc = service()
    expect(svc.ingest.view(actor, 'discord').accounts[0]).toMatchObject({ state: 'waiting' })
    await svc.publishDue()
    expect(texts()).toEqual(['via publishDue'])
  })
})
