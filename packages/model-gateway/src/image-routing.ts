/**
 * WP274（决策 255）：生图跟着用户自己的模型走——几件纯函数的小工具。
 *
 * 1. 认厂商：文字那一条的接口地址是 OpenAI 官方 / Google 官方，就能用同一把 key 生图；
 * 2. 两个型号合成一个 provider：OpenAI 出图用 `flare`（快）、改图用 `sunburst`（精）（决策 246）；
 * 3. 估一张图大概多少美元（走用户自己的 key 时不扣积分，但数据看板要看得见花了多少）。
 *
 * 型号名只在这里与 `providers/gemini-images.ts` 出现；换型号改设置（「生图」那一块可改）。
 */
import type {
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGeneration,
  ImageProvider,
} from '@agentsws/contracts'
import { parseImageSize } from './images.js'
import { NANO_BANANA_MODEL } from './providers/gemini-images.js'

/** GPT Image 2.5 出图档（快，官方：「fast, high-quality everyday image generation」）。 */
export const GPT_IMAGE_GENERATE_MODEL = 'gpt-image-2.5-flare'
/** GPT Image 2.5 改图档（精，官方：「editing precision matters most」）。 */
export const GPT_IMAGE_EDIT_MODEL = 'gpt-image-2.5-sunburst'

/**
 * 走 Agents 工坊云时的默认出图 / 改图型号：所有工作区同一套（决策 246；决策 291 起不再按驻留分，
 * 262「不出境默认 Seedream」作废）。与云端的默认保持一致（私有云 WP280 一处常量）。
 */
export function cloudImageModels(): { generate: string; edit: string } {
  return { generate: GPT_IMAGE_GENERATE_MODEL, edit: GPT_IMAGE_EDIT_MODEL }
}

/**
 * WP283（决策 300 / 301）：**生图型号能力表**——哪个型号认不认遮罩（「圈区域」）只在这一处判，
 * 别处不写死型号名。
 *
 * `mask.direct` = 直连厂商（自己的 key、自定义 OpenAI 兼容口）；`mask.cloud` = 经 Agents 工坊云。
 * 云那一列与私有云 `image-models.ts` 白名单对齐（WP280，10-09）：经 OpenRouter 的（GPT Image 2.5 / 2 / 1 /
 * 1-mini、Nano Banana 2.1）一律不认——OpenRouter 两个出图口都没有遮罩，云端去掉遮罩按提示词整张改；
 * Seedream 本身没有遮罩（火山接口、New API 豆包插件带遮罩会报错，云端同样去掉）。
 */
export interface ImageModelCaps {
  /** 给人看的名字。 */
  label: string
  mask: { direct: boolean; cloud: boolean }
}

const openaiCaps = (label: string): ImageModelCaps => ({
  label,
  mask: { direct: true, cloud: false },
})
const noMask = (label: string): ImageModelCaps => ({
  label,
  mask: { direct: false, cloud: false },
})

export const IMAGE_MODEL_CAPS: Readonly<Record<string, ImageModelCaps>> = {
  [GPT_IMAGE_GENERATE_MODEL]: openaiCaps('GPT Image 2.5'),
  [GPT_IMAGE_EDIT_MODEL]: openaiCaps('GPT Image 2.5'),
  'gpt-image-2': openaiCaps('GPT Image 2'),
  'gpt-image-1': openaiCaps('GPT Image 1'),
  'gpt-image-1-mini': openaiCaps('GPT Image 1 mini'),
  [NANO_BANANA_MODEL]: noMask('Nano Banana 2.1'),
  'doubao-seedream-5-0-pro-260628': noMask('Seedream 5.0 Pro'),
  'doubao-seedream-5-0-lite-260128': noMask('Seedream 5.0 Lite'),
}

/**
 * 退役的生图型号 → 顶替它的那个（决策 301：`gpt-image-1.5` OpenRouter 上没有，指到 `gpt-image-2`，
 * 同一档价、同一套画布）。本机设置里存着的老名字**读的时候**换掉，界面型号列表里不再出现它。
 */
export const RETIRED_IMAGE_MODELS: Readonly<Record<string, string>> = {
  'gpt-image-1.5': 'gpt-image-2',
}

/** 去掉日期快照后缀（`gpt-image-1.5-2025-12-16` → `gpt-image-1.5`），小写。 */
function baseImageModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

/** 这个型号退役了没有（含它的日期快照）。 */
export function isRetiredImageModel(model: string): boolean {
  return RETIRED_IMAGE_MODELS[baseImageModel(model)] !== undefined
}

