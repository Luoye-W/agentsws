/**
 * WP131：运营后台价目页——每条能力的现价、来历（basis）与「未核」标记。
 *
 * 与成本表的「未核对」同一套做法：`reviewed_at` 没日期就是未核，健康页多一格黄灯。
 * 只给员工看：来历里有成本与倍率，那是中间量，不进用户界面（49 M4）。
 */
import { PRICING_FILE } from '@agentsws/metering'
import { afterEach, describe, expect, it } from 'vitest'
import { adminHarness, staffLogin } from './wp115-helpers.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

describe('WP131 价目页', () => {
  it('每条都有现价与来历；还有没核的就挂黄灯（09-23 起大部分已核）', async () => {
    const ah = adminHarness()
    close = ah.close
    const staff = await staffLogin(ah, 'ops@example.com', 'support')
    const res = await ah.call('/v1/admin/pricing', { session: staff.session })
    expect(res.status).toBe(200)
    const data = res.body.data as {
      rows: {
        capability: string
        credits_per_unit: number
        basis: string
        reviewed_at: string | null
        needs_review: boolean
      }[]
      unreviewed: number
    }
    expect(data.rows).toHaveLength(PRICING_FILE.entries.length)
    for (const row of data.rows) {
      expect(row.basis.length, row.capability).toBeGreaterThan(10)
      expect(row.needs_review).toBe(row.reviewed_at === null || row.reviewed_at === '')
    }
    expect(data.unreviewed).toBe(data.rows.filter((r) => r.needs_review).length)
    expect(data.unreviewed).toBeGreaterThan(0) // standby 那条没定过价，仍未核 → 健康页黄灯
    expect(data.rows.find((r) => r.capability === 'data.kol.audit')?.credits_per_unit).toBe(3)

    const health = await ah.call('/v1/admin/health', { session: staff.session })
    const item = (health.body.data as { items: { key: string; status: string }[] }).items.find(
      (i) => i.key === 'pricing_review',
    )
    expect(item?.status).toBe('warn')
  })

  it('不是员工看不到（服务端对无权者一律 404 / 401）', async () => {
    const ah = adminHarness()
    close = ah.close
    const res = await ah.call('/v1/admin/pricing', {})
    expect([401, 404]).toContain(res.status)
  })
})
