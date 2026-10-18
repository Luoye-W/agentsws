/** WP419（自查 U6）：直接进日历、本人担着社媒职责 →「社媒排期」默认勾上。 */
import { describe, expect, it } from 'vitest'
import { defaultLayersFor } from '@/lib/calendar-layers'

describe('WP419 日历默认图层', () => {
  it('担社媒职责的人直接进日历也看得到自己的排期；别人不变', () => {
    expect(defaultLayersFor(undefined, ['social.instagram', 'dtc.store'])).toContain('social_post')
    expect(defaultLayersFor(undefined, ['dtc.store'])).toEqual(['todo', 'meeting', 'card_due'])
    expect(defaultLayersFor('social.x')).toEqual(['social_post', 'todo'])
  })
})
