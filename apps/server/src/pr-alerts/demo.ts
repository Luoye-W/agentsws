/**
 * WP387：demo 里「让工坊替你建」那张卡长什么样（截图与演示用；只在挂了合成世界时调）。
 *
 * 清单还空着就放 4 条竞品提醒（户外电源演示品牌），然后出一张「要在你的 Google 账号里建 4 条提醒」的卡。
 * 不开浏览器、不连 Google：卡等人点；点了之后你的浏览器没接上，就照实说、退回手动贴链接。
 */
import type { MonitorPlanItem, PrWatchStore } from '@agentsws/contracts'
import type { PrAlertsService } from './service.js'

// WP419（自查 P1）：和演示品牌档案（户外电源）一致的竞品——原来混进了电动自行车那四家
const DEMO: readonly [string, string][] = [
  ['EcoFlow', '"EcoFlow" -job -jobs'],
  ['Jackery', '"Jackery"'],
  ['BLUETTI', '"BLUETTI"'],
  ['Anker SOLIX', '"Anker SOLIX"'],
]

export async function seedDemoAlerts(input: {
  store: PrWatchStore
  alerts: PrAlertsService
  now: string
}): Promise<void> {
  const { store, alerts, now } = input
  // 清单上还有没挂上源、勾着的就用它；没有（演示里信息监控那几样都已订上）就放 4 条竞品
  const pending = store.planItems().some((p) => p.selected && p.status === 'planned')
  const have = new Set(store.planItems().map((p) => p.query.trim().toLowerCase()))
  if (!pending)
    DEMO.forEach(([label, query], i) => {
      if (have.has(query.toLowerCase())) return
      const row: MonitorPlanItem = {
        id: `mp_demo_${i + 1}`,
        workspace_id: store.workspace_id,
        group: 'competitor',
        label,
        query,
        language: 'en',
        region: 'US',
        competitor: label,
        why: '品牌档案里的主要竞品',
        selected: true,
        status: 'planned',
        created_at: now,
        updated_at: now,
      }
      store.putPlanItem(row)
    })
  await alerts.propose().catch(() => undefined)
}
