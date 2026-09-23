/**
 * WP119c：完整版面板要的那批端点，在**服务这一层**的行为。
 *
 * 三条贯穿的红线，每一条都有测试钉住：
 * 1. **评论文本只进自己的内容库**——内容观测的落库形状里连那一格都不存在；
 * 2. **联系方式明文只经加密库**——库里只有 key 名，解密要拿真钥；
 * 3. **云是加分项**——没关联云账号，本机的每一条路照常能走，回的是人话。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionObservation, ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicLibraryContributor } from '../src/extension-service.js'
import { createExtensionService } from '../src/extension-service.js'
import type { KolStore } from '../src/kol.js'
import { createKolStore } from '../src/kol.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from '../src/kol-service.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-22T10:00:00.000Z'
const DAY = 86_400_000
const at = (dayOffset: number): string => new Date(Date.parse(NOW) + dayOffset * DAY).toISOString()
const clock: Clock = { now: () => NOW }

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-ext119c-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const session: ExtensionSession = {
  token_id: 'ext_0001',
  workspace_id: WS,
  person_id: 'pr_1' as PersonId,
  extension_id: 'abcdefghijklmnop',
  scopes: ['kol.observe', 'kol.capture', 'kol.read'],
}

const obs = (over: Partial<ExtensionObservation> = {}): ExtensionObservation => ({
  channel: 'youtube',
  handle: '@fixture',
  display_name: '夹具频道',
  followers: 123_000,
  followers_text: '12.3万位订阅者',
  observed_at: NOW,
  source: 'channel_page',
  ...over,
})

/** 云端公共库的替身：三条 WP119c 的路都按脚本走。 */
function fakeCloud(over: Partial<PublicLibraryContributor> = {}): PublicLibraryContributor & {
  revealCalls: { channel: string; handle: string }[]
} {
  const revealCalls: { channel: string; handle: string }[] = []
  return {
    revealCalls,
    linked: () => true,
    contribute: async () => ({ accepted: 0 }),
    reveal: async (key) => {
      revealCalls.push({ channel: key.channel, handle: key.handle })
      return {
        ok: true,
        email: 'biz@fixture.example',
        source: 'public_library',
        at: NOW,
        credits: 1,
      }
    },
    contributeContact: async () => ({ ok: true, action: 'new', rewarded: true }),
    disputeContact: async () => ({ ok: true, message: '记下了。' }),
    ...over,
  }
}

/** 建一套真的库（sqlite 落临时目录）+ 一把加密库 + 一个可配置的云。 */
function assemble(cloud?: PublicLibraryContributor) {
  const dir = tmp()
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol,
    secrets,
    clock,
    random: () => 0.5,
    ...(cloud === undefined ? {} : { publicLibrary: cloud }),
    serverVersion: '0.1.0',
    workbenchUrl: () => 'http://127.0.0.1:4317',
    revealPriceCredits: () => 12,
  })
  return { kol, secrets, port }
}

describe('setup：品牌（工作区）/ 活动 / 候选池', () => {
  it('一个品牌就是一个组织、一个工作区（52 O1 的形状如实端出去）', async () => {
    const { port } = assemble()
    const setup = await port.setup(session)
    expect(setup.organizations).toEqual([{ id: WS, name: '我的品牌' }])
    expect(setup.workspaces[0]).toMatchObject({ id: WS, organization_id: WS })
    expect(setup.brands[0]).toMatchObject({ id: WS, workspace_id: WS, name: '我的品牌' })
    expect(setup.campaigns).toEqual([])
    expect(setup.creator_pool).toEqual({ total: 0, creators: [] })
  })

  it('候选池清单来自红人库，活动来自合作记录上的 campaign（不编活动）', async () => {
    const { kol, port } = assemble()
    await port.ingest(session, { observations: [obs()] })
    kol.saveCollaboration({
      id: 'col_1',
      creator_id: kol.accounts()[0]?.creator_id ?? 'cr_x',
      channel: 'youtube',
      stage: 'contacted',
      currency: 'USD',
      campaign_id: 'autumn-desk',
    })
    const setup = await port.setup(session)
    expect(setup.creator_pool.total).toBe(1)
    expect(setup.creator_pool.creators[0]).toMatchObject({ handle: '@fixture', channel: 'youtube' })
    expect(setup.campaigns).toEqual([
      { id: 'autumn-desk', brand_id: WS, name: 'autumn-desk', created_at: undefined },
    ])
  })
})

