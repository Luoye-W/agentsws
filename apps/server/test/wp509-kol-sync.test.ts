/**
 * WP509（决策 1730 B、1811）：一句话把红人同步到飞书表——**服务这一层**真跑一圈：
 * 读表头（ego 只读通道）→「同步设置」卡（列对应、按哪列认人、阶段词对选项）→ 批了（卡上改过的一并收下）→
 * 第一批：表里已有的人只改阶段 / 寄样单号，没有的人追加一行 → 红人库变了（阶段推进、新进一个人）→ 到点再写一批 →
 * 本机留痕、插件「数据同步」那一格的状态；停了不写；ego 里没登录照实说。
 *
 * ego 是进程内的假 ego（Playwright 无头 Chromium），页面是本机假飞书——不起真 ego、不联网、不碰真飞书。
 */
import { resolve } from 'node:path'
import type { KolActor } from '@agentsws/api'
import type { ApprovalItem, Clock } from '@agentsws/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runEgoRead } from '../src/ego-read/runner.js'
import { createKolStore } from '../src/kol.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from '../src/kol-service.js'
import { runEgoSheetWrite } from '../src/kol-sync/runner.js'
import { createKolSync, type KolSyncCardPayload, type KolSyncEgo } from '../src/kol-sync/service.js'
import { createKolSyncStore } from '../src/kol-sync/store.js'
import { createSecretStore } from '../src/secret-store.js'
import { launchChromium, playwrightEgo } from './fixtures/fake-ego-playwright.js'
import { type FakeFeishu, startFakeFeishu } from './fixtures/fake-feishu.js'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

const ROOT = resolve(import.meta.dirname, '../../..')
const WS = 'ws_1' as never
const T0 = Date.parse('2026-10-24T02:00:00.000Z')
let t = T0
const clock: Clock = { now: () => new Date(t).toISOString() }
const actor: KolActor = {
  workspace_id: WS,
  person_id: 'p_1' as never,
  assignment_id: 'as_1' as never,
  role_id: 'kol.youtube' as never,
}

const FIELDS = [
  { name: '红人', type: 1 },
  { name: '平台', type: 3, options: ['YouTube', 'TikTok'] },
  { name: '主页链接', type: 15 },
  { name: '粉丝', type: 2 },
  {
    name: '合作状态',
    type: 3,
    options: ['待联系', '已联系', '谈价中', '寄样中', '已发布', '拒绝'],
  },
  { name: '快递单号', type: 1 },
  { name: '编号', type: 20 },
]

let browser: Awaited<ReturnType<typeof launchChromium>>
let fake: FakeFeishu

beforeAll(async () => {
  browser = await launchChromium(ROOT)
  fake = await startFakeFeishu({
    baseOne1: {
      kind: 'bitable',
      title: '红人合作表',
      fields: FIELDS,
      rows: [
        [
          'Gadget Jonas',
          'YouTube',
          'https://www.youtube.com/@GadgetJonas',
          '9000',
          '谈价中',
          '',
          '1',
        ],
      ],
      addButton: true,
    },
    sheet1: {
      kind: 'sheet',
      title: '红人进展',
      rows: [['名字', '主页', '状态', '最新进展', '邮箱']],
    },
    login1: { kind: 'bitable', title: 'x', fields: FIELDS, rows: [], gate: 'login' },
  })
})
afterAll(async () => {
  await fake?.close()
  await browser?.close()
})

const rewrite = (u: string): string => {
  const url = new URL(u)
  return `${fake.origin}${url.pathname}${url.search}`
}

function setup() {
  const kol = createKolStore({ workspace_id: WS, now: clock.now })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'b'.repeat(64) },
  })
  const cards: ApprovalItem[] = []
  const approvals = {
    create: async (input: Record<string, unknown>) => {
      const item = { ...input, id: `apr_${cards.length + 1}`, state: 'pending', revision: 1 }
      cards.push(item as unknown as ApprovalItem)
      return item
    },
  }
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const pw = playwrightEgo(browser, { rewrite })
  let on = true
  const ego: KolSyncEgo = {
    available: () => on,
    read: (call) => runEgoRead({ egoPath: '/fake/ego-browser', call, spawn: pw.spawn }),
    write: (call) => runEgoSheetWrite({ egoPath: '/fake/ego-browser', call, spawn: pw.spawn }),
  }
  const store = createKolSyncStore()
  let n = 0
  const sync = createKolSync({
    workspace_id: WS,
    store,
    kol,
    secrets,
    clock,
    approvals: approvals as never,
    random: () => (n++ % 89) / 89,
    ego,
    appendEvent: (e) =>
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> }),
    tzOffsetMinutes: () => 480,
  })
  const person = (id: string, name: string, handle: string, followers: number) => {
    kol.saveCreator({ id, display_name: name, merged_from: [] })
    kol.saveAccount({
      id: `pa_${id}`,
      creator_id: id,
      channel: 'youtube',
      handle,
      url: `https://www.youtube.com/@${handle}`,
      followers,
      observed_at: clock.now(),
    })
  }
  const collab = (
    id: string,
    creator_id: string,
    stage: string,
    extra: Record<string, unknown> = {},
  ) =>
    kol.saveCollaboration({
      id,
      creator_id,
      channel: 'youtube',
      stage: stage as never,
      currency: 'USD',
      stage_changed_at: clock.now(),
      last_activity_at: clock.now(),
      ...extra,
    })
  return {
    kol,
    secrets,
    cards,
    events,
    sync,
    store,
    pw,
    person,
    collab,
    egoOff: () => (on = false),
  }
}

