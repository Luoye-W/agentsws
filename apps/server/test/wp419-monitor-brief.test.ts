/**
 * WP419（自查 P8）：信息监控每天一份简报——职责说明里承诺的那份真的出来了：拉完一轮之后，按本地日一份，
 * 自家 / 竞品 / 行业各几条（负面在前、带链接），没拉到的源照实列「不等于没人提」，进担信息监控那个人的报表区。
 * 替身 feed（录好的 Google Alerts 样本），不联网。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReportPayload } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMonitorBrief } from '../src/pr-watch/brief.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const NOW = '2026-10-17T10:00:00.000Z'
const m = (over: Record<string, unknown>) => ({
  url: 'https://news.example.com/a',
  origin: 'news.example.com',
  text: 'text',
  published_at: '2026-10-17T03:00:00.000Z',
  observed_at: '2026-10-17T09:00:00.000Z',
  ...over,
})

describe('WP419 监控简报（纯函数）', () => {
  it('各组几条、负面在前、没拉到的源照实列；24 小时外的不算', () => {
    const b = buildMonitorBrief({
      now: NOW,
      tzOffsetMinutes: 480,
      mentions: [
        m({ title: 'Good review', sentiment: 'positive', group: 'own' }),
        m({
          title: 'Battery recall rumor',
          sentiment: 'negative',
          group: 'own',
          url: 'https://x.example/r',
        }),
        m({ title: 'Rival launches R2', group: 'competitor', competitor: 'Rival' }),
        m({ title: 'Old news', group: 'industry', observed_at: '2026-10-15T09:00:00.000Z' }),
      ] as never,
      sources: [
        { label: 'Google 提醒：Nordvolt', group: 'own', status: 'ok' },
        { label: '行业网站 RSS', group: 'industry', status: 'failed', last_error: '403 被拒' },
      ],
    })
    expect(b.date).toBe('2026-10-17')
    expect(b.title).toBe('监控简报 · 10-17')
    expect(b.counts).toEqual({ own: 2, competitor: 1, industry: 0, site: 0 })
    const own = b.markdown.indexOf('## 自家')
    expect(b.markdown.indexOf('Battery recall rumor')).toBeLessThan(
      b.markdown.indexOf('Good review'),
    )
    expect(b.markdown.indexOf('Battery recall rumor')).toBeGreaterThan(own)
    expect(b.markdown).toContain(
      '[Battery recall rumor](https://x.example/r)（负面 · news.example.com）',
    )
    expect(b.markdown).toContain('（Rival · news.example.com）')
    expect(b.markdown).toContain('## 行业（0 条）\n这一天没有新的。')
    expect(b.markdown).not.toContain('Old news')
    expect(b.markdown).not.toContain('## 指定网站')
    expect(b.markdown).toContain('## 没拉到的源（1 条）')
    expect(b.markdown).toContain('不等于没人提')
    expect(b.markdown).toContain('行业网站 RSS：403 被拒')
    expect(b.failed).toBe(1)
  })
})

describe('WP419 监控简报（真服务）', () => {
  let server: Server | undefined
  let dir = ''
  afterEach(async () => {
    await server?.close()
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  })
  it('拉完一轮出当天那一份，进报表区；同一天不出第二份；没人担信息监控不出', async () => {
    const GA = 'https://www.google.com/alerts/feeds/00000000000000000000/0000000000000000000'
    const feed = readFileSync(
      join(__dirname, '../../../packages/pr-core/test/fixtures/google-alerts-3.atom.xml'),
      'utf8',
    )
    dir = mkdtempSync(join(tmpdir(), 'wp419-brief-'))
    server = await createServer({
      dbDir: dir,
      quiet: true,
      clock: { now: () => NOW },
      env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      startRun: false,
      feedFetch: async (url: string) =>
        url === GA
          ? { ok: true, status: 200, text: async () => feed }
          : { ok: false, status: 404, text: async () => '' },
    })
    const ws = server.bootstrap.workspace.id
    const brand = await server.brands.forWorkspace(ws)
    if (brand.prWatch === undefined || brand.publishMonitorBrief === undefined)
      throw new Error('没装')
    expect(await brand.publishMonitorBrief()).toBe(false)
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: ws,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id: 'pr.monitoring',
    })
    await brand.prWatch.addLinks({ links: GA })
    await brand.prService.monitorSweep()
    expect(await brand.publishMonitorBrief()).toBe(true)
    expect(await brand.publishMonitorBrief()).toBe(false)
    const reports = server.txn.runtime.store
      .listApprovals({ workspace_id: ws, kind: 'weekly_review' })
      .filter((x) => (x.payload as ReportPayload).series === '监控简报')
    expect(reports).toHaveLength(1)
    const p = reports[0]?.payload as ReportPayload
    expect(p.title).toBe('监控简报 · 10-17')
    expect(p.markdown).toContain('## 自家（3 条）')
    expect(p.markdown).toContain('news item 1')
    expect(reports[0]?.role_id).toBe('pr.monitoring')
  })
})
