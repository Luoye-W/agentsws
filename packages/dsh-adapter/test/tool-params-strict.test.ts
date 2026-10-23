/**
 * 10-09 真机（Rovella，店铺管理）：`shop_add_images` 的 `images[]` 是嵌套对象，原样转给 dsh
 * 时没写 `additionalProperties`，运行一启动就挂——「parameters.images.items.additionalProperties
 * must be explicitly true or false」，店铺管理一个字都答不出来。
 *
 * 钉住：每一个能摆进运行的工具，参数表都要过 dsh 自己那一道编译。
 */
import {
  ASSISTANT_TOOL_DEF_BY_NAME,
  B2B_OUTBOUND_TOOL_DEF_BY_NAME,
  IMAGE_TOOL_DEF_BY_NAME,
  KNOWLEDGE_LEARN_TOOL_DEF_BY_NAME,
  OWNER_TOOL_DEF_BY_NAME,
  SETUP_REQUEST_TOOL_DEF_BY_NAME,
  SHOP_TOOL_DEF_BY_NAME,
  SITE_HEALTH_TOOL_DEF_BY_NAME,
  SKILL_TOOL_DEF_BY_NAME,
  SOCIAL_WORK_TOOL_DEF_BY_NAME,
  THEME_TOOL_DEF_BY_NAME,
  WORKSHOP_SERVICE_TOOL_DEF_BY_NAME,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { buildToolDefinitions } from '../src/index.js'
import { makeRequest } from './helpers.js'

const ALL = [
  ...SHOP_TOOL_DEF_BY_NAME.keys(),
  ...THEME_TOOL_DEF_BY_NAME.keys(),
  ...IMAGE_TOOL_DEF_BY_NAME.keys(),
  ...OWNER_TOOL_DEF_BY_NAME.keys(),
  ...SKILL_TOOL_DEF_BY_NAME.keys(),
  ...B2B_OUTBOUND_TOOL_DEF_BY_NAME.keys(),
  // WP343：「我的助理」五个工具
  ...ASSISTANT_TOOL_DEF_BY_NAME.keys(),
  // WP334：AI 自己要连接卡 / 配置卡（所有职责都有）
  ...SETUP_REQUEST_TOOL_DEF_BY_NAME.keys(),
  // WP385：读网站体检结论（网站运营 / 内容与搜索）
  ...SITE_HEALTH_TOOL_DEF_BY_NAME.keys(),
  // WP488：客服知识库「学一遍」
  ...KNOWLEDGE_LEARN_TOOL_DEF_BY_NAME.keys(),
  // WP390：工坊服务两个工具（所有职责都有）
  ...WORKSHOP_SERVICE_TOOL_DEF_BY_NAME.keys(),
  // WP419：社媒发帖 / Reddit 起草出卡
  ...SOCIAL_WORK_TOOL_DEF_BY_NAME.keys(),
  'get_order',
]

describe('dsh 参数表：每个工具都过 dsh 的编译', () => {
  const noop = {
    run: async () => ({ status: 'ok' as const }),
    note: () => undefined,
    provenance: () => undefined,
  }
  // defineTool 当场按 dsh 的 DSL 编译参数表——有一个不认的键，这里就整个抛出来
  const build = () =>
    buildToolDefinitions(makeRequest({ allow: ALL }), noop, {
      stage: async () => undefined,
      draft: async () => undefined,
    })

  it('全部工具一起建得出来', () => {
    expect(build).not.toThrow()
    expect(build().map((d) => d.name)).toEqual(expect.arrayContaining(ALL))
  })

  it('shop_add_product_images：嵌套对象关上，必填落到属性上', () => {
    const def = build().find((d) => d.name === 'shop_add_product_images')
    const schema = def?.parameters as unknown as {
      properties: { images: { items: { additionalProperties: boolean } } }
      required: string[]
    }
    expect(schema.properties.images.items.additionalProperties).toBe(false)
    expect(schema.required).toEqual(expect.arrayContaining(['product_id', 'images']))
  })

  it('WP343「我的助理」：派活工具必填落到 text 上，可选的不带 required', () => {
    const def = build().find((d) => d.name === 'hand_to_position')
    const schema = def?.parameters as unknown as {
      properties: Record<string, { required?: boolean }>
      required?: string[]
    }
    const required = schema.required ?? []
    expect(required.includes('text') || schema.properties.text?.required === true).toBe(true)
    expect(required).not.toContain('position')
    expect(def?.description).toContain('拿不准')
  })

  it('WP350 拆成多份：items 的嵌套对象关上，kind / text 必填、岗位可不填', () => {
    const def = build().find((d) => d.name === 'plan_fanout')
    const schema = def?.parameters as unknown as {
      properties: { items: { items: { additionalProperties: boolean; required?: string[] } } }
      required: string[]
    }
    expect(schema.required).toContain('items')
    expect(schema.properties.items.items.additionalProperties).toBe(false)
    expect(schema.properties.items.items.required ?? []).toEqual(
      expect.arrayContaining(['kind', 'text']),
    )
    expect(schema.properties.items.items.required ?? []).not.toContain('position')
    expect(def?.description).toContain('就这样')
  })

  it('WP334 request_setup：建议值的嵌套对象关上，只有 why 必填，描述是写给模型的人话', () => {
    const def = build().find((d) => d.name === 'request_setup')
    const schema = def?.parameters as unknown as {
      properties: { suggestions: { items: { additionalProperties: boolean } } }
      required: string[]
    }
    expect(schema.properties.suggestions.items.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['why'])
    expect(def?.description).toContain('不要叫用户去设置页')
  })

  it('WP385 query_site_health：参数表与 stub / direct 同一份（只有可选的 part），描述说清只读、配置走 request_setup', () => {
    const def = build().find((d) => d.name === 'query_site_health')
    const schema = def?.parameters as unknown as {
      properties: Record<string, { enum?: string[]; required?: boolean }>
      required?: string[]
    }
    expect(Object.keys(schema.properties)).toEqual(['part'])
    expect(schema.properties.part?.enum).toContain('ai_traffic')
    expect(schema.properties.part?.required).not.toBe(true)
    expect(schema.required ?? []).toEqual([])
    expect(def?.description).toContain('只读')
    expect(def?.description).toContain('site.health')
  })

  it('WP390 find_service / draft_service_order：描述是写给模型的人话（不推销、只出卡不下单），对象按 name / value 填', () => {
    const find = build().find((d) => d.name === 'find_service')
    expect(find?.description).toContain('不要在正文里推销')
    const findSchema = find?.parameters as unknown as { required: string[] } | undefined
    expect(findSchema?.required).toEqual(['intent'])
    const draft = build().find((d) => d.name === 'draft_service_order')
    expect(draft?.description).toContain('只出卡不下单')
    const schema = draft?.parameters as unknown as {
      properties: {
        lines: { items: { properties: { target: { items: { required: string[] } } } } }
      }
    }
    expect(schema.properties.lines.items.properties.target.items.required).toEqual([
      'name',
      'value',
    ])
  })
})
