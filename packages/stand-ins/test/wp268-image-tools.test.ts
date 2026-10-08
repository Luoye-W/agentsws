/**
 * WP268：生图 / 改图 / 素材库三个工具的名字、给模型看的定义、职责表、stub 剧本与「配图的做法」那一节。
 * 只有工具面里有它们的运行才多这几条定义——别的运行的工具表逐字不变。
 */
import type { RunRequest } from '@agentsws/contracts'
import { IMAGE_CAPS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  assemblePrompt,
  EDIT_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  humanizeToolNames,
  IMAGE_TOOL_DEF_BY_NAME,
  IMAGE_TOOL_NAMES,
  imageBranch,
  imageDataOf,
  imageWorkSection,
  isImageRole,
  LIST_BRAND_ASSETS_TOOL,
  renderImageAnswer,
  TOOL_WORDS_ZH,
} from '../src/index.js'

const req = (allow: string[], role_id = 'site.shopify-theme'): RunRequest =>
  ({
    id: 'run_1',
    actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id },
    persona: { sections: [] },
    skills: [],
    context: [],
    tools: { allow, connect_token: '', side_effect_policy: 'executor' },
    expectations: { outputs: ['draft'], must_stage_if_change_requested: false },
  }) as unknown as RunRequest

describe('定义', () => {
  it('三个名字排好序；设计岗五条 + 网页模板才有', () => {
    expect(IMAGE_TOOL_NAMES).toEqual([EDIT_IMAGE_TOOL, GENERATE_IMAGE_TOOL, LIST_BRAND_ASSETS_TOOL])
    expect(isImageRole('design.social')).toBe(true)
    expect(isImageRole('site.shopify-theme')).toBe(true)
    expect(isImageRole('dtc.store')).toBe(false)
  })

  it('张数上限写进参数；改图收 asset_ids / product_id；place 说清人挑中后自动挂', () => {
    const gen = IMAGE_TOOL_DEF_BY_NAME.get(GENERATE_IMAGE_TOOL)
    if (gen === undefined) throw new Error('没有 generate_image')
    const props = (
      gen.input_schema as {
        properties: Record<string, { maximum?: number; description?: string }>
      }
    ).properties
    expect(props.n?.maximum).toBe(IMAGE_CAPS.per_call)
    expect(props.place?.description).toContain('人挑中')
    expect(gen.description).toContain('挑图卡')
    const edit = IMAGE_TOOL_DEF_BY_NAME.get(EDIT_IMAGE_TOOL)
    if (edit === undefined) throw new Error('没有 edit_image')
    expect(Object.keys((edit.input_schema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['asset_ids', 'product_id', 'mask_asset_id']),
    )
  })

  it('进 stub / direct 的工具表（只有工具面里有它们的运行）', () => {
    const withIt = assemblePrompt(req(['generate_image'])).tools
    expect(withIt.find((t) => t.name === GENERATE_IMAGE_TOOL)?.description).toContain('素材库')
    const without = assemblePrompt(req(['get_order'])).tools
    expect(without.map((t) => t.name)).not.toContain(GENERATE_IMAGE_TOOL)
  })

  it('人话名：回复里露了工具名也换掉', () => {
    expect(TOOL_WORDS_ZH.generate_image).toBe('生图')
    expect(humanizeToolNames('我用 `edit_image` 改了一版', ['edit_image'])).not.toContain(
      'edit_image',
    )
  })
})

describe('stub 剧本', () => {
  it('网页模板说「出首页横幅图」→ 16:9、三张、挂到首页 hero', () => {
    const steps = imageBranch(req(IMAGE_TOOL_NAMES as string[]), '给首页出几张横幅图')
    expect(steps).toEqual([
      {
        tool: GENERATE_IMAGE_TOOL,
        input: expect.objectContaining({
          aspect_ratio: '16:9',
          n: 3,
          place: { file: 'templates/index.json', section: 'hero', setting: 'image' },
        }),
      },
    ])
  })

  it('设计岗出社媒图：方图、不挂网站；工具面里没有生图 / 不是说出图 → 不走这一边', () => {
    const steps = imageBranch(req(IMAGE_TOOL_NAMES as string[], 'design.social'), '出几张社媒图')
    expect(steps?.[0]?.input).toMatchObject({ aspect_ratio: '1:1' })
    expect(steps?.[0]?.input.place).toBeUndefined()
    expect(imageBranch(req(['get_order']), '出几张社媒图')).toBeUndefined()
    expect(imageBranch(req(IMAGE_TOOL_NAMES as string[]), '把首页改成深色')).toBeUndefined()
  })

  it('回话：照工具回的那句说；没走通照实说', () => {
    const data = imageDataOf({
      kind: 'image_pick',
      status: 'awaiting_pick',
      message: '出了 3 张图',
    })
    expect(renderImageAnswer({ ...(data === undefined ? {} : { data }) })).toBe('出了 3 张图')
    expect(renderImageAnswer({ failed: '生图还没配' })).toContain('生图还没配')
  })
})

describe('配图的做法', () => {
  it('紧跟「网页模板的做法」之后；写明出完不用等人挑', () => {
    const sec = imageWorkSection()
    expect(sec.order).toBe(27)
    expect(sec.text).toContain('place')
    expect(sec.text).toContain('不用等人挑')
  })
})
