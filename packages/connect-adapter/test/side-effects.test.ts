import { describe, expect, it } from 'vitest'
import { defaultSideEffectsFile, loadSideEffectTable, parseSideEffectTable } from '../src/index.js'

describe('action-side-effects.yml（18 §1 覆盖表）', () => {
  const table = loadSideEffectTable()

  it('包内自带的表能加载，路径可解析', () => {
    expect(defaultSideEffectsFile().endsWith('action-side-effects.yml')).toBe(true)
    expect(table.size()).toBeGreaterThan(80)
    expect(table.fallback).toBe('write')
  })

  it('六个关键 provider 的常用 Action 都标了', () => {
    const reads = [
      'shopify_admin.get_order',
      'shopify_admin.list_orders',
      'gmail.list_threads',
      'gmail.search_threads',
      'meta.get_insights',
      'whatsapp.get_message_templates',
      'klaviyo.list_profiles',
      'aftership.get_tracking',
    ]
    const writes = [
      'shopify_admin.create_fulfillment',
      'shopify_admin.update_product',
      'gmail.send_email',
      'gmail.reply_to_thread',
      'whatsapp.send_message',
      'whatsapp.send_template_message',
      'klaviyo.create_event',
      'aftership.create_tracking',
    ]
    for (const id of reads) {
      expect(table.covers(id), id).toBe(true)
      expect(table.resolve(id), id).toBe('read')
    }
    for (const id of writes) {
      expect(table.covers(id), id).toBe(true)
      expect(table.resolve(id), id).toBe('write')
    }
  })

  it('未标的按 write —— 这一条是安全默认', () => {
    expect(table.covers('shopify_admin.some_brand_new_action')).toBe(false)
    expect(table.resolve('shopify_admin.some_brand_new_action')).toBe('write')
    expect(table.resolve('a_service_we_never_heard_of.get_thing')).toBe('write')
  })

  it('GraphQL / 批量类永远是 write（副作用由运行时文档决定，静态判不了）', () => {
    expect(table.resolve('shopify_admin.execute_graphql')).toBe('write')
    expect(table.resolve('shopify_admin.submit_bulk_query')).toBe('write')
  })

  it('通配只在显式声明的服务上生效', () => {
    expect(table.resolve('aftership.list_couriers')).toBe('read')
    expect(table.covers('aftership.list_couriers')).toBe(true)
    expect(table.resolve('gmail.list_something_new')).toBe('write')
  })

  it('自定义表：default 可以显式给出，read/write 之外的值直接报 invalid_input', () => {
    const t = parseSideEffectTable(`
version: 1
default: read
actions:
  x.y: write
`)
    expect(t.fallback).toBe('read')
    expect(t.resolve('x.y')).toBe('write')
    expect(t.resolve('x.z')).toBe('read')
    expect(() => parseSideEffectTable('actions:\n  x.y: maybe\n')).toThrowError(
      /side_effect 必须是 read 或 write/,
    )
    expect(() => parseSideEffectTable('- 1\n- 2\n')).toThrowError(/必须是一个映射/)
  })

  it('读不到文件时是 not_found', () => {
    try {
      loadSideEffectTable('/definitely/not/here.yml')
      expect.unreachable('应当抛错')
    } catch (e) {
      expect(e).toMatchObject({ code: 'not_found' })
    }
  })
})
