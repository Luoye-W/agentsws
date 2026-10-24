/**
 * WP450：真服务进程端到端——出一组主题（HTTP）→ 在「要你处理」里批（HTTP decide，走真的卡定之后那一层）→
 * 编辑日历排上 → 第二天早上那一轮开写作事项；外链体检交公关；改写成社媒稿开到社媒职责；llms.txt 交建站。
 * 搜索结果、官方数据接口、最近发布都是替身（录好的样本），不联网、不花钱。
 */
import type { DataCallResult } from '@agentsws/contracts'
import {
  BACKLINK_SAMPLE_COMPETITORS,
  BACKLINK_SAMPLE_ROWS,
  BACKLINK_SAMPLE_SUMMARY,
  PLAN_SAMPLE_OVERVIEW,
  planSampleSerp,
  standInSearchData,
} from '@agentsws/seo-core'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/index.js'

describe('WP450 真服务进程', () => {
  it('出一组 → 批 → 日历 → 到日子开事项；外链交公关；社媒稿；llms.txt', async () => {
    let now = '2026-10-25T09:00:00.000Z'
    const search = standInSearchData({ serp: planSampleSerp() })
    const data = {
      capabilities: async () => ({
        at: now,
        capabilities: [
          {
            id: 'seo.backlink_summary',
            label_zh: '外链概况',
            label_en: 'Backlink summary',
            group: 'seo' as const,
            mode: 'sync' as const,
            unit: 'call' as const,
            credits_per_unit: 0.88,
            available: true,
            input: [],
          },
        ],
      }),
      call: async (
        capability: string,
        input: { input: Record<string, unknown> },
      ): Promise<DataCallResult> => {
        if (capability === 'seo.keyword_overview') return PLAN_SAMPLE_OVERVIEW
        if (capability === 'seo.backlink_summary') return BACKLINK_SAMPLE_SUMMARY
        return BACKLINK_SAMPLE_COMPETITORS.get(String(input.input.target)) ?? BACKLINK_SAMPLE_ROWS
      },
    }
    const server = await createServer({
      quiet: true,
      clock: { now: () => now },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      startRun: false,
      env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      searchDataFor: () => search,
      seoPlanDataFor: () => data,
      seoPublishedFor: async () => [
        {
          change_id: 'chg_1',
          title: 'How to choose a USB-C charger',
          url: 'https://shop.example/blogs/guide/how-to-choose',
          published_at: '2026-10-20T09:00:00.000Z',
          body: '<p>Most laptops need 65W.</p><h2>Check the wattage</h2><p>A 65W charger covers most laptops.</p>',
        },
      ],
    })
    try {
      const { url } = await server.listen(0)
      const ws = server.bootstrap.workspace.id
      const me = server.bootstrap.person.id
      const base = {
        workspace_id: ws,
        granted_by: me,
        ranges: [{ kind: 'store' as const, id: 'store_1' }],
        person_id: me,
      }
      const seo = server.roles.assignments.create({ ...base, role_id: 'dtc.seo' })
      for (const role_id of ['dtc.content', 'pr.press', 'social.x', 'site.shopify-theme'])
        server.roles.assignments.create({ ...base, role_id })
      const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const res = await fetch(`${url}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${server.bootstrap.internalToken}`,
            'X-Assignment': seo.id,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const json = (await res.json()) as { data: T; message?: string }
        if (!res.ok)
          throw new Error(`${method} ${path} → ${String(res.status)} ${json.message ?? ''}`)
        return json.data
      }
      await api('PUT', '/v1/workspace/profile', {
        legal_name: 'NordVolt Gear Ltd.',
        discoverable: false,
        domain: 'shop.example',
        subcategory: 'usb c charger',
      })
      const planned = await api<{ approval_item_id?: string; skipped?: string }>(
        'POST',
        '/v1/seo/clusters/plan',
        {},
      )
      expect(planned.skipped).toBeUndefined()
      const card = await api<{ version: number; kind: string }>(
        'GET',
        `/v1/approvals/${encodeURIComponent(planned.approval_item_id ?? '')}`,
      )
      expect(card.kind).toBe('seo_cluster')
      await api(
        'POST',
        `/v1/approvals/${encodeURIComponent(planned.approval_item_id ?? '')}/decide`,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
        },
      )
      const cal = await api<{ entries: { date: string; status: string }[]; pending?: unknown[] }>(
        'GET',
        '/v1/seo/calendar',
      )
      expect(cal.pending).toBeUndefined()
      expect(cal.entries.map((e) => e.date)).toEqual([
        '2026-10-26',
        '2026-10-26',
        '2026-10-27',
        '2026-10-27',
        '2026-10-28',
      ])
      now = '2026-10-26T08:00:00.000Z'
      const plan = (await server.brands.forWorkspace(ws)).seoPlan
      expect(await plan.tickCalendar()).toEqual({ opened: 2 })
      const after = await api<{ entries: { status: string; matter_id?: string }[] }>(
        'GET',
        '/v1/seo/calendar',
      )
      expect(after.entries.filter((e) => e.status === 'opened')).toHaveLength(2)

      await api('PUT', '/v1/seo/backlinks', {
        competitors: ['voltpeak.example', 'chargely.example'],
      })
      const run = await api<{ gap: unknown[]; handed_to_pr?: { matter_id: string } }>(
        'POST',
        '/v1/seo/backlinks/run',
        {},
      )
      expect(run.handed_to_pr?.matter_id).toBeDefined()
      const rp = await api<{ matters: { role_id: string }[] }>('POST', '/v1/seo/repurpose', {
        change_id: 'chg_1',
        channels: ['x'],
      })
      expect(rp.matters.map((m) => m.role_id)).toEqual(['social.x'])
      const llms = await api<{
        draft?: { content: string }
        handed_to_site?: { matter_id: string }
      }>('POST', '/v1/seo/llms-txt', { handoff: true })
      expect(llms.handed_to_site?.matter_id).toBeDefined()
      expect(llms.draft?.content.startsWith('# ')).toBe(true)
    } finally {
      await server.close()
    }
  })
})
