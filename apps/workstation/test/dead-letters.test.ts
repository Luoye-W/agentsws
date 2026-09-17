import { describe, expect, it } from 'vitest'
import { deadLettersFor } from '@/components/connections/dead-letters'
import type { DeadLetterView } from '@/lib/api'

const letter = (id: string, channel: string): DeadLetterView => ({
  id,
  channel,
  reason: 'retries_exhausted',
  attempts: 3,
  at: '2026-09-11T09:00:00.000Z',
})

describe('死信只落在它进来的那条连接上（09-17 真机：邮箱死信串到了 Shopify 卡）', () => {
  const all = [letter('a', 'email'), letter('b', 'email'), letter('c', 'wechat')]
  it('邮箱连接看到 email 渠道的那几封', () => {
    expect(deadLettersFor({ service: 'imap_smtp' }, all).map((d) => d.id)).toEqual(['a', 'b'])
  })
  it('Shopify 没有入站渠道，一封都不显示', () => {
    expect(deadLettersFor({ service: 'shopify' }, all)).toEqual([])
  })
  it('表里没有的渠道不在这一页显示', () => {
    expect(deadLettersFor({ service: 'imap_smtp' }, [letter('c', 'wechat')])).toEqual([])
  })
})
