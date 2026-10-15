/**
 * WP336（决策 810–812）：模拟里当场回答的替身改写 ```dsh-ui，并夹带按钮 / 图片 / 3D / 外链 / 配色。
 * 过滤后的节点类型 / 数量 / 数字要等于 mock 店铺；夹带的一个都不许漏过去。
 */
import { describe, expect, it } from 'vitest'
import { runPackScenario } from './helpers.js'

interface Answered {
  components: string[]
  genui?: {
    types: string[]
    table_rows: number[]
    stats: { label: string; value: string }[]
    text: string
  }
  mock?: { products: number; live: number }
}

describe('WP336 模拟：当场回答 ```dsh-ui', () => {
  it('过滤后只剩数字 + 表格，行数与数字等于 mock 店铺；夹带的全被滤掉；场景照样过', async () => {
    const { report, evidence } = await runPackScenario('org/position-entry-three-way.yml', 42)
    expect(report.passed).toBe(true)
    const answered = evidence.events
      .filter((e) => e.type === 'simulation.position_answered')
      .map((e) => e.payload as unknown as Answered)
      .find((p) => p.genui !== undefined)
    if (answered?.genui === undefined || answered.mock === undefined)
      throw new Error('没有 genui 回答')
    expect(answered.components).toEqual(['genui', 'genui:stat', 'genui:table'])
    expect(answered.genui.types).toEqual(['stat', 'table'])
    expect(answered.mock.products).toBeGreaterThan(0)
    expect(answered.genui.table_rows).toEqual([answered.mock.products])
    expect(answered.genui.stats).toEqual([{ label: '在卖', value: String(answered.mock.live) }])
    for (const bad of ['button', 'image', 'scene3d', 'link', 'http', 'action', 'accent', 'export'])
      expect(answered.genui.text).not.toContain(bad)
  })
})
