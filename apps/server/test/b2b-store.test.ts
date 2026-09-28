/**
 * WP172（docs/84）：B2B 库与 `/v1/b2b/*` 的实现。
 *
 * 钉住五件事：
 *
 * 1. **库**：迁移可重入、报价版本在库里就改不了、两个工作区同一个库文件也互相读不到；
 * 2. **写都经卡**：存草稿不进库；提交出卡；**批了**执行器才落库（读不经卡）；
 * 3. **联系人没写来源 → 拦下**；邮箱明文只进加密库，草稿与库里只有 key 名 / 遮过的地址 / 哈希；
 * 4. **报价谁批**：授权内业务员自己，超了（没有上级）转老板；版本号只增，旧版原样；
 * 5. **CSV 导入本身出卡**：中英文表头都认，批了客户与联系人才进库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EffectiveConfig, EventEnvelope } from '@agentsws/contracts'
import { DEFAULT_B2B_QUOTE_MANDATE } from '@agentsws/contracts'
import { createTxn } from '@agentsws/txn'
import { afterEach, describe, expect, it } from 'vitest'
import { createB2bService } from '../src/b2b-service.js'
import { addressHash, createB2bStore } from '../src/b2b-store.js'

const NOW = '2026-09-28T02:00:00.000Z'
const WS = 'ws_b2b'
const SALES = {
  workspace_id: WS,
  person_id: 'p_he',
  assignment_id: 'asg_sales',
  role_id: 'b2b.sales',
}
const OUTBOUND = { ...SALES, assignment_id: 'asg_outbound', role_id: 'b2b.outbound' }

function seeded(seed = 7): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

const config = (): EffectiveConfig =>
  ({
    actions: [
      { id: 'stage_b2b_record', mandate: { caps: {} }, route_to: 'role_holder' },
      {
        id: 'stage_b2b_quote',
        mandate: { caps: { ...DEFAULT_B2B_QUOTE_MANDATE } },
        route_to: 'scope_manager',
      },
      { id: 'stage_b2b_sample', mandate: { caps: {} }, route_to: 'role_holder' },
      { id: 'stage_b2b_list_import', mandate: { caps: {} }, route_to: 'scope_manager' },
    ],
    automation: {},
  }) as unknown as EffectiveConfig

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const events: EventEnvelope[] = []
  const secrets = new Map<string, Record<string, string>>()
  const store = createB2bStore({ workspace_id: WS, now: () => NOW })
  let service: ReturnType<typeof createB2bService> | undefined
  const txn = createTxn({
    clock: { now: () => NOW },
    random: seeded(),
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    // 测试里不等 120 秒的取消窗口
    policy: { cancel_window_sec: 0 },
    backendApply: (change) =>
      service?.apply(change) ?? { status: 'ok', execution_id: 'exec_other' },
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  service = createB2bService({
    workspace_id: WS,
    store,
    clock: { now: () => NOW, sleep: async () => undefined },
    random: seeded(3),
    approvals: txn.approvals,
    ledger: txn.ledger,
    effectiveConfig: () => config(),
    appendEvent: (e) => events.push(e as EventEnvelope),
    secrets: { put: (id, fields) => secrets.set(id, fields) },
    owner: async () => 'p_zhou',
  })
  const approve = async (approval_item_id: string | undefined, by: string) => {
    const card = await txn.approvals.get(approval_item_id ?? '')
    const token = card?.deliveries.find((d) => d.to === by)?.decision_token ?? ''
    await txn.approvals.decide(approval_item_id ?? '', by, {
      action: 'approve',
      decision_token: token,
      via: 'web',
    })
    // 批了之后由执行器施行（服务进程里是审批路由那一跳调它）
    return txn.executor.applyApproval(approval_item_id ?? '')
  }
  return { store, service, txn, events, secrets, approve }
}

describe('B2B 库（本机 SQLite）', () => {
  it('迁移可重入；报价版本在库里就改不了、删不了', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b2b-'))
    dirs.push(dir)
    const a = createB2bStore({ workspace_id: WS, dbDir: dir, now: () => NOW })
    a.addQuoteVersion({
      quote_id: 'quo_1',
      version: 1,
      lines: [],
      amount_usd: 100,
      margin_pct: 25,
      discount_pct: 0,
      payment_terms_days: 30,
      incoterm: 'FOB',
      valid_until: NOW,
      created_at: NOW,
      created_by: 'p_he',
    })
    // 同号再插一版 = 改旧版 → 撞主键
    const [v1] = a.quoteVersions('quo_1')
    if (v1 === undefined) throw new Error('v1 missing')
    expect(() => a.addQuoteVersion({ ...v1, amount_usd: 1 })).toThrow()
    a.close()
    const b = createB2bStore({ workspace_id: WS, dbDir: dir, now: () => NOW })
    expect(b.quoteVersions('quo_1')).toHaveLength(1)
    b.close()
    // 绕过 store 直接写 SQL 也不行：触发器挡着
    const Database = createRequire(import.meta.url)(
      'better-sqlite3',
    ) as typeof import('better-sqlite3')
    const db = new Database(join(dir, 'b2b.sqlite'))
    expect(() => db.prepare('UPDATE b2b_quote_version SET body = ?').run('{}')).toThrow(/immutable/)
    expect(() => db.prepare('DELETE FROM b2b_quote_version').run()).toThrow(/immutable/)
    db.close()
  })

  it('两个工作区同一个库文件：互相读不到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b2b-'))
    dirs.push(dir)
    const a = createB2bStore({ workspace_id: 'ws_a', dbDir: dir })
    const b = createB2bStore({ workspace_id: 'ws_b', dbDir: dir })
    a.put('b2b_account', { id: 'acc_1', name: 'VoltHaus' })
    a.suppress({
      key_hash: addressHash('x@y.example'),
      masked: 'x***@y.example',
      reason: 'manual',
      at: NOW,
    })
    expect(a.list('b2b_account')).toHaveLength(1)
    expect(b.list('b2b_account')).toHaveLength(0)
    expect(b.get('b2b_account', 'acc_1')).toBeUndefined()
    expect(b.isSuppressed('x@y.example')).toBe(false)
    expect(a.isSuppressed('X+promo@y.example')).toBe(true)
    a.close()
    b.close()
  })
})

describe('写都经卡：草稿 → 改动卡 → 批了才落库', () => {
  it('联系人：邮箱只进加密库；提交出卡、批之前库里没有；批了才有，按发件人认得出', async () => {
    const { store, service, secrets, approve, events } = setup()
    const { draft } = await service.port.saveDraft(OUTBOUND, 'b2b_contact', {
      record: {
        account_id: 'acc_1',
        name: 'Mia Tan',
        source: { kind: 'trade_show', observed_at: NOW },
      },
      email: 'Mia.Tan@PeakGadgets.example',
    })
    // 草稿里没有明文，只有 key 名 / 遮过的地址 / 哈希
    const raw = JSON.stringify(store.draft(draft.id))
    expect(raw).not.toContain(
      'PeakGadgets.example'.toLowerCase().slice(0, 4) === 'peak' ? 'Mia.Tan@' : '',
    )
    expect(raw).not.toMatch(/mia\.tan@peakgadgets/i)
    expect(draft.record.email_masked).toBe('M***@PeakGadgets.example')
    expect(draft.record.email_ref).toBeUndefined()
    expect([...secrets.values()][0]).toEqual({ value: 'Mia.Tan@PeakGadgets.example' })
    expect(store.list('b2b_contact')).toHaveLength(0)

    const staged = await service.port.submitDraft(OUTBOUND, 'b2b_contact', draft.id)
    expect(staged.staged).toBe(true)
    // 读不经卡；批之前库里仍然没有
    expect(store.list('b2b_contact')).toHaveLength(0)
    expect((await service.port.list(OUTBOUND, 'b2b_contact')).drafts[0]?.status).toBe('submitted')

    await approve(staged.approval_item_id, 'p_he')
    const rows = (await service.port.list(OUTBOUND, 'b2b_contact')).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Mia Tan', has_email: true, suppressed: false })
    expect(rows[0]?.email_ref).toBeUndefined()
    expect(store.contactIdByEmail('mia.tan@peakgadgets.example')).toBe(rows[0]?.id)
    expect(store.draft(draft.id)?.status).toBe('applied')
    expect(events.some((e) => e.type === 'b2b.record_applied')).toBe(true)
  })

  it('联系人没写来源 → guardrail 拦下（staged 为假、草稿标 blocked、库里没有）', async () => {
    const { store, service } = setup()
    const { draft } = await service.port.saveDraft(OUTBOUND, 'b2b_contact', {
      record: { account_id: 'acc_1', name: 'No Source' },
    })
    const out = await service.port.submitDraft(OUTBOUND, 'b2b_contact', draft.id)
    expect(out.staged).toBe(false)
    expect(out.message).toBeDefined()
    expect(store.draft(draft.id)?.status).toBe('blocked')
    expect(store.list('b2b_contact')).toHaveLength(0)
  })

  it('改一条已有的：没有这条记录 → 404；调用方塞不进 id / 时间 / key 名', async () => {
    const { service } = setup()
    expect(() =>
      service.port.saveDraft(SALES, 'b2b_account', { record_id: 'acc_nope', record: {} }),
    ).toThrow(/没有这条记录/)
    const { draft } = await service.port.saveDraft(SALES, 'b2b_account', {
      record: { name: 'VoltHaus', id: 'hacked', email_ref: 'steal', created_at: '1999' },
    })
    expect(draft.record.id).not.toBe('hacked')
    expect(draft.record.created_at).toBe(NOW)
    expect(draft.record.email_ref).toBeUndefined()
  })
})

describe('报价：永远出卡，授权只决定谁批；版本只增', () => {
  const version = (unit: number, margin = 26) => ({
    lines: [{ sku: 'GAN65', description: '65W GaN charger', qty: 1000, unit_price_usd: unit }],
    margin_pct: margin,
    discount_pct: 0,
    payment_terms_days: 30,
    incoterm: 'FOB' as const,
    valid_until: '2026-10-28',
  })

  it('授权内 → 业务员自己批；超了（没有上级）→ 转老板；批了才写版本、旧版原样', async () => {
    const { store, service, approve, txn } = setup()
    const first = await service.port.saveDraft(SALES, 'b2b_quote', {
      record: { account_id: 'acc_1' },
      quote_version: version(6.2),
    })
    const a = await service.port.submitDraft(SALES, 'b2b_quote', first.draft.id)
    expect(a).toMatchObject({ staged: true, approver: 'role_holder', breaches: [] })
    // 报价在硬顶里：等级永远 L1
    expect(a.level).toBe('L1')
    expect(store.quoteVersions(first.draft.record_id)).toHaveLength(0)
    await approve(a.approval_item_id, 'p_he')
    expect(store.quoteVersions(first.draft.record_id).map((v) => v.amount_usd)).toEqual([6200])

    // 改价 = 新一版：1.84 万美元、毛利 18.5% → 超了两条，转老板
    const second = await service.port.saveDraft(SALES, 'b2b_quote', {
      record_id: first.draft.record_id,
      record: {},
      quote_version: version(18.4, 18.5),
    })
    expect(second.draft.quote_version?.version).toBe(2)
    const b = await service.port.submitDraft(SALES, 'b2b_quote', second.draft.id)
    expect(b.approver).toBe('owner')
    expect(b.breaches).toEqual(['quote_amount_over_mandate', 'quote_margin_under_mandate'])
    const card = await txn.approvals.get(b.approval_item_id ?? '')
    expect(card?.routing.recipients.map((r) => r.person)).toEqual(['p_zhou'])
    expect(card?.summary).toContain('超了授权')
    // 面板上的「报价待审」来自已提交没批的那一张
    expect(service.deckData(NOW).quotes_pending[0]).toMatchObject({ version: 2, approver: 'owner' })
    await approve(b.approval_item_id, 'p_zhou')
    const versions = (await service.port.get(SALES, 'b2b_quote', first.draft.record_id)).versions
    expect(versions?.map((v) => [v.version, v.amount_usd])).toEqual([
      [1, 6200],
      [2, 18400],
    ])
  })
})

describe('CSV 导入：导入本身出卡', () => {
  it('中文表头也认；批之前一行不进库；批了客户 + 联系人 + 名单都进，邮箱不落明文', async () => {
    const { store, service, approve } = setup()
    store.suppress({
      key_hash: addressHash('ravi@nextgen.example'),
      masked: 'r***@nextgen.example',
      reason: 'unsubscribe',
      at: NOW,
    })
    const csv = [
      '公司,联系人,邮箱,国家,网站',
      'Peak Gadgets,Mia Tan,mia@peakgadgets.example,SG,https://peakgadgets.example/about',
      'NextGen Retail,Ravi P.,ravi@nextgen.example,IN,nextgen.example',
      'Peak Gadgets,Leo Wong,leo@peakgadgets.example,SG,peakgadgets.example',
    ].join('\n')
    const out = await service.port.importCsv(OUTBOUND, {
      name: '香港秋季电子展来访',
      csv,
      source_kind: 'trade_show',
    })
    expect(out).toMatchObject({ staged: true, rows: 3, suppressed: 1 })
    expect(store.list('b2b_account')).toHaveLength(0)
    await approve(out.approval_item_id, 'p_zhou')
    expect(store.list('b2b_list')).toHaveLength(1)
    const accounts = store.list<{ name: string; domain?: string }>('b2b_account')
    expect(accounts.map((a) => a.name).sort()).toEqual(['NextGen Retail', 'Peak Gadgets'])
    expect(store.list('b2b_contact')).toHaveLength(3)
    expect(JSON.stringify(store.list('b2b_contact'))).not.toContain('mia@peakgadgets.example')
    expect(store.contactIdByEmail('leo@peakgadgets.example')).toBeDefined()
    // 每个联系人都带来源（名单 id）
    const contact = store.list<{ source: { list_id?: string; kind: string } }>('b2b_contact')[0]
    expect(contact?.source).toMatchObject({ kind: 'trade_show', list_id: out.list_id })
    expect(service.deckData(NOW).lists[0]).toMatchObject({ name: '香港秋季电子展来访', count: 3 })
  })

  it('没有公司也没有邮箱那一列 → 400，说人话', async () => {
    const { service } = setup()
    await expect(
      service.port.importCsv(OUTBOUND, { name: 'x', csv: 'foo,bar\n1,2' }),
    ).rejects.toThrow(/公司.*邮箱/)
  })
})