describe('creators：显式存入红人池', () => {
  it('第一次 ok，第二次 deduped；handle 与平台 id 认得同一个人', async () => {
    const { kol, port } = assemble()
    const first = await port.saveCreator(session, {
      channel: 'youtube',
      handle: '@fixture',
      external_id: 'UC123',
      display_name: '夹具频道',
      followers: 123_000,
      observed_at: NOW,
    })
    expect(first.status).toBe('ok')
    const second = await port.saveCreator(session, {
      channel: 'youtube',
      handle: 'fixture',
      followers: 130_000,
      observed_at: at(1),
    })
    expect(second.status).toBe('deduped')
    expect(kol.creators()).toHaveLength(1)
    // external_id 存下来了：下次拿 id 来问也找得到
    expect(kol.accounts()[0]?.external_id).toBe('UC123')
    expect(kol.accounts()[0]?.followers).toBe(130_000)
  })

  it('存入时带的商务邮箱进加密库，库里只有 key 名', async () => {
    const { kol, secrets, port } = assemble()
    await port.saveCreator(session, {
      channel: 'youtube',
      handle: '@fixture',
      contact: { kind: 'email', value: 'biz@fixture.example', source: 'channel_about' },
      observed_at: NOW,
    })
    const contact = kol.contacts()[0]
    expect(contact).toBeDefined()
    // 库里没有明文
    expect(JSON.stringify(kol.contacts())).not.toContain('biz@fixture.example')
    expect(secrets.get(contact?.value_ref ?? '')?.[CONTACT_SECRET_FIELD]).toBe(
      'biz@fixture.example',
    )
  })
})

describe('report：观测历史 + 粉丝趋势 + 已存状态', () => {
  it('库里没有这个人 = undefined（路由接 404）', async () => {
    const { port } = assemble()
    expect(
      await port.creatorReport(session, { channel: 'youtube', handle: 'nobody' }),
    ).toBeUndefined()
  })

  it('两次观测隔了几天 → 趋势有数、snapshot_count 是 2、tenant_pool 说已存', async () => {
    const { port } = assemble()
    await port.ingest(session, { observations: [obs({ observed_at: at(-10) })] })
    await port.ingest(session, {
      observations: [obs({ followers: 133_000, observed_at: NOW })],
    })
    const report = await port.creatorReport(session, { channel: 'youtube', handle: 'fixture' })
    expect(report).toBeDefined()
    expect(report?.report.snapshot_count).toBe(2)
    expect(report?.report.follower_trend).toEqual({ days: 10, delta: 10_000, percent: 8.1 })
    expect(report?.tenant_pool.saved).toBe(true)
    expect(report?.creator.display_name).toBe('夹具频道')
  })

  it('快照不足两个 → trend 是 null（不是编出来的 0）', async () => {
    const { port } = assemble()
    await port.ingest(session, { observations: [obs()] })
    const report = await port.creatorReport(session, { channel: 'youtube', handle: 'fixture' })
    expect(report?.report.follower_trend).toBeNull()
  })

  it('本机已有联系方式 → tenant_pool.email 给明文（「你已拥有」的那一格）', async () => {
    const { port } = assemble()
    await port.saveCreator(session, {
      channel: 'youtube',
      handle: '@fixture',
      contact: { kind: 'email', value: 'biz@fixture.example' },
      observed_at: NOW,
    })
    const report = await port.creatorReport(session, { channel: 'youtube', handle: 'fixture' })
    expect(report?.tenant_pool.email).toBe('biz@fixture.example')
  })
})

describe('reveal-pricing：看价不花钱', () => {
  it('价目来自装配（pricing.json 的 data.kol.lookup），窗口 30 天', async () => {
    const { port } = assemble()
    const pricing = await port.revealPricing(session)
    expect(pricing).toMatchObject({
      capability: 'data.kol.lookup',
      credits_per_reveal: 12,
      free_window_days: 30,
    })
  })
})

