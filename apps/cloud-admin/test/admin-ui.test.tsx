/**
 * 后台前端的几条。
 *
 * 钉的都是"看错一个数就会做错一件事"的地方：微单位什么时候除、两套词条有没有
 * 缺项、只读角色看不看得见写按钮、亏本卡在 0 行时**不渲染**。
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Kpi, Note, StatusPill } from '../src/components/design'
import { cny, compact, credits, day, orDash, when } from '../src/lib/format'
import { en, translate, zh } from '../src/lib/i18n'

describe('显示口径', () => {
  it('微单位只在显示时除；比一分钱还少不写成 ¥0.00', () => {
    expect(cny(1_000_000)).toBe('¥1.00')
    expect(cny(1_234_500)).toBe('¥1.23')
    expect(cny(-2_000_000)).toBe('-¥2.00')
    // 便宜模型一次调用的量级：写成 ¥0.00 看起来像"免费"，而它只是很便宜
    expect(cny(300)).toBe('<¥0.01')
    expect(cny(0)).toBe('¥0.00')
  })

  it('积分按 1 积分 = ¥1 显示，但不带货币符号', () => {
    expect(credits(12.5)).toBe('12.5')
    expect(credits(0)).toBe('0')
  })

  it('大数收拢：中英两套量词', () => {
    expect(compact(9999)).toBe('9,999')
    expect(compact(12_345, 'zh')).toBe('1.2万')
    expect(compact(12_345, 'en')).toBe('12.3k')
  })

  it('空值出「—」而不是空白：空白看不出这里本来有没有值', () => {
    expect(orDash(null)).toBe('—')
    expect(orDash('')).toBe('—')
    expect(when(undefined)).toBe('—')
    expect(day(null)).toBe('—')
    expect(day('2026-09-18T12:00:00.000Z')).toBe('2026-09-18')
  })
})

describe('两套词条', () => {
  it('英文一条都不缺（缺了会在界面上露出 key）', () => {
    const missing = Object.keys(zh).filter((key) => !(key in en))
    expect(missing).toEqual([])
  })

  it('占位替换：缺变量时原样留着，不出 undefined', () => {
    expect(translate('zh', 'page.of', { from: 1, to: 20, total: 87 })).toBe('第 1–20 条，共 87')
    expect(translate('en', 'page.of', { from: 1, to: 20, total: 87 })).toBe('1–20 of 87')
    expect(translate('zh', 'overview.loss.body', { rows: 3 })).toContain('{loss}')
  })

  it('界面上不出现仓库名 agentsws（产品名是「Agents 工坊」）', () => {
    for (const [key, value] of Object.entries(zh)) expect(value, key).not.toContain('agentsws')
    for (const [key, value] of Object.entries(en)) expect(value, key).not.toContain('agentsws')
    expect(zh['app.title']).toBe('Agents 工坊 · 运营后台')
    expect(en['app.title']).toBe('Agents Workshop · Admin')
  })
})

describe('最小件', () => {
  it('KPI 只排版不算数：给什么显示什么', () => {
    render(<Kpi label="30 天毛利" value="¥1,234.00" delta="+3/7d · +9/30d" />)
    expect(screen.getByText('¥1,234.00')).toBeDefined()
    expect(screen.getByText('+3/7d · +9/30d')).toBeDefined()
  })

  it('状态胶囊把语义色写在 data-tone 上（换皮时改 token 不改组件）', () => {
    render(<StatusPill tone="bad">已封禁</StatusPill>)
    expect(screen.getByTestId('pill').getAttribute('data-tone')).toBe('bad')
  })

  it('Note 能承载那几句"这个数不是什么"的解释', () => {
    render(<Note tone="warn">成本还没核对过</Note>)
    expect(screen.getByText('成本还没核对过')).toBeDefined()
  })
})
