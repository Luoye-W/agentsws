/**
 * WP141（docs/78 §2）：屏幕上的内部值 → 人话，全工作台一处（`lib/humanize`）。
 */
import { describe, expect, it } from 'vitest'
import {
  approvalStateLabel,
  cellText,
  channelLabel,
  fieldLabel,
  fieldValue,
  formatLabel,
  recordText,
  tOr,
} from '@/lib/humanize'

describe('字段名与值', () => {
  it('业务边界：late_return_grace_days 0 → 7 写成带单位的人话', () => {
    expect(fieldLabel('late_return_grace_days', 'zh')).toBe('过了退货期还能宽限')
    expect(fieldValue('late_return_grace_days', 7, 'zh')).toBe('7 天')
    expect(fieldValue('late_return_grace_days', 7, 'en')).toBe('7 days')
  })

  it('日报那四个列头', () => {
    expect(['date', 'sales', 'orders', 'low_stock'].map((k) => fieldLabel(k, 'zh'))).toEqual([
      '日期',
      '销售额',
      '订单',
      '库存告急',
    ])
  })

  it('枚举值、是非、ISO 时间都翻；表里没有的字段名不像代码', () => {
    expect(fieldValue('stage', 'delivering', 'zh')).toBe('交付中')
    expect(fieldValue('published', true, 'zh')).toBe('是')
    expect(fieldValue('due_at', '2026-09-27T01:00:00.000Z', 'zh')).not.toContain('T01:00')
    expect(fieldLabel('some_new_field', 'zh')).toBe('some new field')
    expect(recordText({ late_return_grace_days: 0 }, 'zh')).toBe('过了退货期还能宽限：0 天')
  })
})

describe('渠道、形态、状态', () => {
  it('渠道名按品牌写法，形态写中文', () => {
    expect(channelLabel('youtube', 'zh')).toBe('YouTube')
    expect(channelLabel('instagram', 'zh')).toBe('Instagram')
    expect(channelLabel('email', 'zh')).toBe('邮件')
    expect(formatLabel('video', 'zh')).toBe('视频')
    expect(formatLabel('post', 'zh')).toBe('图文帖')
  })

  it('表格一格：渠道 / 形态 / 期限', () => {
    expect(cellText('channel', 'youtube', 'zh')).toBe('YouTube')
    expect(cellText('kind', 'video', 'zh')).toBe('视频')
    expect(cellText('due_at', '2026-09-27T01:00:00.000Z', 'zh')).not.toMatch(/\dT\d/)
    expect(cellText('name', 'Gadget Jonas', 'zh')).toBe('Gadget Jonas')
  })

  it('审批状态', () => {
    expect(approvalStateLabel('approved_edited', 'zh')).toBe('改后批了')
    expect(approvalStateLabel('in_review', 'zh')).toBe('审核中')
  })
})

describe('tOr：i18n 键永远不上屏', () => {
  it('查不到就给兜底说法', () => {
    const t = (k: string): string => (k === 'known' ? '认得' : k)
    expect(tOr(t, 'known', '兜底')).toBe('认得')
    expect(tOr(t, 'kol.contact.source.nope', '兜底')).toBe('兜底')
  })
})
