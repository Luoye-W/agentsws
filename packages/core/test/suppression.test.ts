/**
 * WP64：退订 / 抑制名单这条规则**只有一份**（18 §3）。
 *
 * 这里钉的是那一份的口径：归一到什么程度、剔除之后剩谁、以及 WP55 立的那条
 * "名单上的人收不到主动外发，但在他自己的线程里回信放行"。
 */
import { describe, expect, it } from 'vitest'
import {
  blocksProactiveOutbound,
  suppressedRecipients,
  suppressionKey,
  withoutSuppressed,
} from '../src/index.js'

describe('抑制名单（18 §3 / WP55 同一条规则）', () => {
  it('归一：去空白、转小写、去加号别名', () => {
    expect(suppressionKey('  Anna+promo@Example.com ')).toBe('anna@example.com')
    expect(suppressionKey('ANNA@example.com')).toBe('anna@example.com')
  })

  it('不做点号归一：两个真不同的人不许被并成一个', () => {
    expect(suppressionKey('a.b@gmail.com')).not.toBe(suppressionKey('ab@gmail.com'))
  })

  it('命中的按收件人那一侧的原样字符串回（卡面上要认得出）', () => {
    expect(
      suppressedRecipients(['Anna+promo@Example.com', 'bob@x.com'], ['anna@example.com']),
    ).toEqual(['Anna+promo@Example.com'])
  })

  it('剔除之后顺序不变', () => {
    expect(withoutSuppressed(['a@x.com', 'b@x.com', 'c@x.com'], ['B@X.com'])).toEqual([
      'a@x.com',
      'c@x.com',
    ])
  })

  it('名单上的人收不到主动外发；在他自己的线程里回信放行', () => {
    expect(blocksProactiveOutbound({ suppressed_hits: 1 })).toBe(true)
    expect(blocksProactiveOutbound({ suppressed_hits: 1, reply_in_original_thread: true })).toBe(
      false,
    )
    expect(blocksProactiveOutbound({ suppressed_hits: 0 })).toBe(false)
  })
})
