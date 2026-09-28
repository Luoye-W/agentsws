/**
 * WP181（WP180 报告「需要定」第 4 条）：代答（秘书）运行也带「现在时间 + 公司时区」。
 *
 * 给了公司时区：模型收到的那一句最后多一行（与运行时同一个 `timeContextItem`，按小时取整）；
 * 没给：一个字节不变（老行为）。
 */
import { describe, expect, it } from 'vitest'
import { fakeWorld } from './world.js'

const MON_10 = '2026-09-07T02:12:00.000Z' // 上海周一 10:12

async function userText(timeZone?: string): Promise<string> {
  const seen: string[] = []
  const w = fakeWorld(MON_10, {
    complete: async (input) => {
      seen.push(input.user)
      return '润色过的答案'
    },
    ...(timeZone === undefined ? {} : { timeZone: () => timeZone }),
  })
  await w.secretary.ask({
    viewer: 'p_chen',
    person_id: 'p_li',
    question: '李默负责哪些店？',
    assignment_id: 'a_chen',
  })
  return seen[0] ?? ''
}

describe('代答也知道现在几点', () => {
  it('给了公司时区：最后一行是那一句（按小时取整）', async () => {
    const text = await userText('Asia/Shanghai')
    expect(text.split('\n').at(-1)).toBe(
      '现在是 2026-09-07（周一）10:00 前后，公司时区 Asia/Shanghai（UTC+08:00）。没写时区的日期和时间都按这个时区理解。',
    )
  })

  it('没给：一个字节不变', async () => {
    const text = await userText()
    expect(text).not.toContain('现在是')
    expect(text.endsWith('李默负责哪些店？') || text.includes('规则版答案')).toBe(true)
  })
})
