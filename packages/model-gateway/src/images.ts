/**
 * 22 图片槽的两个实现（WP76，58 §1）。
 *
 * **现在真的没有图片模型**，这一句要说清楚而不是藏起来：
 *
 * - 工作区默认模型是 DeepSeek，DeepSeek **没有**图片生成接口；
 * - 要真出图得走 OpenAI 兼容口（用户自己的 key）或 agentsws 云按积分（49 M2）；
 * - 两条都还没接（58 §5「后置：真图片模型」）。
 *
 * 所以这里给的是两个东西：{@link unavailableImageProvider}（默认，出不了图并
 * **说出为什么**）与 {@link stubImageProvider}（确定性占位图，模拟与 demo 用）。
 * 两个都不是"假装能出图"——前者明说不能，后者出的是一张写着尺寸的色块，
 * 谁也不会把它当成一张设计稿。
 *
 * 真 provider 接上的时候，落点就是这个文件：多一个 `openaiImageProvider`，
 * `ImageProvider` 那个接口一个字不用改。
 */
import { deflateSync } from 'node:zlib'
import type {
  GeneratedImage,
  ImageGenerateRequest,
  ImageGeneration,
  ImageProvider,
  ModelRef,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { GatewayError } from './types.js'

/**
 * 「没有图片模型」那句人话。**全仓唯一一份**——界面上的缺模型卡、职责的
 * `no_image_model` 说明、模拟里那条断言读的是同一个字符串。
 */
export const NO_IMAGE_MODEL_ZH =
  '现在没有接图片模型：默认的 DeepSeek 不出图。这条职责照样能用——它会出 brief、' +
  '尺寸规格和变体计划，只是不出图。要出图的话，去设置页填一个 OpenAI 兼容口的 key，' +
  '或者开 agentsws 云的图片额度（按积分算）。'

export const NO_IMAGE_MODEL_EN =
  'No image model is connected: the default DeepSeek cannot generate images. This duty still ' +
  'works — it produces the brief, the specs and the variant plan, just no pictures. To get ' +
  'images, add an OpenAI-compatible key in settings, or turn on agentsws cloud image credits.'

const DEFAULT_REF: ModelRef = { provider: 'local', model: 'no-image-model' }
const STUB_REF: ModelRef = { provider: 'local', model: 'stub-image' }

/** `"1024x1024"` → `[1024, 1024]`；写不对就按 1024 见方（**不抛**：尺寸是建议不是契约）。 */
export function parseImageSize(size: string | undefined): [number, number] {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec((size ?? '').trim())
  if (m === null) return [1024, 1024]
  return [Number(m[1]), Number(m[2])]
}

/**
 * 装不上图片模型时挂这一条。
 *
 * `generate` 一定抛 `not_implemented`，而 `unavailable_reason` 是给人看的那句话
 * ——调用方（`apps/server` 的设计面）拿它去出「没有图片模型」的卡，
 * 而不是显示一句"生成失败"。
 */
export function unavailableImageProvider(options?: {
  ref?: ModelRef
  reason?: string
}): ImageProvider {
  const reason = options?.reason ?? NO_IMAGE_MODEL_ZH
  return {
    ref: options?.ref ?? DEFAULT_REF,
    available: false,
    unavailable_reason: reason,
    generate: () => Promise.reject(new GatewayError('not_implemented', reason)),
  }
}

export interface StubImageProviderOptions {
  seed: number
  ref?: ModelRef
  /** 一张图算多少 token（记账用，默认 100）。 */
  tokensPerImage?: number
}

/**
 * 26 §模拟替身：确定性占位图。同一 (prompt, size, n, seed) 必然同一批字节。
 *
 * 出的是一张**纯色块 + 一条深色边**的 PNG：颜色由提示词哈希决定，所以不同的
 * 变体一眼看得出是不同的两张，而没有一张会被误当成设计稿。
 */
export function stubImageProvider(options: StubImageProviderOptions): ImageProvider {
  const ref = options.ref ?? STUB_REF
  const tokens = options.tokensPerImage ?? 100
  return {
    ref,
    available: true,
    generate: (req: ImageGenerateRequest): Promise<ImageGeneration> => {
      const [width, height] = parseImageSize(req.size)
      const n = Math.max(1, Math.min(16, req.n ?? 1))
      const prompt_sha256 = sha256(req.prompt)
      const assets: GeneratedImage[] = []
      for (let i = 0; i < n; i += 1) {
        const hash = sha256(`${prompt_sha256}:${options.seed}:${req.seed ?? 0}:${i}`)
        assets.push({
          bytes: placeholderPng(width, height, hash),
          content_type: 'image/png',
          width,
          height,
          prompt_sha256,
        })
      }
      return Promise.resolve({
        assets,
        model: req.model ?? ref,
        usage: {
          input_tokens: Math.ceil(req.prompt.length / 4),
          output_tokens: tokens * n,
          cached_tokens: 0,
          cost_base: 0,
        },
      })
    },
  }
}

/* ── 一个刚好够用的 PNG 编码器 ───────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * 一张 `width × height` 的占位图：颜色由 `hash` 定，四周 4% 一圈深色边。
 *
 * 一眼看得出是占位图而不是设计稿——这正是它该有的样子（04 §6：初稿是给人挑的，
 * 不是给人用的）。整幅纯色压缩后只有几百字节，所以哪怕是 3000×600 的旗舰店
 * 画布也不拖慢模拟。
 */
export function placeholderPng(width: number, height: number, hash: string): Uint8Array {
  const r = Number.parseInt(hash.slice(0, 2), 16)
  const g = Number.parseInt(hash.slice(2, 4), 16)
  const b = Number.parseInt(hash.slice(4, 6), 16)
  const borderX = Math.max(1, Math.round(width * 0.04))
  const borderY = Math.max(1, Math.round(height * 0.04))
  const raw = new Uint8Array((width * 3 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0
    p += 1
    const edgeY = y < borderY || y >= height - borderY
    for (let x = 0; x < width; x += 1) {
      const edge = edgeY || x < borderX || x >= width - borderX
      raw[p] = edge ? r >> 2 : r
      raw[p + 1] = edge ? g >> 2 : g
      raw[p + 2] = edge ? b >> 2 : b
      p += 3
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const idat = new Uint8Array(deflateSync(raw))
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    png.set(part, at)
    at += part.length
  }
  return png
}