describe('contact：公共库 reveal / 贡献 / 争议', () => {
  it('本机已有邮箱 → 直接给、0 积分、不惊动云', async () => {
    const cloud = fakeCloud()
    const { port } = assemble(cloud)
    await port.saveContact(session, {
      channel: 'youtube',
      handle: '@fixture',
      contact_value: 'mine@fixture.example',
      contact_kind: 'email',
    })
    const out = await port.contactLookup(session, { channel: 'youtube', handle: 'fixture' })
    expect(out).toMatchObject({ status: 'found', credits_charged: 0 })
    if (out.status === 'found') expect(out.contact.value).toBe('mine@fixture.example')
    expect(cloud.revealCalls).toHaveLength(0)
  })

  it('本机没有 → 代理云端 reveal，取到后存进本机（下一次就免费）', async () => {
    const cloud = fakeCloud()
    const { kol, port } = assemble(cloud)
    const first = await port.contactLookup(session, { channel: 'youtube', handle: 'fixture' })
    expect(first).toMatchObject({ status: 'found', credits_charged: 1 })
    expect(cloud.revealCalls).toEqual([{ channel: 'youtube', handle: 'fixture' }])
    // 明文进了加密库，库里有了一行联系方式
    const contact = kol.contacts()[0]
    expect(contact?.source).toBe('public_library')
    const second = await port.contactLookup(session, { channel: 'youtube', handle: 'fixture' })
    expect(second).toMatchObject({ status: 'found', credits_charged: 0 })
  })

  it('云端说余额不足 → payment_required + 人话（说清去哪儿充值）', async () => {
    const cloud = fakeCloud({
      reveal: async () => ({
        ok: false as const,
        reason: 'insufficient_credits' as const,
        message: '积分不够',
      }),
    })
    const { port } = assemble(cloud)
    const out = await port.contactLookup(session, { channel: 'youtube', handle: 'fixture' })
    expect(out.status).toBe('payment_required')
    if (out.status === 'payment_required') {
      expect(out.credits_required).toBe(12)
      expect(out.message).toContain('设置 → 账号与积分')
    }
  })

  it('没关联云账号 → none + 人话（不编一个联系方式出来）', async () => {
    const { port } = assemble()
    const out = await port.contactLookup(session, { channel: 'youtube', handle: 'fixture' })
    expect(out.status).toBe('none')
    if (out.status === 'none') expect(out.message).toContain('云账号')
  })

  it('贡献：云端收下了 → recorded / new；没关联 → unavailable + 人话', async () => {
    const cloud = fakeCloud()
    const { port } = assemble(cloud)
    const out = await port.contactContribute(
      session,
      { channel: 'youtube', handle: 'fixture' },
      {
        value: 'found@fixture.example',
        source_url: 'https://www.youtube.com/@fixture/about',
      },
    )
    expect(out).toMatchObject({ status: 'recorded', action: 'new', rewarded: true })

    const { port: solo } = assemble()
    const soloOut = await solo.contactContribute(
      session,
      { channel: 'youtube', handle: 'fixture' },
      { value: 'found@fixture.example' },
    )
    expect(soloOut.status).toBe('unavailable')
    if (soloOut.status === 'unavailable') expect(soloOut.message).toContain('云账号')
  })

  it('争议：免费、云端只记不裁；没关联时如实说 noop', async () => {
    const { port } = assemble(fakeCloud())
    const out = await port.contactDispute(
      session,
      { channel: 'youtube', handle: 'fixture' },
      { value: 'biz@fixture.example' },
    )
    expect(out.status).toBe('recorded')

    const { port: solo } = assemble()
    const soloOut = await solo.contactDispute(
      session,
      { channel: 'youtube', handle: 'fixture' },
      { value: 'biz@fixture.example' },
    )
    expect(soloOut.status).toBe('noop')
  })
})

describe('contacts：写进自己红人池的联系方式行', () => {
  it('明文进加密库；同类重复写是幂等更新，不堆行', async () => {
    const { kol, secrets, port } = assemble()
    const first = await port.saveContact(session, {
      channel: 'youtube',
      handle: '@fixture',
      contact_value: 'mine@fixture.example',
      contact_kind: 'email',
      source: 'extension_manual_capture',
    })
    expect(first.status).toBe('ok')
    const again = await port.saveContact(session, {
      channel: 'youtube',
      handle: 'fixture',
      contact_value: 'new@fixture.example',
      contact_kind: 'email',
    })
    expect(again.status).toBe('ok')
    expect(again.contact_id).toBe(first.contact_id)
    expect(kol.contacts()).toHaveLength(1)
    expect(secrets.get(contactSecretId(first.contact_id ?? ''))?.[CONTACT_SECRET_FIELD]).toBe(
      'new@fixture.example',
    )
  })

  it('手机号不收；加密库没开也照实说 not_stored', async () => {
    const { port } = assemble()
    const phone = await port.saveContact(session, {
      channel: 'youtube',
      handle: '@fixture',
      contact_value: '+8610000000000',
      contact_kind: 'phone',
    })
    expect(phone.status).toBe('not_stored')
  })
})