/** 退役的换成顶替它的那个；别的原样（不改大小写，型号名区分大小写的上游照样认）。 */
export function normalizeImageModel(model: string): string {
  return RETIRED_IMAGE_MODELS[baseImageModel(model)] ?? model
}

/**
 * 这个型号改图认不认遮罩。表里没有的：OpenAI 那一族（`gpt-image-*` / `dall-e-2`）直连认、经云不认；
 * 别的一律当不认——说不准就不给「圈区域」，免得人圈了却被整张改。
 */
export function imageMaskSupported(model: string, via: 'direct' | 'cloud'): boolean {
  const name = baseImageModel(normalizeImageModel(model))
  const caps = IMAGE_MODEL_CAPS[name]
  if (caps !== undefined) return caps.mask[via]
  return via === 'direct' && /^(gpt-image-|dall-e-2$)/.test(name)
}

/** 能用同一把 key 生图的厂商。 */
export type ImageVendor = 'openai' | 'google'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 这条接口地址是哪家官方的（只认官方主机；代理 / 中转一律不认——它们未必有生图口）。 */
export function imageVendorOf(baseUrl: string): ImageVendor | undefined {
  const host = hostOf(baseUrl)
  if (host === 'api.openai.com') return 'openai'
  if (host === 'generativelanguage.googleapis.com') return 'google'
  return undefined
}

/** 这家默认的出图 / 改图型号。 */
export function defaultImageModels(vendor: ImageVendor): { generate: string; edit: string } {
  return vendor === 'openai'
    ? { generate: GPT_IMAGE_GENERATE_MODEL, edit: GPT_IMAGE_EDIT_MODEL }
    : { generate: NANO_BANANA_MODEL, edit: NANO_BANANA_MODEL }
}

/**
 * 出图走一个 provider、改图走另一个（同一家、同一把 key、不同型号）。
 * `ref` 用出图那一个的；改图回包里的 `model` 是改图那个型号，素材库里记的是真用的那个。
 */
export function splitImageProvider(parts: {
  generate: ImageProvider
  edit: ImageProvider
}): ImageProvider {
  const { generate, edit } = parts
  return {
    ref: generate.ref,
    available: generate.available && edit.available,
    ...(generate.unavailable_reason === undefined
      ? {}
      : { unavailable_reason: generate.unavailable_reason }),
    ...(edit.max_reference_images === undefined
      ? {}
      : { max_reference_images: edit.max_reference_images }),
    // WP283：认不认遮罩看改图那一个
    ...(edit.supports_mask === undefined ? {} : { supports_mask: edit.supports_mask }),
    generate: (req: ImageGenerateRequest): Promise<ImageGeneration> => generate.generate(req),
    ...(edit.edit === undefined
      ? {}
      : {
          edit: (req: ImageEditRequest): Promise<ImageGeneration> =>
            (edit.edit as NonNullable<ImageProvider['edit']>)({ ...req, model: edit.ref }),
        }),
  }
}

/**
 * 估一张图多少美元（**估算**，只给数据看板看个量级；真账单以厂商后台为准）。
 *
 * - Nano Banana 2.1：官方价目按张——1K $0.0336、2K $0.0504、4K $0.113（ai.google.dev/gemini-api/docs/pricing，10-08）；
 *   参考图按输入 token 另计，量级很小（$1.5 / 百万），按每张 $0.001 估。
 * - GPT Image 2.5：官方按输出 token 计（$30 / 百万），1024² medium 约 $0.013（第三方实测 token 数，WP268 §1），
 *   按像素线性放大；改图另计输入图 token（高保真，大图贵），按每张参考图 $0.01 估。
 * - 别的型号：不知道就回 `undefined`——不编一个数。
 */
export function estimateImageUsd(input: {
  model: string
  size?: string
  operation: 'generate' | 'edit'
  references?: number
}): number | undefined {
  const name = input.model.trim().toLowerCase()
  const refs = input.operation === 'edit' ? Math.max(1, input.references ?? 1) : 0
  const [w, h] = parseImageSize(input.size)
  const px = w * h
  let usd: number | undefined
  if (name.startsWith('gemini-nano-banana-2.1')) {
    usd = (px <= 1_200_000 ? 0.0336 : px <= 4_500_000 ? 0.0504 : 0.113) + refs * 0.001
  } else if (/^gpt-image-2(\.5)?/.test(name)) {
    usd = 0.013 * (px / (1024 * 1024)) + refs * 0.01
  }
  return usd === undefined ? undefined : Math.round(usd * 10_000) / 10_000
}
