/**
 * WP489（决策 1683–1686）：红人表格 / 在线表导入、读过往邮件判合作阶段——服务端那一半。
 *
 * 钉住：① xlsx（合并表头 + 飞书导出样式的大标题 + Excel 日期序号）/ csv 都认得出列与状态；② 预览什么都不写；
 * ③ 已有红人只补空白；④ 带状态的行建合作，结束了的挂「历史合作（导入）」；⑤ 同一张表再导一次不重复建合作；
 * ⑥ 在线表：Google 导出页读得到、飞书页面文字读得到、登录页 / 没浏览器照实说；⑦ 邮件判阶段：一组模拟往来判出
 * 正确阶段并带依据、与表格冲突出卡、选「按邮件」才改；⑧ 预算到顶改按规则判；⑨ 对话里拖表出预览卡、点「导入」就导。
 * 夹具全是现编的假数据。
 */

import type { KolActor } from '@agentsws/api'
import type { ApprovalItem, Clock, MessageRecord } from '@agentsws/contracts'
import { LEGACY_IMPORT_CAMPAIGN_ID, type OnlinePageRead } from '@agentsws/kol-core'
import { describe, expect, it } from 'vitest'
import { buildXlsx } from '../../../packages/knowledge/test/sheet-fixtures.js'
import { createKolStore } from '../src/kol.js'
import { createKolImport, type KolImportOptions, publicProfileRow } from '../src/kol-import.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from '../src/kol-service.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as never
const T0 = '2026-10-23T09:00:00.000Z'
const clock: Clock = { now: () => T0 }
const actor: KolActor = {
  workspace_id: WS,
  person_id: 'p_1' as never,
  assignment_id: 'as_1' as never,
  role_id: 'kol.youtube' as never,
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64')

function setup(extra: Partial<KolImportOptions> = {}) {
  const store = createKolStore({ workspace_id: WS })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  const cards: ApprovalItem[] = []
  const approvals = {
    create: async (input: Record<string, unknown>) => {
      const item = {
        ...input,
        id: `apr_${cards.length + 1}`,
        state: 'pending',
        revision: 1,
      } as unknown as ApprovalItem
      cards.push(item)
      return item
    },
  }
  let n = 0
  const imp = createKolImport({
    workspace_id: WS,
    store,
    secrets,
    clock,
    approvals: approvals as never,
    random: () => (n++ % 97) / 97,
    ...extra,
  })
  const addEmail = (creator_id: string, email: string) => {
    const id = `ctc_${creator_id}`
    secrets.put(contactSecretId(id), { [CONTACT_SECRET_FIELD]: email })
    store.saveContact({
      id,
      creator_id,
      kind: 'email',
      value_ref: contactSecretId(id),
      source: 'manual',
    })
  }
  return { store, secrets, cards, imp, addEmail }
}

const decided = (card: ApprovalItem, option: string): ApprovalItem =>
  ({
    ...card,
    state: 'approved',
    decision: { by: 'p_1', selected_option_id: option },
  }) as unknown as ApprovalItem

describe('WP489 表格导入', () => {
  it('xlsx：大标题 + 两层合并表头 + Excel 日期序号；预览不写库；导入只补空白、历史合作进归档活动', async () => {
    const { store, imp, addEmail } = setup()
    // 库里已有一个人（名字、类目都有了；地区空着）
    store.saveCreator({ id: 'cre_old', display_name: '库里的名字', merged_from: [] })
    store.saveAccount({
      id: 'pa_old',
      creator_id: 'cre_old',
      channel: 'youtube',
      handle: 'deskzhang',
      url: 'https://www.youtube.com/@deskzhang',
      category: '桌搭',
      observed_at: T0,
    })
    addEmail('cre_old', 'zhang@creator.example')
    const file = buildXlsx([
      {
        name: '红人',
        rows: [
          ['2025 红人合作总表', null, null, null, null, null, null],
          ['达人信息', null, null, '合作情况', null, null, null],
          ['名称', '主页链接', '邮箱', '进度', '报价', '日期', '备注'],
          [
            '表里的名字',
            'https://www.youtube.com/@deskzhang',
            'zhang@creator.example',
            '已合作',
            '¥3,000',
            45658,
            '老朋友',
          ],
          [
            'Rosa',
            'https://www.tiktok.com/@deskrosa',
            'rosa@creator.example',
            '谈价中',
            '$500',
            '2025/06/01',
            '',
          ],
          ['Kai', 'https://www.instagram.com/kai.desk', '', '谈崩了', '', '', '嫌预算低'],
          ['只有名字', '', '', '已联系', '', '', ''],
        ],
        merges: ['A1:G1', 'A2:C2', 'D2:G2'],
      },
    ])
    const view = await imp.previewImport(actor, {
      filename: '红人表.xlsx',
      content_base64: b64(file),
    })
    expect(view.ok).toBe(true)
    expect(view.columns?.map((c) => c.field)).toEqual([
      'display_name',
      'url',
      'email',
      'status',
      'amount',
      'date',
      'notes',
    ])
    expect(view.statuses?.map((s) => [s.source, s.stage])).toEqual([
      ['已合作', 'closed'],
      ['谈价中', 'negotiating'],
      ['谈崩了', 'declined'],
      ['已联系', 'contacted'],
    ])
    expect(view.counts).toMatchObject({ create: 2, merge: 1, skip: 1, collabs: 3, historical: 2 })
    expect(view.rows?.[0]).toMatchObject({ action: 'merge', merge_into: '库里的名字' })
    // 预览什么都不写
    expect(store.creators()).toHaveLength(1)
    expect(store.collaborations()).toHaveLength(0)

    const done = await imp.commitImport(actor, { job_id: view.job_id as string, currency: 'USD' })
    expect(done).toMatchObject({
      created_creators: 2,
      merged_creators: 1,
      created_collaborations: 3,
      historical: 2,
      skipped: 1,
    })
    // 只补空白：名字、类目不动
    expect(store.creator('cre_old')?.display_name).toBe('库里的名字')
    expect(store.accounts({ creator_id: 'cre_old' })[0]?.category).toBe('桌搭')
    const collabs = store.collaborations()
    const old = collabs.find((c) => c.creator_id === 'cre_old')
    expect(old).toMatchObject({
      stage: 'closed',
      campaign_id: LEGACY_IMPORT_CAMPAIGN_ID,
      budget: 3000,
      currency: 'CNY',
      stage_source: 'import',
      last_activity_at: '2025-01-01T00:00:00.000Z',
    })
    expect(old?.import_note).toContain('备注：老朋友')
    const rosa = collabs.find((c) => c.channel === 'tiktok')
    expect(rosa).toMatchObject({ stage: 'negotiating', budget: 500, currency: 'USD' })
    expect(rosa?.campaign_id).toBeUndefined()
    const kai = collabs.find((c) => c.channel === 'instagram')
    expect(kai).toMatchObject({ stage: 'declined', campaign_id: LEGACY_IMPORT_CAMPAIGN_ID })
    expect(kai?.import_note).toContain('嫌预算低')

    // 同一张表再导一次：不重复建合作、不重复建人
    const again = await imp.previewImport(actor, {
      filename: '红人表.xlsx',
      content_base64: b64(file),
    })
    expect(again.counts).toMatchObject({ create: 0, merge: 3 })
    const second = await imp.commitImport(actor, { job_id: again.job_id as string })
    expect(second.created_collaborations).toBe(0)
    expect(store.collaborations()).toHaveLength(3)
    expect(store.creators()).toHaveLength(3)
  })

  it('csv（英文表头、状态词认不出的人能改）；已有一条在走的合作只往前推', async () => {
    const { store, imp } = setup()
    store.saveCreator({ id: 'cre_a', display_name: 'A', merged_from: [] })
    store.saveAccount({
      id: 'pa_a',
      creator_id: 'cre_a',
      channel: 'youtube',
      handle: 'alpha',
      url: '',
      observed_at: T0,
    })
    store.saveCollaboration({
      id: 'col_a',
      creator_id: 'cre_a',
      channel: 'youtube',
      stage: 'negotiating',
      currency: 'USD',
    })
    const csv = [
      'Creator,Channel URL,Status,Notes',
      'A,https://www.youtube.com/@alpha,Contacted,',
      'B,https://www.youtube.com/@beta,Waiting on brief,',
    ].join('\n')
    const view = await imp.previewImport(actor, { filename: 'list.csv', content: csv })
    expect(view.statuses?.find((s) => s.source === 'Waiting on brief')?.stage).toBeNull()
    expect(view.counts?.unknown_status).toBe(1)
    await imp.commitImport(actor, {
      job_id: view.job_id as string,
      statuses: [{ source: 'Waiting on brief', stage: 'agreed' }],
    })
    // 「已建联」不能把「谈条件中」打回去
    expect(store.collaboration('col_a')?.stage).toBe('negotiating')
    const b = store.collaborations().find((c) => c.creator_id !== 'cre_a')
    expect(b?.stage).toBe('agreed')
  })

  it('认不出的列交模型（规则认出来的模型改不了）', async () => {
    const calls: string[] = []
    const { imp } = setup({
      model: () => async (input) => {
        calls.push(input.user)
        return input.user.includes('COLUMNS')
          ? '{"columns":[{"index":0,"field":"email"},{"index":1,"field":"status"}]}'
          : '{"statuses":[]}'
      },
    })
    const view = await imp.previewImport(actor, {
      filename: 'x.csv',
      content: '邮箱,跟进情形\na@x.com,已寄样\n',
    })
    // 「跟进情形」规则认不出（情形 ≠ 情况）→ 模型说是状态
    expect(view.columns?.map((c) => c.field)).toEqual(['email', 'status'])
    expect(calls).toHaveLength(1)
  })
})

describe('WP489 在线表格', () => {
  const page = (map: Record<string, OnlinePageRead>) => async (url: string) =>
    map[url] ?? { ok: true, final_url: url, text: '' }

  it('Google 表格：先读导出页（<table>）', async () => {
    const id = '1AbC'
    const { imp } = setup({
      readPage: page({
        [`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:html&gid=0`]: {
          ok: true,
          final_url: `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:html&gid=0`,
          html: '<table><tr><td>名称</td><td>链接</td><td>状态</td></tr><tr><td>小桌</td><td>https://www.youtube.com/@deskzhang</td><td>已寄样</td></tr></table>',
        },
      }),
    })
    const view = await imp.previewImport(actor, {
      url: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
    })
    expect(view.ok).toBe(true)
    expect(view.counts).toMatchObject({ create: 1, collabs: 1 })
  })

  it('飞书：页面文字（制表符隔开）读得到；登录页 → 提示登录；没有浏览器 → 下载成 Excel', async () => {
    const url = 'https://acme.feishu.cn/sheets/shtXYZ'
    const ok = setup({
      readPage: page({
        [url]: {
          ok: true,
          final_url: url,
          text: '文件 编辑\n名称\t链接\t进度\nRosa\thttps://www.tiktok.com/@deskrosa\t已发布\n',
        },
      }),
    })
    const view = await ok.imp.previewImport(actor, { url })
    expect(view.ok).toBe(true)
    expect(view.statuses?.[0]).toMatchObject({ source: '已发布', stage: 'delivered' })

    const login = setup({
      readPage: async () => ({
        ok: true,
        final_url: 'https://passport.feishu.cn/accounts/page/login',
        text: '登录',
      }),
    })
    const blocked = await login.imp.previewImport(actor, { url })
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toContain('登录')

    const none = setup()
    const nob = await none.imp.previewImport(actor, { url })
    expect(nob.message).toContain('下载为 Excel')

    const canvas = setup({
      readPage: async (u) => ({ ok: true, final_url: u, text: '只是工具栏上的几个字' }),
    })
    expect((await canvas.imp.previewImport(actor, { url })).message).toContain('下载为 Excel')
  })
})

/* ── 邮件判阶段 ─────────────────────────────────────────────────────────── */

const OURS = 'hello@brand.example'
let mid = 0
const msg = (from: string, to: string, at: string, subject: string, text: string): MessageRecord =>
  ({
    id: `msg_${++mid}`,
    workspace_id: WS,
    source: 'imap',
    account: OURS,
    folder: 'INBOX',
    folder_kind: 'inbox',
    thread_id: `t_${subject.replace(/^Re:\s*/i, '')}`,
    message_id: `<m${mid}@x>`,
    references: [],
    headers: {},
    from: { email: from },
    to: [{ email: to }],
    cc: [],
    bcc: [],
    subject,
    snippet: text.slice(0, 40),
    text,
    has_remote_images: false,
    attachments: [],
    date: at,
    received_at: at,
    flags: { read: true, starred: false, answered: false, draft: false },
    labels: [],
  }) as unknown as MessageRecord

function mailbox(records: MessageRecord[], floor = '2025-01-01T00:00:00.000Z') {
  const backfills: [string, number][] = []
  return {
    backfills,
    box: () => ({
      store: {
        // 同消息库：发件人 / 主题 / 正文全文查，不分大小写
        list: ({ q }: { q?: string }) =>
          records.filter((r) =>
            [r.from.email, r.from.name ?? '', ...r.to.map((x) => x.email), r.subject, r.text].some(
              (v) => v.toLowerCase().includes((q ?? '').toLowerCase()),
            ),
          ),
        thread: (id: string) => records.filter((r) => r.thread_id === id),
      },
      addresses: () => [OURS],
      floor: () => floor,
      backfill: (a: string, days: number) => {
        backfills.push([a, days])
        return floor
      },
    }),
  }
}

/** 询价 → 报价 → 谈妥 → 寄样单号 → 发布链接（Rosa）；另有一个无关的人、一个说不做的人。 */
const ROSA = 'rosa@creator.example'
const history = (): MessageRecord[] => [
  msg(OURS, ROSA, '2026-03-01T00:00:00Z', 'Collab?', 'Hi Rosa, we would love to work with you.'),
  msg(
    ROSA,
    OURS,
    '2026-03-02T00:00:00Z',
    'Re: Collab?',
    'Thanks! What is your budget for one video?',
  ),
  msg(OURS, ROSA, '2026-03-03T00:00:00Z', 'Re: Collab?', 'We can offer a flat fee of $500.'),
  msg(ROSA, OURS, '2026-03-04T00:00:00Z', 'Re: Collab?', 'Sounds good, deal!'),
  msg(
    OURS,
    ROSA,
    '2026-03-06T00:00:00Z',
    'Shipping',
    'The lamp has shipped today, tracking number 1Z999AA10123456784.',
  ),
  msg(
    ROSA,
    OURS,
    '2026-03-20T00:00:00Z',
    'Live!',
    'The video is live: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ),
  msg('stranger@else.example', OURS, '2026-03-20T00:00:00Z', 'Hello', 'Unrelated newsletter'),
  msg('old@creator.example', OURS, '2024-01-01T00:00:00Z', 'Re: hi', 'Not interested.'),
]

describe('WP489 读过往邮件判阶段', () => {
  it('先估：只算与红人有关的往来；本机邮件不够 12 个月就让邮箱往前补拉', async () => {
    const { box, backfills } = mailbox(history(), '2026-06-01T00:00:00.000Z')
    const { store, imp, addEmail } = setup({
      mail: box,
      price: () => ({ in: 1, out: 2, currency: 'USD' }),
      model: () => async () => '',
    })
    store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa', merged_from: [] })
    addEmail('cre_rosa', ROSA)
    const est = await imp.estimateMailStages(actor, {})
    expect(est).toMatchObject({
      months: 12,
      creators: 1,
      messages: 6,
      model: true,
      mail_connected: true,
    })
    expect(est.cost).toBeGreaterThan(0)
    expect(est.backfill_from).toBe('2026-06-01T00:00:00.000Z')
    expect(backfills[0]?.[0]).toBe(OURS)
  })

  it('规则判出「已发布」并带依据；没有合作就建一条（来源 = 邮件）；往来记进红人线程', async () => {
    const { box } = mailbox(history())
    const { store, imp, addEmail } = setup({ mail: box })
    store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa', merged_from: [] })
    store.saveAccount({
      id: 'pa_r',
      creator_id: 'cre_rosa',
      channel: 'tiktok',
      handle: 'deskrosa',
      url: '',
      observed_at: T0,
    })
    addEmail('cre_rosa', ROSA)
    const run = await imp.runMailStages(actor, {})
    expect(run).toMatchObject({ judged: 1, updated: 1, by_rule: 1 })
    const c = store.collaborations()[0]
    expect(c).toMatchObject({ stage: 'delivered', stage_source: 'mail', channel: 'tiktok' })
    expect(c?.stage_evidence?.[0]?.quote).toContain('youtube.com/watch')
    const thread = store.exchanges({ creator_id: 'cre_rosa' })
    expect(thread).toHaveLength(6)
    expect(c?.stage_evidence?.[0]?.message_id).toBe(
      thread.find((x) => x.body.includes('is live'))?.id,
    )
    // 再跑一次：往来不重复记
    await imp.runMailStages(actor, {})
    expect(store.exchanges({ creator_id: 'cre_rosa' })).toHaveLength(6)
  })

  it('与表格写的不一样 → 出卡；选「按邮件」才改；一样就直接留依据', async () => {
    const { box } = mailbox(history().slice(0, 5))
    const { store, imp, addEmail, cards } = setup({ mail: box })
    store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa', merged_from: [] })
    addEmail('cre_rosa', ROSA)
    store.saveCollaboration({
      id: 'col_r',
      creator_id: 'cre_rosa',
      channel: 'youtube',
      stage: 'negotiating',
      currency: 'USD',
      stage_source: 'import',
    })
    const run = await imp.runMailStages(actor, {})
    expect(run.conflicts).toBe(1)
    expect(store.collaboration('col_r')?.stage).toBe('negotiating')
    const card = cards[0] as ApprovalItem
    expect(card.title).toContain('表格写「谈条件中」')
    expect(card.title).toContain('邮件看是「已寄样」')
    expect(card.summary).toContain('tracking number')
    expect(await imp.onDecided(decided(card, 'mail'))).toBe(true)
    expect(store.collaboration('col_r')).toMatchObject({
      stage: 'sample_sent',
      stage_source: 'mail',
    })
    expect(store.collaboration('col_r')?.stage_evidence?.[0]?.quote).toContain('tracking number')

    // 表格写的就是「已寄样」：不出卡，依据直接留下
    const same = setup({ mail: mailbox(history().slice(0, 5)).box })
    same.store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa', merged_from: [] })
    same.addEmail('cre_rosa', ROSA)
    same.store.saveCollaboration({
      id: 'col_r',
      creator_id: 'cre_rosa',
      channel: 'youtube',
      stage: 'sample_sent',
      currency: 'USD',
      stage_source: 'import',
    })
    const r2 = await same.imp.runMailStages(actor, {})
    expect(r2).toMatchObject({ same: 1, conflicts: 0 })
    expect(same.cards).toHaveLength(0)
    expect(same.store.collaboration('col_r')?.stage_evidence).toHaveLength(1)
  })

  it('模型判：依据对不上原文作废退回规则；预算到顶后剩下的都按规则判', async () => {
    const { box } = mailbox(history())
    let calls = 0
    const { store, imp, addEmail } = setup({
      mail: box,
      model: () => async () => {
        calls += 1
        throw Object.assign(new Error('cap'), { code: 'budget_exhausted' })
      },
    })
    store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa', merged_from: [] })
    addEmail('cre_rosa', ROSA)
    store.saveCreator({ id: 'cre_old', display_name: 'Old', merged_from: [] })
    addEmail('cre_old', 'old@creator.example')
    const run = await imp.runMailStages(actor, { months: 36 })
    expect(calls).toBe(1)
    expect(run).toMatchObject({ judged: 2, by_rule: 2, fallback: 1 })
    expect(store.collaborations().find((c) => c.creator_id === 'cre_old')?.stage).toBe('declined')

    const fake = setup({
      mail: mailbox(history()).box,
      model: () => async () =>
        '{"stage":"agreed","evidence":[{"message":3,"quote":"Sounds good, deal!"}]}',
    })
    fake.store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa', merged_from: [] })
    fake.addEmail('cre_rosa', ROSA)
    const r = await fake.imp.runMailStages(actor, {})
    expect(r.by_model).toBe(1)
    expect(fake.store.collaborations()[0]).toMatchObject({ stage: 'agreed' })
  })
})

describe('WP489 对话里的卡', () => {
  it('拖进来的表 → 预览卡；点「导入」就导，点「不导」什么都不写', async () => {
    const { store, imp, cards } = setup()
    const csv = '名称,链接,状态\n小桌,https://www.youtube.com/@deskzhang,已合作\n'
    const note = await imp.previewCard(actor, { filename: '红人.csv', content_base64: b64(csv) })
    expect(note).toContain('导入红人表')
    expect(cards[0]?.title).toContain('红人.csv')
    expect(store.creators()).toHaveLength(0)
    await imp.onDecided(decided(cards[0] as ApprovalItem, 'import'))
    expect(store.creators()).toHaveLength(1)
    expect(store.collaborations()[0]?.campaign_id).toBe(LEGACY_IMPORT_CAMPAIGN_ID)

    const other = setup()
    await other.imp.previewCard(actor, { filename: '红人.csv', content_base64: b64(csv) })
    await other.imp.onDecided({
      ...(other.cards[0] as ApprovalItem),
      state: 'rejected',
    } as ApprovalItem)
    expect(other.store.creators()).toHaveLength(0)
  })

  it('「用邮件更新红人状态」→ 预估卡；点「按近 12 个月判」才跑', async () => {
    const { box } = mailbox(history())
    const { store, imp, cards, addEmail } = setup({ mail: box })
    store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa', merged_from: [] })
    addEmail('cre_rosa', ROSA)
    const note = await imp.mailStageCard(actor, {})
    expect(note).toContain('1 人')
    expect(store.collaborations()).toHaveLength(0)
    await imp.onDecided(decided(cards[0] as ApprovalItem, 'run_12'))
    expect(store.collaborations()[0]?.stage).toBe('delivered')
  })
})

describe('WP489 决策 1709：邮件对人综合判断 + 对不上的一张卡', () => {
  /** 表里来的红人：没有邮箱，只有名字、主页、备注（备注里写了经纪人的邮箱）。 */
  const seedImported = (store: ReturnType<typeof setup>['store']) => {
    store.saveCreator({ id: 'cre_rosa', display_name: 'Rosa Desk', merged_from: [] })
    store.saveAccount({
      id: 'pa_r',
      creator_id: 'cre_rosa',
      channel: 'youtube',
      handle: 'rosadeskstudio',
      url: 'https://www.youtube.com/@rosadeskstudio',
      observed_at: T0,
    })
    store.saveCollaboration({
      id: 'col_r',
      creator_id: 'cre_rosa',
      channel: 'youtube',
      stage: 'negotiating',
      currency: 'USD',
      stage_source: 'import',
      import_note: '表格第 2 行；状态：谈价中；日期：2026-05-02',
    })
    store.saveCreator({ id: 'cre_mira', display_name: 'Mira Tech', merged_from: [] })
    store.saveAccount({
      id: 'pa_m',
      creator_id: 'cre_mira',
      channel: 'instagram',
      handle: 'miratechdesk',
      url: '',
      observed_at: T0,
    })
    store.saveCollaboration({
      id: 'col_m',
      creator_id: 'cre_mira',
      channel: 'instagram',
      stage: 'contacted',
      currency: 'USD',
      stage_source: 'import',
      import_note: '表格第 4 行；状态：已联系；备注：经纪人 jo@talentco.example',
    })
  }

  it('署名 + 主页链接对上没登记邮箱的红人；备注里写过的经纪人邮箱也对得上；对不上的出一张卡', async () => {
    const records = [
      msg(
        OURS,
        'rosa.biz@gmail.com',
        '2026-05-01T00:00:00Z',
        'Desk lamp',
        'Hi Rosa, love your setups.',
      ),
      {
        ...msg(
          'rosa.biz@gmail.com',
          OURS,
          '2026-05-03T00:00:00Z',
          'Re: Desk lamp',
          'Sounds good, deal!\n\nRosa Desk\nhttps://www.youtube.com/@rosadeskstudio',
        ),
        from: { email: 'rosa.biz@gmail.com', name: 'Rosa D.' },
      },
      msg(
        'jo@talentco.example',
        OURS,
        '2026-04-01T00:00:00Z',
        'Mira x your brand',
        'Mira is not interested at the moment.',
      ),
      msg(
        'stranger@studio.example',
        OURS,
        '2026-06-01T00:00:00Z',
        'Collab inquiry',
        'Hi! Could we discuss a sponsorship for my channel?',
      ),
      msg('news@shop.example', OURS, '2026-06-02T00:00:00Z', 'Weekly deals', 'Big sale'),
    ]
    const { store, imp, cards } = setup({ mail: mailbox(records).box })
    seedImported(store)
    store.saveCreator({ id: 'cre_leo', display_name: 'Leo Builds', merged_from: [] })
    store.saveCollaboration({
      id: 'col_l',
      creator_id: 'cre_leo',
      channel: 'youtube',
      stage: 'sourced',
      currency: 'USD',
      stage_source: 'import',
      import_note: '表格第 5 行',
    })

    const est = await imp.estimateMailStages(actor, {})
    expect(est).toMatchObject({ creators: 2, uncertain: 1, unmatched_creators: 1 })
    const run = await imp.runMailStages(actor, {})
    expect(run).toMatchObject({ judged: 2, matched_by_content: 2, unresolved: 2 })
    // 表格写「谈条件中」、邮件看是「已谈妥」→ 冲突卡；经纪人那段 → Mira 谢绝（表格写的是「已建联」→ 也出冲突卡）
    expect(cards.filter((c) => c.proposer.id === 'kol-stage')).toHaveLength(2)
    // 一张「没对上」的卡：一段像合作的陌生往来（不是周报那封）、一个没找到往来的红人
    const card = cards.find((c) => c.proposer.id === 'kol-mail-match') as ApprovalItem
    const payload = card.payload as {
      threads: { subject: string }[]
      creators: { creator_id: string }[]
    }
    expect(payload.threads.map((t) => t.subject)).toEqual(['Collab inquiry'])
    expect(payload.creators.map((c) => c.creator_id)).toEqual(['cre_leo'])

    // 卡里选「这段是 Leo 的」→ 对方邮箱记到 Leo 名下，只对 Leo 再判一次
    await imp.onDecided({
      ...card,
      state: 'approved',
      decision: {
        by: 'p_1',
        edited_payload: {
          ...payload,
          assign: [{ thread_id: 't_Collab inquiry', creator_id: 'cre_leo' }],
          emails: [],
        },
      },
    } as unknown as ApprovalItem)
    expect(store.contacts('cre_leo')).toMatchObject([{ kind: 'email', source: 'mail_match' }])
    // 表格写「已找到」、邮件看是「已回复」→ 照规矩出冲突卡（不直接盖掉表格写的）
    expect(cards.some((c) => c.proposer.id === 'kol-stage' && c.title.includes('Leo Builds'))).toBe(
      true,
    )
    expect(store.exchanges({ creator_id: 'cre_leo' })).toHaveLength(1)
    expect(cards.filter((c) => c.proposer.id === 'kol-mail-match')).toHaveLength(1)
  })

  it('拿不准时模型在候选人里挑；挑中就并进那个人的往来', async () => {
    const records = [
      msg(
        'team@deskcollective.example',
        OURS,
        '2026-05-05T00:00:00Z',
        'Rates',
        'Hi, Rosa Desk asked me to send our rate card: $800 per video.',
      ),
    ]
    const { store, imp } = setup({
      mail: mailbox(records).box,
      model: () => async (input) =>
        input.user.includes('<<<THREAD_START>>>') ? '{"candidate":0}' : '{"stage":"none"}',
    })
    seedImported(store)
    const run = await imp.runMailStages(actor, {})
    expect(run.matched_by_model).toBe(1)
    expect(store.exchanges({ creator_id: 'cre_rosa' })).toHaveLength(1)
  })
})

describe('WP489 决策 1707：导入的红人把公开资料送去公共红人库', () => {
  it('只送公开资料（渠道 / 账号 / 主页 / 名字 / 粉丝 / 类目 / 公开邮箱），生意数据一格都不送', async () => {
    const sent: unknown[] = []
    const { imp } = setup({
      contributePublic: async (_a, rows) => {
        sent.push(...rows)
        return { queued: rows.length }
      },
    })
    const csv = [
      '达人名称,主页链接,邮箱,粉丝,类目,合作进度,报价,日期,备注,负责人',
      'Kai Setup,https://www.youtube.com/@kaisetuplab,kai@kaisetup.example,48000,桌搭,已合作,"¥3,000",2025-11-10,效果很好别外传,阿林',
    ].join('\n')
    const view = await imp.previewImport(actor, { filename: 'k.csv', content: csv })
    const done = await imp.commitImport(actor, { job_id: view.job_id as string })
    expect(done.public_library_queued).toBe(1)
    expect(sent).toHaveLength(1)
    const row = sent[0] as Record<string, unknown>
    expect(row).toMatchObject({
      channel: 'youtube',
      handle: 'kaisetuplab',
      display_name: 'Kai Setup',
      url: 'https://youtube.com/@kaisetuplab',
      followers: 48000,
      category: '桌搭',
      email: 'kai@kaisetup.example',
    })
    const allowed = [
      'channel',
      'handle',
      'display_name',
      'url',
      'followers',
      'engagement_rate',
      'category',
      'language',
      'region',
      'email',
      'observed_at',
    ]
    expect(Object.keys(row).every((k) => allowed.includes(k))).toBe(true)
    const text = JSON.stringify(sent)
    for (const secret of [
      '3,000',
      '3000',
      '已合作',
      'closed',
      '2025-11-10',
      '效果很好',
      '阿林',
      'CNY',
    ])
      expect(text).not.toContain(secret)
  })

  it('publicProfileRow 的形状本身就只有公开资料', () => {
    const row = publicProfileRow(
      'X',
      {
        id: 'pa',
        creator_id: 'c',
        channel: 'tiktok',
        handle: 'x',
        url: '',
        followers: 1,
        observed_at: T0,
      },
      undefined,
    )
    expect(Object.keys(row).sort()).toEqual([
      'channel',
      'display_name',
      'followers',
      'handle',
      'observed_at',
    ])
  })
})
