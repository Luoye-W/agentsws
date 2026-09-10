/**
 * WP44：Shopify 官方 Dev MCP 的三个只读工具，在 dsh 这一面必须判成 read_external。
 *
 * 这条测试值一个专门的文件：它们既不是 `get_` 也不是 `list_` 开头，
 * 落到 `classifySideEffect` 的兜底就会被当成"写外部"——在 executor 策略下
 * 模型一调就被门禁拒，而且是**静悄悄**地拒（工具还在列表里，只是永远失败）。
 */
import { MCP_READ_TOOLS } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { classifySideEffect } from '../src/tools.js'

describe('WP44 MCP 只读工具的副作用判定', () => {
  it('三个都判成 read_external', () => {
    for (const tool of MCP_READ_TOOLS) {
      expect(classifySideEffect(tool), tool).toBe('read_external')
    }
  })

  it('别的带点号的名字仍按最严的兜底走（16 §3 fail-closed）', () => {
    expect(classifySideEffect('shopify.something.unknown')).toBe('write_external')
    expect(classifySideEffect('shopify_admin.execute_graphql')).toBe('write_external')
  })

  it('显式 override 仍然优先（调用方说了算）', () => {
    expect(
      classifySideEffect('shopify.docs.search', { 'shopify.docs.search': 'write_external' }),
    ).toBe('write_external')
  })
})
