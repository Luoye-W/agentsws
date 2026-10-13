/**
 * WP295：红人工作台提了卡之后，「要你处理」那一摊（`['deck']`）要跟着作废。
 * 以前只作废老的 `['cards']`，回执说「在卡片里等你批」，上面却还是「队列清空了」。
 */
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { refreshCards } from '../src/components/kol/kol-shared'

describe('WP295 红人工作台出卡后刷新卡片流', () => {
  it('作废的键与点卡之后那一组一样：deck / home / positions / position-instance（老的 cards 也留着）', () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    refreshCards(client)
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0])
    expect(keys).toEqual(['cards', 'deck', 'home', 'positions', 'position-instance'])
  })
})
