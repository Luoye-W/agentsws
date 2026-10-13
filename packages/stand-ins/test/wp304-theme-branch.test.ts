/**
 * WP304（决策 445）：stub 剧本里「起底」那一步给不给 source（没点名用哪套 → 不给，出选主题卡）。
 */
import type { RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { renderThemeAnswer, THEME_TOOL_NAMES, themeBranch } from '../src/runtime/theme.js'

const req = {
  actor: { role_id: 'site.shopify-theme' },
  tools: { allow: [...THEME_TOOL_NAMES] },
} as unknown as RunRequest
const initOf = (text: string) =>
  themeBranch(req, text)?.find((s) => s.tool === 'theme_init_from_base')?.input

describe('起底给不给 source（WP304）', () => {
  it('没点名 → 不给（出卡）；Horizon → store；高级主题 → premium；换主题 → replace', () => {
    expect(initOf('从头给我搭个首页')).toEqual({})
    expect(initOf('用 Horizon 给我搭个首页')).toEqual({ source: 'store' })
    expect(initOf('用高级主题给我搭个首页')).toEqual({ source: 'premium' })
    expect(initOf('换个主题')).toEqual({ replace: true })
    // 我们自己回过的话（「我们的高级主题排第一」「也可以用店里已装的免费主题」）不算人点了名
    expect(
      initOf(
        '从头给我搭个首页\n先选主题：出了一张选主题卡（我们的高级主题排第一，也可以用店里已装的免费主题）',
      ),
    ).toEqual({})
  })

  it('出了卡就照实说一句；高级主题选不了时说为什么', () => {
    const choice = { approval_item_id: 'apv_1', store_themes: 1, message: '' }
    expect(renderThemeAnswer({ choice: { ...choice, premium: 'buy' }, failed: {} })).toMatch(
      /高级主题排第一/,
    )
    expect(renderThemeAnswer({ choice: { ...choice, premium: 'soon' }, failed: {} })).toMatch(
      /即将开放/,
    )
    expect(
      renderThemeAnswer({ choice: { ...choice, premium: 'needs_account' }, failed: {} }),
    ).toMatch(/登录工坊账号后可买/)
  })
})
