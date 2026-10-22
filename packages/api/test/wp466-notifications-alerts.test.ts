/**
 * WP466：`GET /v1/notifications` 回之前先把本人现在挂着的系统卡（原首页告警区）交给端口对一遍；
 * 系统卡取不到 / 对的时候出错，铃铛照旧回已有的通知（永不因此失败）。
 */
import type { NotificationList } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { createGateway, type NotificationsPort, type WorkstationPort } from '../src/index.js'
import { harness } from './helpers.js'

const EMPTY: NotificationList = { items: [], unread: 0 }

function port(over: Partial<NotificationsPort> = {}): NotificationsPort {
  return {
    list: () => EMPTY,
    markRead: () => ({ unread: 0 }),
    markAllRead: () => ({ unread: 0 }),
    prefs: () => ({}) as never,
    setPrefs: () => ({}) as never,
    ...over,
  }
}

async function wired(notifications: NotificationsPort, systemCards: () => unknown) {
  const h = await harness()
  const workstation = { systemCards } as unknown as WorkstationPort
  const gateway = createGateway({ ...h.deps, notifications, workstation })
  const res = await gateway.fetch(
    new Request('http://127.0.0.1/v1/notifications', {
      headers: { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id },
    }),
  )
  return { res, h }
}

describe('WP466 铃铛来问时先对系统卡', () => {
  it('把本人的系统卡交给端口，再回列表', async () => {
    const card = { id: 'c1', kind: 'system_alert', title: '店铺销售额掉了 90%' } as DeckCard
    const synced: { person: string; ids: string[] }[] = []
    const order: string[] = []
    const { res, h } = await wired(
      port({
        syncAlerts: (actor, alerts) => {
          order.push('sync')
          synced.push({ person: actor.person_id, ids: alerts.map((a) => a.id) })
        },
        list: () => {
          order.push('list')
          return EMPTY
        },
      }),
      () => ({ alerts: [card] }),
    )
    expect(res.status).toBe(200)
    expect(synced).toEqual([{ person: h.assignment.person_id, ids: ['c1'] }])
    expect(order).toEqual(['sync', 'list'])
  })

  it('系统卡取不到 / 对的时候出错：照旧回列表', async () => {
    const boom = await wired(port(), () => {
      throw new Error('upstream down')
    })
    expect(boom.res.status).toBe(200)
    const bad = await wired(
      port({
        syncAlerts: () => {
          throw new Error('db locked')
        },
      }),
      () => ({ alerts: [] }),
    )
    expect(bad.res.status).toBe(200)
  })
})
