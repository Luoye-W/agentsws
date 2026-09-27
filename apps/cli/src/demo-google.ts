/**
 * WP158：demo 里的 Search Console 读数层配一个**替身连接器**（不连真 Google、没有真账号）。
 *
 * 形状照 OpenConnector v1.6.5 的 `google_search_console` provider（docs/82）：两个站点属性
 * （域名属性 + 网址前缀），所以一打开就能看到「选一下是哪个站点」那张小卡；选好之后
 * 查询词与落地页那两块读的是 seo-core 合成的那一周（`DEMO_GSC_ROWS`，同每日 5 件事那份替身）。
 * GA4 在 demo 里照旧没连。
 */
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import { DEMO_GSC_ROWS } from '@agentsws/seo-core'
import { createGoogleReads, type GoogleConnectLike, type GoogleReads } from '@agentsws/server'

const SERVICE = 'google_search_console'
const TOKEN = 'demo-read-token'

export const DEMO_GSC_SITES = [
  { siteUrl: 'sc-domain:nordvolt.example', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://www.nordvolt.example/', permissionLevel: 'siteFullUser' },
]

function demoGoogleConnect(): GoogleConnectLike {
  return {
    actions: async (service) =>
      service === SERVICE
        ? ['list_sites', 'query_search_analytics'].map((n) => ({
            id: `${SERVICE}.${n}`,
            side_effect: 'read',
          }))
        : [],
    issueToken: async () => ({ token: TOKEN }),
    revokeTokens: async () => undefined,
    execute: async (action_id, raw) => {
      const input = raw as { dimensions?: string[]; startDate?: string }
      if (action_id.endsWith('.list_sites')) return { data: { sites: DEMO_GSC_SITES } }
      const dims = input.dimensions ?? []
      if (dims[0] === 'date')
        // 探最新完整日：给一个空的，按太平洋时间往前退 3 天
        return { data: { rows: [], metadata: { firstIncompleteDate: null } } }
      // 本周与上周都给合成那一周（demo 只演面板那几块；周环比由每日 5 件事那份替身演）
      const rows = DEMO_GSC_ROWS.map((r) => ({
        keys: [r.query, r.page],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }))
      return { data: { rows, responseAggregationType: 'byPage', metadata: {} } }
    },
  }
}

/** 一个品牌一份（选择只在内存里，demo 重启就回到「还没选」）。 */
export function demoGoogleReads(input: { workspace_id: WorkspaceId; clock: Clock }): GoogleReads {
  return createGoogleReads({
    workspace_id: input.workspace_id,
    clock: input.clock,
    connections: () => [{ id: 'conn_demo_gsc', service: 'gsc', status: 'active' }],
    connect: demoGoogleConnect(),
  })
}
