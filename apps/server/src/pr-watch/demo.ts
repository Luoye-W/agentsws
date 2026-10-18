/**
 * WP386：`agentsws demo` 里信息监控那几样（同 `seedDemoPr`）：四条监控源（自家、两个竞品、品类；
 * 其中一个竞品那条 feed 404，好让「拉不到照实说、亮红点」在演示与截图里看得见）、确认过的提醒清单、
 * 几条竞品动向。地址全在 `alerts/feeds/demo/` 下，由 {@link demoFeedFetch} 回录好的 feed——不联网；
 * 别的地址（人在演示里真贴进来的）照旧走真网络。
 */
import type { MonitorPlanItem, MonitorSource, PrWatchStore } from '@agentsws/contracts'
import type { AlertsTransport } from '@agentsws/pr-core'
import type { PrStore } from '../pr.js'

const DEMO_PREFIX = 'https://www.google.com/alerts/feeds/demo/'

const atom = (
  label: string,
  items: { title: string; url: string; text: string }[],
  at: string,
): string =>
  `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Google Alert - ${label}</title>${items
    .map(
      (it, i) =>
        `<entry><id>tag:demo,2026:${label}:${i}</id><title type="html">${it.title}</title><link href="https://www.google.com/url?rct=j&amp;url=${encodeURIComponent(it.url)}&amp;ct=ga"/><published>${at}</published><content type="html">${it.text}</content></entry>`,
    )
    .join('')}</feed>`

const FEEDS: Record<
  string,
  { label: string; items: { title: string; url: string; text: string }[] } | null
> = {
  own: {
    label: 'Nordvolt',
    items: [
      {
        title: 'Nordvolt 二代户外电源评测：续航是真的',
        url: 'https://geekpower.invalid/nordvolt-2-review',
        text: '实测比上一代多撑了一晚，做工扎实。',
      },
    ],
  },
  ecoflow: {
    label: 'EcoFlow',
    items: [
      {
        title: 'EcoFlow 发布 River 4，主打更快的充电',
        url: 'https://technews.invalid/ecoflow-river-4',
        text: 'EcoFlow 今天发布 River 4，快充功率提升。',
      },
      {
        title: 'EcoFlow 部分批次召回，官方说明',
        url: 'https://newsdesk.invalid/ecoflow-recall',
        text: '少量批次可能过热，官方启动召回。',
      },
    ],
  },
  jackery: null,
  industry: {
    label: 'portable power station',
    items: [
      {
        title: '美国就户外电源出台新的运输规定',
        url: 'https://policy.invalid/portable-power-shipping',
        text: '新规定对锂电池运输提出更严格的要求。',
      },
    ],
  },
}

/** 演示用的 feed：`alerts/feeds/demo/<名字>` 回录好的那一份（jackery 那条 404）；别的地址走真网络。 */
export function demoFeedFetch(
  real: AlertsTransport['fetch'],
  now: () => string,
): AlertsTransport['fetch'] {
  return async (url, init) => {
    if (!url.startsWith(DEMO_PREFIX)) return real(url, init)
    const feed = FEEDS[url.slice(DEMO_PREFIX.length)]
    if (feed === undefined || feed === null) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => atom(feed.label, feed.items, now()) }
  }
}

