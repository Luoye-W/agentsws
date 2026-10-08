/**
 * WP268（决策 213）：**生图 / 改图工具**——给设计岗五条职责与建站「网页模板」。
 *
 * | 工具 | 干什么 | 花积分吗 |
 * |---|---|---|
 * | `list_brand_assets` | 看品牌素材库（产品图、拖进来的图、以前出过的图），拿 id 当参考图 | 不花 |
 * | `generate_image` | 照提示词从零出 1–4 张（横幅、品牌故事图、海报、社媒图、广告图） | 官方接口按张扣 |
 * | `edit_image` | 拿参考图（素材库里的 / 店里某件商品的图）改：产品不变，换背景 / 场景 | 官方接口按张扣 |
 *
 * 出来的图**一律进品牌素材库**，并在事项里出一张挑图卡（多张并排：选一张 / 都不要 / 再来一版）；
 * 花积分前先按价目算好：在单次上限（`IMAGE_CAPS`）以内直接出，超了不出、出一张卡问人。
 * 网页模板给了 `place`（挂到模板哪一格）时，人挑中 = 同意传到店铺「文件」、写进模板那一格、推一份新的未发布预览。
 *
 * 名字、给模型看的描述、stub 剧本在这里；执行在服务端 `apps/server/src/image-tools.ts`。
 */
import type { PromptSection, RunRequest, ToolDef } from '@agentsws/contracts'
import { IMAGE_ASPECT_RATIOS, IMAGE_CAPS } from '@agentsws/contracts'

export const LIST_BRAND_ASSETS_TOOL = 'list_brand_assets'
export const GENERATE_IMAGE_TOOL = 'generate_image'
export const EDIT_IMAGE_TOOL = 'edit_image'

/** 三个名字（排好序：`tools.allow` 要字节稳定）。 */
export const IMAGE_TOOL_NAMES: readonly string[] = [
  EDIT_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  LIST_BRAND_ASSETS_TOOL,
].sort()

/**
 * 有生图工具的职责：设计岗五条（海报 / 社媒图 / 广告图 / 独立站视觉 / Amazon 图 / 展会物料）+ 网页模板
 * （`site.builder` 是它的旧名）。
 */
export const IMAGE_ROLE_IDS: readonly string[] = [
  'design.ads',
  'design.amazon',
  'design.dtc',
  'design.exhibition',
  'design.social',
  'site.builder',
  'site.shopify-theme',
]

export const isImageRole = (role_id: string): boolean => IMAGE_ROLE_IDS.includes(role_id)

const COMMON_PROPS = {
  aspect_ratio: {
    type: 'string',
    enum: [...IMAGE_ASPECT_RATIOS],
    description: '宽高比：首页横幅 16:9 或 3:1、社媒方图 1:1、竖图 4:5 / 9:16；不给 = 1:1',
  },
  spec_id: {
    type: 'string',
    description:
      '可选：按设计规格出（如 web.hero.desktop、social.ig.post），给了就不用 aspect_ratio',
  },
  n: {
    type: 'integer',
    minimum: 1,
    maximum: IMAGE_CAPS.per_call,
    description: `出几张给人挑（1–${IMAGE_CAPS.per_call}，默认 2）`,
  },
  style_note: {
    type: 'string',
    description: '风格备注（色调、光线、留白、品牌感），会接在提示词后面',
  },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: '用途标，素材库按它分组：hero / banner / story / social / ad / product',
  },
  place: {
    type: 'object',
    description:
      '只给网页模板：人挑中后挂到主题哪一格。file 如 templates/index.json；section 是模板 JSON 里 sections 下的键；' +
      'block 可选；setting 是图片设置名（如 image）。给了它，人挑中就会自动传到店铺「文件」、写进这一格、推一份新的未发布预览——你不用再改这一格。',
    properties: {
      file: { type: 'string' },
      section: { type: 'string' },
      block: { type: 'string' },
      setting: { type: 'string' },
    },
    required: ['file', 'setting'],
  },
} as const

