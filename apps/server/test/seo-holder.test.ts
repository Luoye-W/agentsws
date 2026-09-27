/**
 * WP159（Fable 追加）：好几个人持有「内容与搜索」时，每日报告卡送给谁。
 *
 * demo 里店主也挂着这条职责，原来取第一个持有人 → 报告卡送给了店主，真正负责的李默面板上一直是「还没读过」。
 * 规则：非店主优先；还有好几个按最早分到的（`pickRoleHolder`）。
 */
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/index.js'
import { pickRoleHolder } from '../src/seo-service.js'

const A = (id: string, person_id: string, granted_at: string, revoked_at?: string) => ({
  id,
  person_id,
  workspace_id: 'ws_1',
  granted_at,
  ...(revoked_at === undefined ? {} : { revoked_at }),
})

describe('pickRoleHolder', () => {
  const owner = (p: string) => p === 'p_owner'
  it('非店主优先；只有店主一个人时给店主', () => {
    expect(
      pickRoleHolder(
        [A('a1', 'p_owner', '2026-01-01'), A('a2', 'p_li', '2026-02-01')],
        'ws_1',
        owner,
      )?.person_id,
    ).toBe('p_li')
    expect(pickRoleHolder([A('a1', 'p_owner', '2026-01-01')], 'ws_1', owner)?.person_id).toBe(
      'p_owner',
    )
  })

  it('好几个非店主：最早分到的；撤销的、别的品牌的不算', () => {
    const list = [
      A('a3', 'p_wang', '2026-03-01'),
      A('a2', 'p_li', '2026-02-01', '2026-02-10'),
      A('a4', 'p_zhao', '2026-02-15'),
      { ...A('a5', 'p_x', '2026-01-01'), workspace_id: 'ws_2' },
    ]
    expect(pickRoleHolder(list, 'ws_1', owner)?.person_id).toBe('p_zhao')
    expect(pickRoleHolder([], 'ws_1', owner)).toBeUndefined()
  })
})

describe('真服务进程：店主和李默都持有内容与搜索', () => {
  it('每日报告卡送给李默，不送店主', async () => {
    const server = await createServer({
      quiet: true,
      clock: { now: () => '2026-09-27T09:00:00.000Z' },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      startRun: false,
      env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    })
    try {
      const ws = server.bootstrap.workspace.id
      const base = { workspace_id: ws, granted_by: server.bootstrap.person.id, ranges: [] }
      server.roles.assignments.create({
        ...base,
        person_id: server.bootstrap.person.id,
        role_id: 'dtc.content',
      })
      server.roles.assignments.create({ ...base, person_id: 'p_li', role_id: 'dtc.content' })
      // 与定时任务同一条路（不经 HTTP 闸，定时那一轮本来也没有"当前用户"）
      const out = await (await server.brands.forWorkspace(ws)).seoService.daily()
      const ids = out.approval_item_id === undefined ? [] : [out.approval_item_id]
      expect(ids).toHaveLength(1)
      const card = await server.txn.approvals.get(ids[0] ?? '')
      expect(card?.routing.recipients.map((r) => r.person)).toEqual(['p_li'])
    } finally {
      await server.close()
    }
  })
})
