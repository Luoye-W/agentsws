/**
 * WP171（docs/84）：B2B 五条职责十九块的命名查询。全走 `b2b` 源（我们自己的库，永远算连上）。
 *
 * 少字（36 §7）：每块三四列，状态念成人话，不把枚举值印上去。宿主没递 `ctx.b2b`
 * = 这台机器上还没有 B2B 岗位，十九块一律空表——空态那一句由前端的空表文案说。
 */
import type { QueryDef } from './queries.js'
import type { B2bDeckData, QueryContext } from './types.js'

const word = (table: Readonly<Record<string, string>>, v: string): string => table[v] ?? v
const rows = <K extends keyof B2bDeckData>(ctx: QueryContext, key: K): B2bDeckData[K] =>
  (ctx.b2b?.[key] ?? []) as B2bDeckData[K]
const count = { align: 'right' as const, format: 'count' as const }
const money = { align: 'right' as const, format: 'money' as const }

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  email: '邮件',
  whatsapp: 'WhatsApp',
  marketplace: '平台',
  outbound_reply: '开发信回复',
  trade_show: '展会',
}
const APPROVER_WORDS: Readonly<Record<string, string>> = {
  role_holder: '业务员',
  scope_manager: '上级',
  owner: '老板',
}
const BREACH_WORDS: Readonly<Record<string, string>> = {
  quote_amount_over_mandate: '金额',
  quote_margin_under_mandate: '毛利',
  quote_discount_over_mandate: '折扣',
  quote_payment_terms_over_mandate: '账期',
}
const SAMPLE_WORDS: Readonly<Record<string, string>> = {
  to_ship: '待寄',
  shipped: '已寄',
  delivered: '已签收',
  feedback: '已反馈',
}
const TIER_WORDS: Readonly<Record<string, string>> = {
  own: '自己的',
  official: '官方档',
  byo_key: '自带 key',
}
const INTENT_WORDS: Readonly<Record<string, string>> = { hot: '高', warm: '中', cold: '低' }

const table = (
  name: string,
  columns: { key: string; label: string; align?: 'left' | 'right'; format?: 'money' | 'count' }[],
  map: (ctx: QueryContext) => Record<string, string | number>[],
): QueryDef => ({
  name,
  source: 'b2b',
  returns: 'table',
  run: (ctx) => ({ columns, rows: map(ctx) }),
})

export const B2B_QUERIES: QueryDef[] = [
  // ── 业务：待回询盘 · 报价待审 · 样品在途 · 该唤醒的老客户 ───────────────
  table(
    'b2b.inquiries',
    [
      { key: 'account', label: '客户' },
      { key: 'subject', label: '问什么' },
      { key: 'source', label: '从哪来' },
      { key: 'flag', label: '要人看' },
    ],
    (ctx) =>
      rows(ctx, 'inquiries').map((r) => ({
        account: r.account,
        subject: r.subject,
        source: word(SOURCE_WORDS, r.source),
        // 碰到承诺的那几类（价格 / 交期 …）：回信会转人审；WP182：分级排在最前（诈骗嫌疑一眼看见）
        flag: [r.grade, (r.commitments ?? []).join('、')]
          .filter((x) => x !== undefined && x !== '')
          .join(' · '),
      })),
  ),
  table(
    'b2b.quotes_pending',
    [
      { key: 'account', label: '客户' },
      { key: 'amount', label: '金额', ...money },
      { key: 'approver', label: '谁批' },
      { key: 'why', label: '超了' },
    ],
    (ctx) =>
      rows(ctx, 'quotes_pending').map((r) => ({
        account: `${r.account} · V${r.version}`,
        amount: r.amount_usd,
        approver: word(APPROVER_WORDS, r.approver),
        why: r.breaches.map((b) => word(BREACH_WORDS, b)).join('、'),
      })),
  ),
  table(
    'b2b.samples',
    [
      { key: 'account', label: '客户' },
      { key: 'items', label: '寄什么' },
      { key: 'status', label: '到哪了' },
      { key: 'due', label: '截止' },
    ],
    (ctx) =>
      rows(ctx, 'samples').map((r) => ({
        account: r.account,
        items: r.items,
        status: word(SAMPLE_WORDS, r.status),
        // WP182：超期的直接说超了几天（面板按这一格排不了序，至少一眼看得见）
        due: r.overdue_days === undefined ? r.due : `已超 ${r.overdue_days} 天`,
      })),
  ),
  table(
    'b2b.dormant_accounts',
    [
      { key: 'account', label: '客户' },
      { key: 'days', label: '几天没联系', ...count },
    ],
    (ctx) => rows(ctx, 'dormant').map((r) => ({ account: r.account, days: r.days })),
  ),
]