/** 给模型看的定义（描述写人话：它挑工具的那一刻读描述）。 */
export const IMAGE_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: LIST_BRAND_ASSETS_TOOL,
    description:
      '看品牌素材库：以前出过 / 选中过的图、人拖进来的图、从店里商品拿来的图。回每张的 id、用途标、来源、尺寸、状态。' +
      '要拿某张当参考图改图时，把它的 id 填进 edit_image 的 asset_ids。不花积分。',
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: '只看这个用途标' },
        this_matter: { type: 'boolean', description: '只看这件事里拖进来 / 出过的图' },
        limit: { type: 'integer', description: '最多几张（默认 20）' },
      },
    },
  },
  {
    name: GENERATE_IMAGE_TOOL,
    description:
      '从零出图（首页横幅、品牌故事图、海报、社媒图、广告图）。出来的图进品牌素材库，事项里出一张挑图卡等人挑——' +
      '人没挑之前别把它当定稿。官方接口按张扣积分，单次运行有上限，超了会出卡问人。' +
      '提示词写清主体、场景、光线、构图；图上要出现的字用引号写原文（越短越好）。要保持真实产品的样子用 edit_image。',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述' },
        ...COMMON_PROPS,
      },
      required: ['prompt'],
    },
  },
  {
    name: EDIT_IMAGE_TOOL,
    description:
      '拿参考图改图：产品保持原样，换背景 / 场景 / 光线，做场景图与横幅。参考图二选一或都给：asset_ids（素材库里的图，' +
      '先用 list_brand_assets 查）、product_id（店里某件商品，自动取它的商品图进素材库）。第一张是主参考。' +
      '出来的图进素材库，事项里出挑图卡等人挑。官方接口按张扣积分，单次运行有上限，超了会出卡问人。',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要改成什么样（产品别动，写清新背景 / 场景）' },
        asset_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '素材库里的参考图 id（最多 4 张，第一张是主参考）',
        },
        product_id: { type: 'string', description: '店里某件商品的 id（gid://shopify/Product/…）' },
        mask_asset_id: {
          type: 'string',
          description: '可选：遮罩图的素材 id（PNG，透明处是要改的地方）',
        },
        ...COMMON_PROPS,
      },
      required: ['prompt'],
    },
  },
]

export const IMAGE_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  IMAGE_TOOL_DEFS.map((d) => [d.name, d]),
)

/**
 * 网页模板摆了生图工具时，「网页模板的做法」后面多这一段（order 27，紧跟那一节）。
 * 没摆的运行一个字节不多。
 */
export const IMAGE_WORK_ORDER = 27

export function imageWorkSection(): PromptSection {
  return {
    id: 'image_work',
    name: '配图的做法',
    order: IMAGE_WORK_ORDER,
    text: [
      '配图的做法：',
      '1. 首页横幅、品牌故事图、主推图是占位时，用 generate_image / edit_image 出图，并给 place 指到模板里那一格（先读模板确认 section 键和图片设置名）。',
      '2. 有真实产品图就用 edit_image（产品不变、换场景）；没有再用 generate_image。先 list_brand_assets 看素材库里有没有能用的。',
      '3. 出完不用等人挑：接着把别的改完、推预览；人挑中后系统会自动传图、写进那一格、再推一份新预览。',
      '4. 一次出 2–3 张就够；别反复重出，人会点「再来一版」。',
    ].join('\n'),
  }
}

// ── 回来的数据形状（服务端 `image-tools.ts` 拼，stub 剧本读） ─────────────

export interface ImageToolData {
  kind: 'image_pick' | 'image_budget'
  status: 'awaiting_pick' | 'needs_approval'
  message: string
  approval_item_id?: string
  asset_ids?: string[]
  credits?: number
}

const obj = (data: unknown): Record<string, unknown> =>
  data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}

export function imageDataOf(data: unknown): ImageToolData | undefined {
  const o = obj(data)
  return (o.kind === 'image_pick' || o.kind === 'image_budget') && typeof o.message === 'string'
    ? (o as unknown as ImageToolData)
    : undefined
}

// ── stub 剧本（没接模型时演示：说「出几张横幅图」就出一批、出挑图卡） ─────────

const ASK =
  /生图|出图|配图|横幅图|主视觉|海报|社媒图|广告图|场景图|banner image|hero image|poster|generate (an? )?image/i
const HERO = /首页|横幅|主视觉|hero|banner/i
const SQUARE = /社媒|方图|instagram|ig\b|post/i

export interface ImageStep {
  tool: string
  input: Record<string, unknown>
}

/** stub 的岔口：工具面里有生图、而且说的是出图，才走这一边；否则照旧。 */
export function imageBranch(req: RunRequest, text: string): ImageStep[] | undefined {
  if (!req.tools.allow.includes(GENERATE_IMAGE_TOOL) || !ASK.test(text)) return undefined
  const hero = HERO.test(text)
  const theme = req.actor.role_id === 'site.shopify-theme' || req.actor.role_id === 'site.builder'
  return [
    {
      tool: GENERATE_IMAGE_TOOL,
      input: {
        prompt: text.slice(0, 400),
        aspect_ratio: hero ? '16:9' : SQUARE.test(text) ? '1:1' : '4:5',
        n: 3,
        tags: [hero ? 'hero' : 'social'],
        ...(hero && theme
          ? { place: { file: 'templates/index.json', section: 'hero', setting: 'image' } }
          : {}),
      },
    },
  ]
}

/** stub 给出图那一段回话。没走通照实说。 */
export function renderImageAnswer(input: { data?: ImageToolData; failed?: string }): string {
  if (input.data !== undefined) return input.data.message
  return `没出成图：${input.failed ?? '这一步没走通'}`
}
