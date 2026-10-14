/**
 * WP311（决策 507）：IM 回复里的工作台链接带上品牌（`?brand=`）。真装配线那几条在 `wp308-im-position.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { withBrandParam } from '../src/im-channels.js'

describe('WP311 链接带品牌', () => {
  it('根地址、深链都只加 brand 那一格', () => {
    expect(withBrandParam('http://127.0.0.1:7777', 'ws_b')).toBe(
      'http://127.0.0.1:7777/?brand=ws_b',
    )
    expect(withBrandParam('http://127.0.0.1:7777/cards/itm_1', 'ws_b')).toBe(
      'http://127.0.0.1:7777/cards/itm_1?brand=ws_b',
    )
    expect(withBrandParam('https://x.example/matters/m?tab=a', 'ws b')).toBe(
      'https://x.example/matters/m?tab=a&brand=ws+b',
    )
  })

  it('已经带了就换成这一个；拼不成 URL 原样回', () => {
    expect(withBrandParam('http://h/p?brand=ws_a', 'ws_b')).toBe('http://h/p?brand=ws_b')
    expect(withBrandParam('不是地址', 'ws_b')).toBe('不是地址')
  })
})