B2B_QUERIES.push(
  // ── 主动开发：今天待发 · 序列漏斗 · 回复待分 · 名单来源 ───────────────
  table(
    'b2b.outreach_today',
    [
      { key: 'batch', label: '哪一批' },
      { key: 'count', label: '几封', ...count },
      { key: 'sender', label: '发信邮箱' },
    ],
    (ctx) =>
      rows(ctx, 'outreach_today').map((r) => ({
        batch: r.batch,
        count: r.count,
        // 用主域名发是用户自己选的：能发，面板上照实标一句
        sender: r.separate_domain ? r.sender : `${r.sender}（主域名）`,
      })),
  ),
  table(
    'b2b.sequence_funnel',
    [
      { key: 'label', label: '到哪一步了' },
      { key: 'count', label: '几个人', ...count },
    ],
    (ctx) => rows(ctx, 'sequence_funnel').map((r) => ({ label: r.label, count: r.count })),
  ),
  table(
    'b2b.replies_to_triage',
    [
      { key: 'account', label: '谁回的' },
      { key: 'category', label: '像是' },
    ],
    (ctx) => rows(ctx, 'replies').map((r) => ({ account: r.account, category: r.category })),
  ),
  table(
    'b2b.lists',
    [
      { key: 'name', label: '名单' },
      { key: 'tier', label: '哪一档' },
      { key: 'count', label: '几条', ...count },
    ],
    (ctx) =>
      rows(ctx, 'lists').map((r) => ({
        name: r.name,
        tier: word(TIER_WORDS, r.tier),
        count: r.count,
      })),
  ),
  // ── 展会：下一个展 · 截止日 · 现场线索 · 待跟进 ─────────────────────
  table(
    'b2b.next_shows',
    [
      { key: 'name', label: '展会' },
      { key: 'when', label: '哪天' },
      { key: 'booth', label: '展位' },
    ],
    (ctx) =>
      rows(ctx, 'shows').map((r) => ({
        name: `${r.name}（${r.city}）`,
        when: r.starts_on,
        booth: r.booth ?? '',
      })),
  ),
  table(
    'b2b.show_deadlines',
    [
      { key: 'what', label: '要交什么' },
      { key: 'due', label: '截止' },
    ],
    (ctx) => rows(ctx, 'deadlines').map((r) => ({ what: `${r.show} · ${r.what}`, due: r.due })),
  ),
  table(
    'b2b.show_leads',
    [
      { key: 'who', label: '谁' },
      { key: 'intent', label: '意向' },
      { key: 'note', label: '一句话' },
    ],
    (ctx) =>
      rows(ctx, 'show_leads').map((r) => ({
        who: `${r.name} · ${r.company}`,
        intent: word(INTENT_WORDS, r.intent),
        note: r.note,
      })),
  ),
  table(
    'b2b.show_followups',
    [
      { key: 'company', label: '客户' },
      { key: 'by', label: '最晚' },
    ],
    (ctx) => rows(ctx, 'followups').map((r) => ({ company: r.company, by: r.follow_up_by })),
  ),
  // ── 跟单与单证：在产订单 · 待出运 · 单证待核 · 尾款待收 ────────────────
  table(
    'b2b.in_production',
    [
      { key: 'po', label: '订单' },
      { key: 'etd', label: '预计出运' },
      { key: 'status', label: '状态' },
    ],
    (ctx) =>
      rows(ctx, 'in_production').map((r) => ({
        po: `${r.po} · ${r.account}`,
        etd: r.etd,
        status: r.status,
      })),
  ),
  table(
    'b2b.to_ship',
    [
      { key: 'po', label: '订单' },
      { key: 'etd', label: '船期' },
      { key: 'booked', label: '订舱' },
    ],
    (ctx) =>
      rows(ctx, 'to_ship').map((r) => ({
        po: `${r.po} · ${r.account}`,
        etd: r.etd,
        booked: r.booked ? '已订' : '未订',
      })),
  ),
  table(
    'b2b.docs_to_check',
    [
      { key: 'doc', label: '单证' },
      { key: 'status', label: '状态' },
      { key: 'discrepancies', label: '不符点', ...count },
    ],
    // 有不符点的排前面：那是会被银行拒付的
    (ctx) =>
      [...rows(ctx, 'docs_to_check')]
        .sort((a, b) => b.discrepancies - a.discrepancies)
        .map((r) => ({
          doc: `${r.po} · ${r.doc}`,
          status: r.status,
          discrepancies: r.discrepancies,
        })),
  ),
  table(
    'b2b.balance_due',
    [
      { key: 'po', label: '订单' },
      { key: 'balance', label: '尾款', ...money },
      { key: 'due', label: '该到' },
    ],
    (ctx) =>
      rows(ctx, 'balance_due').map((r) => ({
        po: `${r.po} · ${r.account}`,
        balance: r.balance_usd,
        due: r.due,
      })),
  ),
  // ── B2B 平台运营（第二批）：平台询盘 · 待优化产品 · RFQ ───────────────
  table(
    'b2b.marketplace_inquiries',
    [
      { key: 'buyer', label: '买家' },
      { key: 'subject', label: '问什么' },
    ],
    (ctx) =>
      rows(ctx, 'marketplace_inquiries').map((r) => ({
        buyer: `${r.buyer}（${r.platform}）`,
        subject: r.subject,
      })),
  ),
  table(
    'b2b.listings_to_improve',
    [
      { key: 'product', label: '产品' },
      { key: 'issue', label: '哪儿不好' },
    ],
    (ctx) => rows(ctx, 'listings_to_improve').map((r) => ({ product: r.product, issue: r.issue })),
  ),
  table(
    'b2b.rfqs',
    [
      { key: 'subject', label: '要什么' },
      { key: 'qty', label: '数量' },
      { key: 'closes_at', label: '截止' },
    ],
    (ctx) =>
      rows(ctx, 'rfqs').map((r) => ({ subject: r.subject, qty: r.qty, closes_at: r.closes_at })),
  ),
)