const approve = (card: ApprovalItem, edited: Record<string, unknown> = {}): ApprovalItem =>
  ({
    ...card,
    state: 'approved_edited',
    decision: {
      by: 'p_1',
      selected_option_id: 'start',
      edited_payload: { ...(card.payload as object), ...edited },
    },
  }) as unknown as ApprovalItem

describe('WP509 · 红人同步到飞书表（服务这一层，本机假飞书）', () => {
  it('读表头 → 同步设置卡 → 批了 → 第一批：已在表里的只改阶段 / 单号、没有的追加；再变一次到点再写；留痕与插件状态', async () => {
    const h = setup()
    h.person('cre_jonas', 'Gadget Jonas', 'gadgetjonas', 9000)
    h.collab('col_jonas', 'cre_jonas', 'sample_sent', {
      sample: {
        address_ref: 'x',
        address_masked: 'x',
        tracking_no: 'SF123',
        currency: 'USD',
        shipped_at: clock.now(),
      },
    })
    h.person('cre_desk', 'Desk Fixture', 'deskfixture', 48000)
    h.collab('col_desk', 'cre_desk', 'contacted')
    h.person('cre_pool', 'Pool Only', 'poolonly', 100)
    // 演练数据不同步
    h.kol.saveCreator({ id: 'cre_sbx', display_name: 'Sandbox', merged_from: [], sandbox: true })

    const got = await h.sync.propose(actor, {
      url: 'https://example.feishu.cn/base/baseOne1?table=tbl1',
      instruction: '把红人同步到我这张飞书表',
    })
    expect(got.ok, got.message).toBe(true)
    expect(got.message).toContain('红人合作表')
    const card = h.cards[0] as ApprovalItem
    const p = card.payload as KolSyncCardPayload
    expect(p.form).toBe('kol_sync')
    expect(Object.fromEntries(p.columns.map((c) => [c.name, c.field]))).toEqual({
      红人: 'name',
      平台: 'channel',
      主页链接: 'url',
      粉丝: 'followers',
      合作状态: 'stage',
      快递单号: 'sample_tracking',
      编号: null,
    })
    expect(p.key_column).toBe('主页链接')
    expect(p.stage_map.find((m) => m.stage === 'sample_sent')?.option).toBe('寄样中')
    expect(p.stage_map.find((m) => m.stage === 'closed')?.option).toBeNull()
    expect(p.counts).toMatchObject({ table_rows: 1, in_scope: 2, matched: 1, to_append: 1 })
    expect(p.preview).toContainEqual(['红人', 'Desk Fixture'])
    // 还没批：一格不写
    expect(fake.table('baseOne1').rows).toHaveLength(1)

    // 批了（卡上把「已结案」对成「已发布」，多久一次改成每小时）
    const decided = await h.sync.onDecided(
      approve(card, {
        cadence: 'hourly',
        stage_map: [{ stage: 'closed', option: '已发布' }],
      }),
    )
    expect(decided).toBe(true)
    await vi.waitFor(() => expect(h.sync.list().syncs[0]?.last_ok_at).toBeDefined(), {
      timeout: 120_000,
      interval: 200,
    })
    const rows = fake.table('baseOne1').rows
    expect(rows[0]).toEqual([
      'Gadget Jonas',
      'YouTube',
      'https://www.youtube.com/@GadgetJonas',
      '9000',
      '寄样中',
      'SF123',
      '1',
    ])
    expect(rows[1]?.slice(0, 6)).toEqual([
      'Desk Fixture',
      'YouTube',
      'https://www.youtube.com/@deskfixture',
      '48000',
      '已联系',
      '',
    ])
    expect(rows).toHaveLength(2)
    const view = h.sync.list().syncs[0]
    expect(view).toMatchObject({
      state: 'active',
      cadence: 'hourly',
      totals: { appended: 1, updated: 1, fallback: 0 },
    })
    const log1 = h.sync.log(view?.id ?? '')?.rows[0]
    expect(log1).toMatchObject({ trigger: 'first', state: 'ok', appended: 1, updated: 1 })
    expect(log1?.items.map((i) => [i.name, i.action, i.result])).toEqual([
      ['Gadget Jonas', 'update', 'updated'],
      ['Desk Fixture', 'append', 'appended'],
    ])

    // 红人库变了：Desk 谈起来了；进来一个新人（开同步之后才进库）
    t += 10 * 60_000
    h.collab('col_desk', 'cre_desk', 'negotiating')
    h.person('cre_new', 'New Face', 'newface', 2000)
    // 每小时一次：还没到点
    expect(await h.sync.tick()).toBe(0)
    t += 61 * 60_000
    expect(await h.sync.tick()).toBe(1)
    const after = fake.table('baseOne1').rows
    expect(after[1]?.[4]).toBe('谈价中')
    expect(after[2]?.slice(0, 3)).toEqual([
      'New Face',
      'YouTube',
      'https://www.youtube.com/@newface',
    ])
    expect(after).toHaveLength(3)
    // Pool Only 是开同步之前就在库里、又没有合作的人：不写
    expect(after.some((r) => r[0] === 'Pool Only')).toBe(false)
    // 单选项一个没新建
    expect(fake.table('baseOne1').fields?.[4]?.options).toEqual(FIELDS[4]?.options)

    // 插件「数据同步」那一格
    const st = h.sync.status()
    expect(st).toMatchObject({
      feishu: true,
      google_sheets: false,
      configured: true,
      name: '红人合作表',
      state: 'active',
      setup_path: '/influencer/sync',
    })
    expect(st.last_sync_at).toBeDefined()
    expect(h.sync.describe()).toContain('红人合作表')
    // 事件里没有正文（只有数）
    const run = h.events.find((e) => e.type === 'kol.sync_run')
    expect(run?.payload).toMatchObject({ state: 'ok' })
    expect(JSON.stringify(h.events)).not.toContain('Desk Fixture')

    // 停了不写；开了接着写
    const id = view?.id ?? ''
    await h.sync.control(id, 'pause')
    h.collab('col_jonas', 'cre_jonas', 'delivering')
    t += 2 * 3_600_000
    expect(await h.sync.tick()).toBe(0)
    await h.sync.control(id, 'resume')
    await h.sync.tick()
    // 「拍摄制作中」在选项里没有对应：那一格不写（不擅自建选项）；现在同步一次 = 没有要写的
    await h.sync.control(id, 'run')
    expect(fake.table('baseOne1').rows[0]?.[4]).toBe('寄样中')
    expect(h.sync.log(id)?.rows[0]).toMatchObject({ trigger: 'manual', state: 'nothing' })
    expect(h.sync.list().syncs[0]?.state).toBe('active')
    // 删掉：不再同步，留痕一起删
    expect(await h.sync.control(id, 'remove')).toEqual({ removed: true })
    expect(h.sync.list().syncs).toHaveLength(0)
  })

  it('电子表格（列都是字）：阶段写我们的阶段名、最新进展写一句；邮箱从加密库取', async () => {
    const h = setup()
    h.person('cre_a', 'Alpha Cam', 'alphacam', 1200)
    h.collab('col_a', 'cre_a', 'agreed')
    h.secrets.put(contactSecretId('ctc_a'), { [CONTACT_SECRET_FIELD]: 'alpha@creator.example' })
    h.kol.saveContact({
      id: 'ctc_a',
      creator_id: 'cre_a',
      kind: 'email',
      value_ref: contactSecretId('ctc_a'),
      source: 'manual',
    })
    const got = await h.sync.propose(actor, { url: 'https://example.feishu.cn/sheets/sheet1' })
    expect(got.ok, got.message).toBe(true)
    await h.sync.onDecided(approve(h.cards[0] as ApprovalItem))
    await vi.waitFor(() => expect(h.sync.list().syncs[0]?.last_ok_at).toBeDefined(), {
      timeout: 120_000,
      interval: 200,
    })
    expect(fake.table('sheet1').rows[1]?.slice(0, 3)).toEqual([
      'Alpha Cam',
      'https://www.youtube.com/@alphacam',
      '已签定',
    ])
    expect(fake.table('sheet1').rows[1]?.[3]).toContain('已签定')
    expect(fake.table('sheet1').rows[1]?.[4]).toBe('alpha@creator.example')
  })

  it('读不了照实说：ego 里没登录飞书 / ego 用不了 / 不是飞书表', async () => {
    const h = setup()
    const login = await h.sync.propose(actor, {
      url: 'https://example.feishu.cn/base/login1?table=tbl1',
    })
    expect(login).toMatchObject({ ok: false })
    expect(login.message).toContain('登录')
    const google = await h.sync.propose(actor, {
      url: 'https://docs.google.com/spreadsheets/d/abc/edit',
    })
    expect(google.message).toContain('Google 表格这一版还同步不了')
    h.egoOff()
    const off = await h.sync.propose(actor, {
      url: 'https://example.feishu.cn/base/baseOne1?table=tbl1',
    })
    expect(off.message).toContain('ego 这会儿用不了')
    expect(h.cards).toHaveLength(0)
  })

  it('点「不用」：这个同步不留', async () => {
    const h = setup()
    h.person('cre_a', 'Alpha Cam', 'alphacam', 1200)
    h.collab('col_a', 'cre_a', 'agreed')
    await h.sync.propose(actor, { url: 'https://example.feishu.cn/base/baseOne1?table=tbl1' })
    const card = h.cards[0] as ApprovalItem
    expect(h.store.sinks()).toHaveLength(1)
    expect(await h.sync.onDecided({ ...card, state: 'rejected' } as ApprovalItem)).toBe(true)
    expect(h.store.sinks()).toHaveLength(0)
  })
})
