/**
 * WP213（docs/36 §8.2）：岗位模板的 `icon` 字段。
 *
 * - 内置的每一个岗位模板都写了图标（目录就是名单，加一个 yml 忘了写这一格当场红）；
 * - `icon` 是只加的可选字段：外部写的岗位不填照样读得进来；
 * - `bundledPositionIcon` 按 id 取；没有 yml 的（负责人 / 普通成员是 `org.ts` 种的）回 `undefined`。
 */
import { describe, expect, it } from 'vitest'
import { bundledPositionIcon, loadBundledPositions, parsePosition } from '../src/index.js'

describe('岗位图标（WP213）', () => {
  it('内置的每一个岗位模板都有 icon，而且就是它自己的模板 id', () => {
    const all = loadBundledPositions()
    expect(all.length).toBeGreaterThanOrEqual(10)
    for (const p of all) {
      expect(p.icon, `${p.id} 没写 icon`).toBeDefined()
      // 图形 id 与模板 id 同名：工作台 glyphs.ts 里岗位那几枚就是按模板 id 起的
      expect(p.icon).toBe(p.id)
      expect(bundledPositionIcon(p.id)).toBe(p.icon)
    }
  })

  it('没有 yml 的岗位（负责人 / 普通成员 / 自建）回 undefined，界面自己推', () => {
    expect(bundledPositionIcon('owner')).toBeUndefined()
    expect(bundledPositionIcon('member')).toBeUndefined()
    expect(bundledPositionIcon('pos_custom_123')).toBeUndefined()
  })

  it('icon 是可选的：不填照样读得进来；填了必须是字符串', () => {
    const base = 'id: x\nversion: 1.0.0\nname: { zh: 甲, en: A }\nroles:\n  - { role: dtc.support, default: true }\n'
    expect(parsePosition(base).icon).toBeUndefined()
    expect(parsePosition(`${base}icon: customer-care\n`).icon).toBe('customer-care')
    expect(() => parsePosition(`${base}icon: [1, 2]\n`)).toThrow()
  })
})