export function seedDemoPrWatch(store: PrWatchStore, pr: PrStore, now: string): void {
  if (store.sources().length > 0) return
  const ws = store.workspace_id
  const nowMs = Date.parse(now)
  const iso = (h: number): string => new Date(nowMs + h * 3_600_000).toISOString()
  const plan: (Omit<MonitorPlanItem, 'workspace_id' | 'created_at' | 'updated_at'> & {
    url: string
    ok: boolean
  })[] = [
    {
      id: 'mp_own',
      group: 'own',
      label: 'Nordvolt',
      query: '"Nordvolt" -job',
      language: 'en',
      region: 'US',
      why: '外面怎么说我们：新闻、博客、评测、论坛都算',
      selected: true,
      status: 'linked',
      source_id: 'ms_own',
      url: `${DEMO_PREFIX}own`,
      ok: true,
    },
    {
      id: 'mp_ecoflow',
      group: 'competitor',
      label: 'EcoFlow',
      competitor: 'EcoFlow',
      query: '"EcoFlow" OR "EcoFlow River" -job',
      language: 'en',
      region: 'US',
      why: '竞品动向：同价位户外电源',
      selected: true,
      status: 'linked',
      source_id: 'ms_ecoflow',
      url: `${DEMO_PREFIX}ecoflow`,
      ok: true,
    },
    {
      id: 'mp_jackery',
      group: 'competitor',
      label: 'Jackery',
      competitor: 'Jackery',
      query: '"Jackery" -job',
      language: 'en',
      region: 'US',
      why: '竞品动向：AI 搜索里一起出现的竞品',
      selected: true,
      status: 'linked',
      source_id: 'ms_jackery',
      url: `${DEMO_PREFIX}jackery`,
      ok: false,
    },
    {
      id: 'mp_industry',
      group: 'industry',
      label: 'portable power station',
      query: '"portable power station" (recall OR lawsuit OR regulation OR tariff)',
      language: 'en',
      region: 'US',
      why: '品类里的召回、诉讼、法规、关税会波及我们',
      selected: true,
      status: 'linked',
      source_id: 'ms_industry',
      url: `${DEMO_PREFIX}industry`,
      ok: true,
    },
  ]
  for (const p of plan) {
    const { url, ok, ...item } = p
    store.putPlanItem({ ...item, workspace_id: ws, created_at: iso(-48), updated_at: iso(-48) })
    const source: MonitorSource = {
      id: p.source_id as string,
      workspace_id: ws,
      kind: 'google_alerts',
      url,
      group: p.group,
      label: p.label,
      query: p.query,
      language: p.language,
      region: p.region,
      ...(p.competitor === undefined ? {} : { competitor: p.competitor }),
      every_hours: 24,
      status: ok ? 'ok' : 'failed',
      ...(ok ? { last_ok_at: iso(-2), last_fetched: 20 } : {}),
      last_try_at: iso(-2),
      ...(ok
        ? {}
        : {
            last_error:
              'Google Alerts 说这条 feed 不存在（404）。多半是那条提醒被删了或者地址抄错了一段——回 Google Alerts 重新复制一次。',
          }),
      added_via: 'paste',
      plan_item_id: p.id,
      created_at: iso(-48),
    }
    store.putSource(source)
  }
  // 几条竞品 / 行业动向（演示数据；地址都是 .invalid）
  const rows = [
    {
      id: 'mn_ecoflow_launch',
      source_id: 'ms_ecoflow',
      group: 'competitor' as const,
      competitor: 'EcoFlow',
      ...(FEEDS.ecoflow?.items[0] as { title: string; url: string; text: string }),
      h: -20,
      sentiment: 'neutral' as const,
    },
    {
      id: 'mn_ecoflow_recall',
      source_id: 'ms_ecoflow',
      group: 'competitor' as const,
      competitor: 'EcoFlow',
      ...(FEEDS.ecoflow?.items[1] as { title: string; url: string; text: string }),
      h: -6,
      sentiment: 'negative' as const,
    },
    {
      id: 'mn_industry_rule',
      source_id: 'ms_industry',
      group: 'industry' as const,
      ...(FEEDS.industry?.items[0] as { title: string; url: string; text: string }),
      h: -30,
      sentiment: 'neutral' as const,
    },
  ]
  for (const r of rows) {
    const origin = new URL(r.url).hostname
    const saved = pr.saveMention({
      id: r.id,
      workspace_id: ws,
      source: 'news',
      origin,
      url: r.url,
      title: r.title,
      text: r.text,
      published_at: iso(r.h),
      observed_at: now,
      status: 'triaged',
      dedupe_key: `url:${r.url}`,
      group: r.group,
      ...('competitor' in r ? { competitor: r.competitor } : {}),
      source_id: r.source_id,
    })
    pr.recordTriage({
      mention_id: saved.mention.id,
      triage: r.sentiment === 'negative' ? 'reputation' : 'noise',
      sentiment: r.sentiment,
    })
  }
}
