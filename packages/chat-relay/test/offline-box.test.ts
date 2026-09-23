import { describe, expect, it } from 'vitest'
import { MemoryOfflineBox, OFFLINE_MAX_ITEMS, sweepExpired } from '../src/offline-box.js'
import { KvOfflineBox, MemoryKv } from '../src/stores.js'

const T0 = '2026-09-21T10:00:00.000Z'
const item = (id: string, at = T0) => ({ id, sealed: 'sealed-bytes', created_at: at })

describe('离线留言箱', () => {
  it('取走即删（拉走并清除，不留第二份）', () => {
    const box = new MemoryOfflineBox()
    box.put('ws', item('a'))
    box.put('ws', item('b'))
    expect(box.count('ws')).toBe(2)
    expect(box.take('ws').map((i) => i.id)).toEqual(['a', 'b'])
    expect(box.count('ws')).toBe(0)
    expect(box.take('ws')).toEqual([])
  })

  it('条数上限：满了顶掉最旧的', () => {
    const box = new MemoryOfflineBox()
    for (let i = 0; i < OFFLINE_MAX_ITEMS + 5; i += 1) {
      box.put('ws', item(`m${i}`, new Date(Date.parse(T0) + i * 1000).toISOString()))
    }
    const left = box.take('ws')
    expect(left.length).toBe(OFFLINE_MAX_ITEMS)
    expect(left[0]?.id).toBe('m5')
    expect(left.at(-1)?.id).toBe(`m${OFFLINE_MAX_ITEMS + 4}`)
  })

  it('7 天超期被扫掉', () => {
    const box = new MemoryOfflineBox()
    box.put('ws', item('fresh'))
    box.put('ws', item('stale', '2026-09-10T10:00:00.000Z'))
    const swept = sweepExpired({ box, workspace: 'ws', now: T0 })
    expect(swept).toBe(1)
    expect(box.take('ws').map((i) => i.id)).toEqual(['fresh'])
  })

  it('KV 实现与内存实现同一份行为（契约一致性）', () => {
    const kv = new KvOfflineBox(new MemoryKv())
    kv.put('ws', item('a'))
    kv.put('ws', item('b'))
    expect(kv.count('ws')).toBe(2)
    expect(kv.take('ws').map((i) => i.id)).toEqual(['a', 'b'])
    expect(kv.take('ws')).toEqual([])
  })
})
