/**
 * 10-09 真机（Rollout，店铺管理）：`shop_add_images` 的 `images[]` 是嵌套对象，原样转给 dsh
 * 时没写 `additionalProperties`，运行一启动就挂——「parameters.images.items.additionalProperties
 * must be explicitly true or false」，店铺管理一个字都答不出来。
 *
 * 钉住：每一个能摆进运行的工具，参数表都要过 dsh 自己那一道编译。
 */
import {
  B2B_OUTBOUND_TOOL_DEF_BY_NAME,
  IMAGE_TOOL_DEF_BY_NAME,
  OWNER_TOOL_DEF_BY_NAME,
  SHOP_TOOL_DEF_BY_NAME,
  SKILL_TOOL_DEF_BY_NAME,
  THEME_TOOL_DEF_BY_NAME,
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
})
