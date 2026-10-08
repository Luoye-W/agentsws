/**
 * WP268（决策 213）：生图接入建站 / 设计——工具、挑图卡、超额卡与上限的**契约那一半**。
 *
 * 实现散在四处：网关（`@agentsws/model-gateway` 的 `images.ts` / `providers/openai-images.ts`，生成 + 改图）、
 * 工具定义（`@agentsws/stand-ins` 的 `runtime/image.ts`）、服务端执行器（`apps/server/src/image-tools.ts`，
 * 出图 → 素材库 → 挑图卡）、挑中之后（`image-pick.ts`：传店铺文件 → 写模板 → 推未发布预览）。
 *
 * 换模型只改设置（设置 → 模型 →「生图」那一块）：这里没有一个型号名。
 */
import type { Iso8601 } from './common.js'

/** 工具收的宽高比（建站横幅常用 16:9 / 3:1，社媒 1:1 / 4:5 / 9:16）。 */
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
  '4:3',
  '3:2',
  '16:9',
  '21:9',
  '3:1',
] as const
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]

/**
 * 生图的上限（**花积分前**就判）。超了不出图，出一张 `image_budget` 卡问人。
 *
 * - `per_call`：一次工具调用最多几张（派工单：张数 ≤ 4）；
 * - `per_run_images` / `per_run_credits`：一次运行累计（「再来一版」也算进那一次运行）；
 * - 每天的总数沿用设计岗的 `DESIGN_CAPS.max_generations_per_day`（面板上「今天还能出几张」是同一个数）。
 */
export const IMAGE_CAPS = {
  per_call: 4,
  per_run_images: 8,
  /** 8 张 × 0.5 积分（`ai.image` 现价）= 4；改图单价更高时先到这一条。 */
  per_run_credits: 4,
} as const

/**
 * 挑中之后挂到主题哪一格（只给网页模板用）。
 *
 * - `file`：`templates/*.json` / `sections/*.json`（分区组）/ `config/settings_data.json`；
 * - `section`：模板 JSON 里 `sections` 下的那个键（`config/settings_data.json` 不用给）；
 * - `block`：分区里的块（可选）；
 * - `setting`：`image_picker` 类型的那个设置名（如 `image`）。
 *
 * 写进去的值是 `shopify://shop_images/<文件名>`（Shopify 主题 JSON 引用店铺「文件」里图片的写法）。
 */
export interface ImagePlaceTarget {
  file: string
  section?: string
  block?: string
  setting: string
}

/** 挑图卡上的一张图。 */
export interface ImagePickVariant {
  /** 选项 id（`asset:<素材 id>`）。 */
  id: string
  asset_id: string
  /** 工作台取图的地址（本机路由，要带登录令牌）。 */
  url: string
  label: string
  width?: number
  height?: number
}

/** 「再来一版」那一项的选项 id。 */
export const IMAGE_PICK_AGAIN = 'again'
/** 每张图的选项 id 前缀。 */
export const IMAGE_PICK_PREFIX = 'asset:'

/** 生图 / 改图那一次的参数（「再来一版」与超额卡批了之后照这一份再出）。 */
export interface ImageJob {
  operation: 'generate' | 'edit'
  prompt: string
  /** `"1536x1024"`（已按模型换算好的画布）。 */
  size: string
  aspect_ratio?: ImageAspectRatio
  spec_id?: string
  n: number
  /** 改图的参考图（素材库 id；店里商品图 / 拖进来的图都先进素材库再引用）。 */
  reference_asset_ids?: string[]
  /** 遮罩（素材库 id）。 */
  mask_asset_id?: string
  style_note?: string
  /** 用途标（素材库按它分组：`hero` / `banner` / `story` / `social` / `ad`）。 */
  tags?: string[]
  place?: ImagePlaceTarget
}

/** `image_pick` 卡的 payload。 */
export interface ImagePickPayload {
  form: 'image_pick'
  variants: ImagePickVariant[]
  /** 这一批的参数（「再来一版」照它）。 */
  job: ImageJob
  /** 给人看的模型名（`gpt-image-1` 之类）。 */
  model_label: string
  /** 这一批花了多少积分（官方接口；自己的接口 = 0 且 `own_key: true`）。 */
  credits: number
  own_key?: boolean
  /** 「再来一版」大约再花多少（卡上写在那颗按钮旁）。 */
  again_credits: number
  /** 选中之后会不会传到店铺并挂主题（网页模板给了 `place` 才是 true）。 */
  upload: boolean
  run_id: string
  matter_id?: string
  /** 规范自检那一行（71 §5，同设计岗挑图卡）。 */
  design_note?: string
}

/** `image_budget` 卡的 payload。 */
export interface ImageBudgetPayload {
  form: 'image_budget'
  job: ImageJob
  model_label: string
  /** 这一次要花多少（预估）。 */
  credits: number
  own_key?: boolean
  /** 为什么问：超了哪一条。 */
  reason: 'per_run_images' | 'per_run_credits' | 'per_day'
  /** 这次运行到现在已经出了几张 / 花了多少。 */
  used: { images: number; credits: number }
  run_id: string
  matter_id?: string
  /** 出卡时那条职责（批了之后照它出图、记素材）。 */
  role_id: string
  assignment_id: string
  at: Iso8601
}

/** 一次出图要花多少积分（官方接口按张；自己的接口 = 0）。保留两位小数。 */
export function imageCredits(n: number, perImage: number | undefined): number {
  if (perImage === undefined || !Number.isFinite(perImage) || perImage <= 0) return 0
  return Math.round(n * perImage * 100) / 100
}

/** `shopify://shop_images/<文件名>`（主题 JSON 里引用店铺「文件」图片的写法）。 */
export function shopImageRef(filename: string): string {
  return `shopify://shop_images/${filename}`
}
