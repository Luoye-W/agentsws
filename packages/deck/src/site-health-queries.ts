/**
 * WP381（决策 1066）：网站 / 商品体检与 AI 来源流量的报表块。
 *
 * 体检四块走 `site`（我们自己跑出来的结论，永远算连上）；AI 来源流量走 `shop`（数从店铺来，没连就「去连接」）。
 * 界面少字：只列有问题的行，全好就一行「都没问题」；没体检过就一行「还没体检」——不出空表。
 */
import type { AiCrawlerVerdict, RawHtmlFactCheck } from '@agentsws/contracts'
import type { QueryDef } from './queries.js'
import type { QueryContext, TableResult } from './types.js'

const PURPOSE = { search: 'AI 搜索', user: '替用户打开', training: '训练' } as const

const FACT = {
  price: '价格',
  availability: '库存',
  title: '标题',
  selling_point: '卖点',
  return_policy: '退货',
  shipping_policy: '配送',
} as const

const FIELD = {
  price: '价格',
  currency: '币种',
  availability: '库存',
  variants: '规格数',
  return_policy: '退货天数',
  shipping_policy: '配送',
  date: '日期',
} as const

const SOURCE = {
  page: '商品页',
  jsonld: '结构化数据',
  feed: '商品 feed',
  platform: '其他平台',
} as const

const notRun = (columns: TableResult['columns'], first: string): TableResult => ({
  columns,
  rows: [{ [columns[0]?.key ?? 'item']: first }],
})

const checkedFooter = (ctx: QueryContext): NonNullable<TableResult['footer']> | undefined => {
  const at = ctx.site_health?.run?.finished_at ?? ctx.site_health?.run?.started_at
  return at === undefined ? undefined : { text: `体检于 ${at.slice(0, 10)}` }
}

const crawlerState = (v: AiCrawlerVerdict): string =>
  v.state === 'blocked'
    ? '挡了'
    : v.state === 'partial'
      ? '挡了一部分'
      : v.state === 'unknown'
        ? '没读到'
        : '放行'

const rawState = (r: RawHtmlFactCheck): string =>
  r.verdict === 'js_only'
    ? '只靠 JS'
    : r.verdict === 'missing'
      ? '没写'
      : r.verdict === 'unknown'
        ? '没读到'
        : '有'

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

