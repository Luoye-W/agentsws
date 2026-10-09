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
