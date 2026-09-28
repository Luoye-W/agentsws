/**
 * WP171（docs/84）：B2B 面板的演示数据（`agentsws demo` 才有；真工作区里是空态）。
 *
 * 这一单只做**骨架**：B2B 库（询盘、报价、样品、出运单落盘）是后面几单（B2B-分拣、
 * B2B-询盘与报价）的事。所以这里没有一张表，只有一份写死的演示投影——空态说"还没有"，
 * 演示说"长这样"，两件事都看得见。
 *
 * 演示数据改写自 Luoye 自己的 BtoBAgents（`src/features/btobagents/demo-data.ts`、
 * `runtime-v2/seed.ts`，仓库 HEAD `940f12b`）：「深圳智联 3C 出海」的 GaN 充电器 / 移动电源 /
 * TWS 耳机、样品与报价例外、展会线索。**客户名全换成虚构的**（原来写死的 ElectroMart 那一页
 * 不搬），邮箱一个都不放。里面留着四件演示里少不了的事：一张超授权转上级的报价、
 * 一个超期没寄的样品、一张有不符点的信用证单据、一笔没到的尾款。
 */
import type { B2bDeckData } from '@agentsws/deck'

const day = (now: string, d: number): string =>
  new Date(Date.parse(now) + d * 86_400_000).toISOString().slice(0, 10)

export function demoB2bDeckData(now: string): B2bDeckData {
  return {
    inquiries: [
      {
        account: 'VoltHaus GmbH',
        subject: '65W GaN 充电器，每款 MOQ 能不能降到 500？',
        source: 'email',
        received_at: now,
        commitments: ['起订量'],
      },
      {
        account: 'Northline Distribution',
        subject: '要一份 20000mAh 移动电源的目录与 CE 证书',
        source: 'outbound_reply',
        received_at: now,
        commitments: ['认证'],
      },
      {
        account: 'Harbor Retail Co.',
        subject: 'TWS 耳机样品什么时候能寄？',
        source: 'whatsapp',
        received_at: now,
      },
    ],
    quotes_pending: [
      {
        number: 'Q-2026-0928-01',
        account: 'VoltHaus GmbH',
        version: 2,
        amount_usd: 18_400,
        margin_pct: 18.5,
        approver: 'scope_manager',
        breaches: ['quote_amount_over_mandate', 'quote_margin_under_mandate'],
      },
      {
        number: 'Q-2026-0927-03',
        account: 'Harbor Retail Co.',
        version: 1,
        amount_usd: 6_200,
        margin_pct: 26,
        approver: 'role_holder',
        breaches: [],
      },
    ],
    samples: [
      {
        account: 'Harbor Retail Co.',
        items: 'TWS 耳机 ×3、移动电源 ×2',
        status: 'to_ship',
        due: day(now, -1),
      },
      {
        account: 'VoltHaus GmbH',
        items: '65W GaN ×3',
        status: 'delivered',
        due: day(now, 7),
        tracking_no: 'DHL 演示单号',
      },
    ],
    dormant: [{ account: 'Dubai Power LLC', last_contact_at: day(now, -210), days: 210 }],
    outreach_today: [
      {
        batch: '北美分销商 · 第 1 封',
        count: 18,
        sender: 'hello@nordvolt-mail.example',
        separate_domain: true,
      },
    ],
    sequence_funnel: [
      { stage: 'first', label: '首封', count: 42 },
      { stage: 'follow_up', label: '第 3 天跟进', count: 30 },
      { stage: 'final', label: '第 7 天收尾', count: 21 },
      { stage: 'replied', label: '回了', count: 6 },
      { stage: 'unsubscribed', label: '退订', count: 2 },
    ],
    replies: [
      { account: 'Northline Distribution', category: '要资料', received_at: now },
      { account: 'Peak Gadgets', category: '晚点再说', received_at: now },
    ],
    lists: [
      { name: '香港秋季电子展来访', tier: 'own', count: 86, imported_at: day(now, -20) },
      { name: '北美分销商（公司名录）', tier: 'official', count: 120, imported_at: day(now, -3) },
    ],
    shows: [
      {
        name: '香港秋季电子展',
        city: '香港',
        starts_on: day(now, 15),
        status: '已报名',
        booth: '5E-B12',
      },
      { name: 'CES', city: '拉斯维加斯', starts_on: day(now, 98), status: '考虑中' },
    ],
    deadlines: [
      { show: '香港秋季电子展', what: '展位设计定稿', due: day(now, 5) },
      { show: 'CES', what: '报名截止', due: day(now, 30) },
    ],
    show_leads: [
      {
        show: '香港秋季电子展',
        name: 'Mia Tan',
        company: 'Peak Gadgets',
        intent: 'hot',
        note: '要 100W GaN 私模，Q1 上新',
      },
      {
        show: '香港秋季电子展',
        name: 'Ravi P.',
        company: 'NextGen Retail',
        intent: 'warm',
        note: '零售渠道，先要样品',
      },
    ],
    followups: [
      { show: '香港秋季电子展', company: 'Peak Gadgets', follow_up_by: day(now, 2), status: 'new' },
    ],
    in_production: [
      { po: 'PO-7781', account: 'VoltHaus GmbH', etd: day(now, 12), status: '生产中 · 70%' },
    ],
    to_ship: [{ po: 'PO-7740', account: 'Harbor Retail Co.', etd: day(now, 4), booked: false }],
    docs_to_check: [
      { po: 'PO-7740', doc: '商业发票', status: '已核', discrepancies: 0 },
      { po: 'PO-7702', doc: '信用证单据', status: '有不符点', discrepancies: 2 },
    ],
    balance_due: [
      { po: 'PO-7702', account: 'Dubai Power LLC', balance_usd: 42_000, due: day(now, -2) },
    ],
    marketplace_inquiries: [],
    listings_to_improve: [],
    rfqs: [],
  }
}