export const SITE_HEALTH_QUERIES: QueryDef[] = [
  {
    name: 'site.ai_crawlers',
    source: 'site',
    returns: 'table',
    run: (ctx) => {
      const columns = [
        { key: 'bot', label: 'AI 爬虫' },
        { key: 'impact', label: '影响' },
        { key: 'state', label: 'robots.txt' },
        { key: 'why', label: '依据', format: 'flag' as const },
      ]
      const run = ctx.site_health?.run
      if (run === undefined) return notRun(columns, '还没体检')
      if (run.robots.state === 'unknown')
        return { ...notRun(columns, '这次没读到 robots.txt'), ...footerOf(ctx) }
      // 只列挡了的（整站 / 一部分）；放行的并成一行，点名几家常用 AI
      const blocked = run.crawlers.filter((v) => v.state === 'blocked' || v.state === 'partial')
      const open = run.crawlers.filter((v) => v.state === 'allowed')
      const named = [
        ...new Set(open.filter((v) => v.purpose !== 'training').map((v) => v.platform ?? v.token)),
      ].slice(0, 3)
      const rows = blocked.map((v) => ({
        bot: v.token,
        impact:
          v.purpose === 'training'
            ? '训练（你的选择）'
            : `${v.platform ?? v.vendor} · ${PURPOSE[v.purpose]}`,
        state: crawlerState(v),
        why: v.rule ?? '',
      }))
      if (open.length > 0)
        rows.push({
          bot: `其余 ${String(open.length)} 个`,
          impact: `${named.join('、')}${open.length > named.length ? ' 等' : ''}`,
          state: '放行',
          why: '',
        })
      return { columns, rows, ...footerOf(ctx) }
    },
  },
  {
    name: 'site.raw_html',
    source: 'site',
    returns: 'table',
    run: (ctx) => {
      const columns = [
        { key: 'page', label: '页面' },
        { key: 'fact', label: '关键事实' },
        { key: 'state', label: '不开 JS 时' },
      ]
      const run = ctx.site_health?.run
      if (run === undefined) return notRun(columns, '还没体检')
      const bad = run.raw_html.filter((r) => r.verdict !== 'ok')
      const rows =
        bad.length === 0
          ? [
              {
                page: run.raw_html.length === 0 ? '这次没抓到页面' : '关键事实都在原始页面里',
                fact: '',
                state: '',
              },
            ]
          : bad.map((r) => ({
              page: pathOf(r.url),
              fact: `${FACT[r.fact]} ${r.expected}`,
              state: rawState(r),
            }))
      const footer =
        run.render === 'done'
          ? footerOf(ctx)
          : {
              footer: {
                text: run.render === 'no_browser' ? '没找到浏览器，没比渲染后' : '这次没比渲染后',
              },
            }
      return { columns, rows, ...footer }
    },
  },
  {
    name: 'site.product_facts',
    source: 'site',
    returns: 'table',
    run: (ctx) => {
      const columns = [
        { key: 'product', label: '商品' },
        { key: 'issue', label: '哪里不对' },
        { key: 'compare', label: '写的 → 后台' },
      ]
      const run = ctx.site_health?.run
      if (run === undefined) return notRun(columns, '还没体检')
      const issues = run.products.issues.slice(0, 20)
      const what = (i: (typeof issues)[number]): string =>
        i.kind === 'undated'
          ? '没写日期'
          : i.kind === 'expired'
            ? '价格过期'
            : `${FIELD[i.field]}${i.kind === 'missing' ? '没写' : '不一致'}`
      const rows =
        issues.length === 0
          ? [
              {
                product:
                  run.products.checked === 0
                    ? '这次没读到商品'
                    : `抽查 ${String(run.products.checked)} 件都对得上`,
                issue: '',
                compare: '',
              },
            ]
          : issues.map((i) => ({
              product: i.product_title,
              issue: `${i.source === 'platform' && i.source_label !== undefined ? i.source_label : SOURCE[i.source]} · ${what(i)}`,
              compare:
                i.found === undefined && i.expected === undefined
                  ? ''
                  : `${i.found ?? '—'} → ${i.expected ?? '—'}`,
            }))
      const dispatched = run.dispatched
      return {
        columns,
        rows,
        ...(dispatched === undefined
          ? footerOf(ctx)
          : {
              footer: {
                text: `已交给网站运营（${String(dispatched.issues)} 条）`,
                href: `/matters/${encodeURIComponent(dispatched.matter_id)}`,
                link_label: '看那件事',
              },
            }),
      }
    },
  },
  {
    name: 'site.chatgpt_shopping',
    source: 'site',
    returns: 'table',
    run: (ctx) => {
      const columns = [
        { key: 'field', label: '字段' },
        { key: 'cover', label: '齐了几件' },
        { key: 'fix', label: '怎么补' },
      ]
      const a = ctx.site_health?.run?.chatgpt_shopping
      if (a === undefined)
        return notRun(columns, ctx.site_health?.run === undefined ? '还没体检' : '这次没读到商品')
      const verdict = a.verdict === 'ready' ? '能进' : a.verdict === 'almost' ? '差一点' : '还不行'
      const rows = [
        { field: `结论：${verdict}`, cover: '', fix: '' },
        ...a.fields
          .filter((f) => f.state !== 'ok' && f.requirement !== 'optional')
          .map((f) => ({
            field: f.field,
            cover: `${String(f.covered)} / ${String(f.total)}`,
            fix: f.fix ?? '',
          })),
      ]
      return { columns, rows, footer: { text: `只评估，不对接 · 规范读于 ${a.spec_read_at}` } }
    },
  },
  {
    // 一个数：近 7 天从 AI 来的成交（实测），和前 7 天比；小折线是逐天
    name: 'seo.ai_orders',
    source: 'shop',
    returns: 'scalar',
    run: (ctx) => {
      const s = ctx.site_health?.ai_traffic
      if (s === undefined) return { value: 0, previous: 0, spark: [] }
      return { value: s.ai_orders, previous: s.previous?.ai_orders ?? 0, spark: s.daily ?? [] }
    },
  },
  {
    name: 'seo.ai_traffic',
    source: 'shop',
    returns: 'table',
    run: (ctx) => {
      const s = ctx.site_health?.ai_traffic
      // 访问数没授权读就不出那一列（不出一列空格）
      const columns = [
        { key: 'platform', label: 'AI' },
        ...(s?.visits === 'ok'
          ? [{ key: 'visits', label: '访问', align: 'right' as const, format: 'count' as const }]
          : []),
        { key: 'orders', label: '成交', align: 'right' as const, format: 'count' as const },
        { key: 'revenue', label: '金额', align: 'right' as const },
      ]
      if (s === undefined) return notRun(columns, '还没算')
      const rows: Record<string, string | number>[] =
        s.rows.length === 0
          ? [{ platform: '这段时间没有从 AI 来的成交', orders: '', revenue: '' }]
          : s.rows.map((r) => ({
              platform: r.platform,
              ...(s.visits === 'ok' ? { visits: r.visits ?? 0 } : {}),
              orders: r.orders,
              revenue: r.revenue,
            }))
      const share =
        s.total_orders === 0 ? 0 : Math.round((s.ai_orders / s.total_orders) * 1000) / 10
      return {
        columns,
        rows,
        footer: {
          text: `实测 · ${s.since.slice(0, 10)} – ${s.until.slice(0, 10)} · 占全部成交 ${String(share)}%${s.visits === 'no_scope' ? ' · 访问数要店铺授权里加「店铺报表」' : ''}`,
        },
      }
    },
  },
]

function footerOf(ctx: QueryContext): { footer?: NonNullable<TableResult['footer']> } {
  const f = checkedFooter(ctx)
  return f === undefined ? {} : { footer: f }
}