describe('content-observations：公共池内容观测（红线）', () => {
  it('同一条内容同一天 → deduped；换一天 → ok', async () => {
    const { kol, port } = assemble()
    const input = {
      channel: 'youtube' as const,
      content_external_id: 'vid_1',
      content_type: 'video' as const,
      title: '一条视频',
      stats: { views: 10_000 },
      author: { external_id: 'UC123', handle: 'fixture' },
      captured_at: NOW,
    }
    const first = await port.contentObservation(session, input)
    expect(first.status).toBe('ok')
    const same = await port.contentObservation(session, { ...input, captured_at: at(0) })
    expect(same.status).toBe('deduped')
    const nextDay = await port.contentObservation(session, {
      ...input,
      stats: { views: 12_000 },
      captured_at: at(1),
    })
    expect(nextDay.status).toBe('ok')
    // 落库的形状里**没有评论这一格**——红线的另一半在类型上
    expect(JSON.stringify(kol.contentObservations())).not.toContain('comment')
    expect(kol.contentObservations()).toHaveLength(2)
  })

  it('作者已在库里时挂到那个人身上；不在也不炸', async () => {
    const { kol, port } = assemble()
    await port.ingest(session, { observations: [obs()] })
    await port.contentObservation(session, {
      channel: 'youtube',
      content_external_id: 'vid_2',
      content_type: 'video',
      title: '又一条',
      stats: {},
      author: { external_id: 'UC123', handle: 'fixture' },
      captured_at: NOW,
    })
    expect(kol.contentObservations()[0]?.creator_id).toBe(kol.accounts()[0]?.creator_id)
  })
})

describe('contents：存入自己的内容库（唯一可带评论的）', () => {
  const input = (comments?: number) => ({
    channel: 'youtube' as const,
    content_external_id: 'vid_1',
    content_type: 'video' as const,
    title: '一条视频',
    stats: { views: 10_000, comments: 500 },
    author: { external_id: 'UC123', handle: 'fixture' },
    captured_at: NOW,
    ...(comments === undefined
      ? {}
      : {
          captured_comments: Array.from({ length: comments }, (_, i) => ({
            text: `评论 ${i}`,
            like_count: i,
          })),
        }),
  })

  it('评论随入库保存（按点赞留最响的 200 条），回执说实存几条', async () => {
    const { kol, port } = assemble()
    const out = await port.contentSave(session, input(500))
    expect(out.status).toBe('ok')
    expect(out.comments_stored).toBe(200)
    const saved = kol.contents()[0]
    expect(saved?.comments).toHaveLength(200)
    // 留下来的是点赞最高的那批：排在最前的就是最响的那条
    expect(saved?.comments?.[0]?.text).toBe('评论 499')
  })

  it('同一条内容再存一次 = 更新（deduped），作者不在库里会先建档', async () => {
    const { kol, port } = assemble()
    const first = await port.contentSave(session, input(3))
    const again = await port.contentSave(session, input())
    expect(again.status).toBe('deduped')
    expect(again.content_id).toBe(first.content_id)
    expect(kol.contents()).toHaveLength(1)
    expect(kol.creators().length).toBeGreaterThanOrEqual(1)
  })
})

describe('bio-link-observations：简介外链页', () => {
  const input = {
    platform: 'linktree' as const,
    slug: 'fixture',
    source_url: 'https://linktr.ee/fixture',
    links: [{ title: 'My shop', url: 'https://shop.example' }],
    social_links: [{ type: 'INSTAGRAM', url: 'https://instagram.com/fixture' }],
    emails: ['biz@fixture.example'],
    captured_at: NOW,
  }

  it('第一次 ok，同 slug 再抓是覆盖（deduped）；页面存档了', async () => {
    const { kol, port } = assemble()
    expect(await port.bioLinkObservation(session, input)).toMatchObject({
      status: 'ok',
      attached_creators: 0,
    })
    expect(await port.bioLinkObservation(session, input)).toMatchObject({ status: 'deduped' })
    expect(kol.bioLinks()).toHaveLength(1)
    expect(kol.bioLinks()[0]?.links).toHaveLength(1)
  })
})

describe('seed-signature：种子频道主题词', () => {
  it('库里没有这个人 = undefined（路由接 404，面板不做预筛）', async () => {
    const { port } = assemble()
    expect(
      await port.seedSignature(session, { channel: 'youtube', handle: 'nobody' }),
    ).toBeUndefined()
  })

  it('类目与存过的内容标题出主题词；空种子给空清单', async () => {
    const { kol, port } = assemble()
    await port.ingest(session, { observations: [obs()] })
    const creatorId = kol.accounts()[0]?.creator_id ?? ''
    kol.saveAccount({ ...kol.accounts()[0]!, category: '数码评测' })
    kol.saveContent({
      id: 'ct_1',
      creator_id: creatorId,
      channel: 'youtube',
      handle: 'fixture',
      content_external_id: 'vid_1',
      content_type: 'video',
      title: 'Mechanical Keyboard Review and Desk Setup Tour',
      captured_at: NOW,
    })
    const signature = await port.seedSignature(session, { channel: 'youtube', handle: 'fixture' })
    expect(signature?.topic_keywords).toContain('数码评测')
    expect(signature?.topic_keywords).toContain('keyboard')
  })
})

describe('hello：workbench_url', () => {
  it('装配给了基址就带上；深链的基底只有一个真源', async () => {
    const { port } = assemble()
    expect(await port.hello(session)).toMatchObject({
      workbench_url: 'http://127.0.0.1:4317',
    })
  })
})
