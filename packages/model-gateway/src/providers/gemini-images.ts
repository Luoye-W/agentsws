/**
 * WP274（决策 255）：Google 生图——Nano Banana 2.1（`gemini-nano-banana-2.1`），走用户自己的 Google key。
 *
 * 接口形状照 Google 官方 2026-10 的文档（ai.google.dev/gemini-api/docs/image-generation、
 * ai.google.dev/api/interactions-api，10-08 核对，只读文档、没调用）：
 *
 * - `POST {base}/interactions`，`base` = `https://generativelanguage.googleapis.com/v1beta`；
 *   key 放 `x-goog-api-key` 头（官方 curl 示例的写法）。
 * - 请求体：`{ model, input: [{type:'text',text}, {type:'image',mime_type,data}...],
 *   response_format: { type:'image', aspect_ratio, image_size } }`。
 *   参考图就是 `input` 里的 `image` 项（base64），所以「改图」与「出图」是同一个口——多一组图而已。
 * - 宽高比只认 `1:1 3:2 2:3 3:4 4:3 4:5 5:4 9:16 16:9 21:9`；尺寸 `1K / 2K / 4K`（2.1 都有）。
 * - 参考图：2.1 物体最多 10 张（另有人物 4、风格 3，我们只用物体那一档）。
 * - **一次一张**：文档没有 `n` / `candidate_count`，要几张就发几次。
 * - **没有像素遮罩**：只能用话圈出改哪一块。给了遮罩当场说清楚，不悄悄丢掉。
 * - 回包：`steps[].content[]` 里 `type: 'image'` 的那一项（`data` base64 + `mime_type`）；
 *   SDK 的 `output_image` 与老的 `outputs[]`、`generateContent` 的 `candidates[].content.parts[].inlineData`
 *   也一并认（文档在改版期，形状变了也别直接坏）。
 *
 * 错误一律翻成人话（`image-tools` 原样把 message 端给人）：内容安全拦了、key 不对、型号名不对、限流、
 * 地区不可用、Google 那边出错。key 与字节同 `openai-images.ts` 的纪律：key 只进头、字节只交还宿主。
 */
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGeneration,
  ImageInput,
  ImageProvider,
  ModelRef,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { IMAGE_SAFETY_REFUSAL_ZH, parseImageSize } from '../images.js'
import { describeFetchError } from '../net-cause.js'
import { GatewayError, ProviderError } from '../types.js'
import type { FetchLike } from './openai-compatible.js'
import { IMAGE_TIMEOUT_MS } from './openai-images.js'

/** Google 原生接口的根（OpenAI 兼容层是它下面的 `/openai`）。 */
export const GEMINI_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** Nano Banana 2.1 的官方 API id（官方文档 10-08 核对）。 */
export const NANO_BANANA_MODEL = 'gemini-nano-banana-2.1'

/** 2.1 一次最多几张「物体」参考图（官方文档）。 */
export const GEMINI_MAX_REFERENCE_IMAGES = 10

/** Gemini 认的宽高比（官方文档）。 */
export const GEMINI_ASPECT_RATIOS = [
  '1:1',
  '3:2',
  '2:3',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const

export interface GeminiImageOptions {
  /** 原生根地址（`…/v1beta`）。给的是 OpenAI 兼容层（`…/v1beta/openai`）也认，自动去掉 `/openai`。 */
  baseUrl?: string
  apiKey: () => string | undefined
  model: string
  provider: string
  region?: 'cn' | 'global'
  fetch?: FetchLike
  timeoutMs?: number
}

/** `…/v1beta/openai/` → `…/v1beta`（用户配的文字那一条多半是兼容层地址）。 */
export function geminiNativeBase(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? GEMINI_NATIVE_BASE_URL).trim().replace(/\/+$/, '')
  return raw.replace(/\/openai$/, '')
}

/** `"1536x1024"` → 最接近的 Gemini 宽高比 + 尺寸档（按像素：≤1.2MP 1K、≤4.5MP 2K、再大 4K）。 */
export function geminiCanvas(size: string | undefined): {
  aspect_ratio: (typeof GEMINI_ASPECT_RATIOS)[number]
  image_size: '1K' | '2K' | '4K'
} {
  const [w, h] = parseImageSize(size)
  const r = Math.log(w / h)
  let aspect_ratio: (typeof GEMINI_ASPECT_RATIOS)[number] = '1:1'
  let gap = Number.POSITIVE_INFINITY
  for (const a of GEMINI_ASPECT_RATIOS) {
    const [x, y] = a.split(':').map(Number) as [number, number]
    const d = Math.abs(Math.log(x / y) - r)
    if (d < gap) {
      gap = d
      aspect_ratio = a
    }
  }
  const px = w * h
  const image_size = px <= 1_200_000 ? '1K' : px <= 4_500_000 ? '2K' : '4K'
  return { aspect_ratio, image_size }
}

interface WireMedia {
  type?: string
  data?: string
  mime_type?: string
  mimeType?: string
  text?: string
}
interface WireInteraction {
  status?: string
  steps?: { type?: string; content?: WireMedia[] }[]
  outputs?: WireMedia[]
  output_image?: WireMedia
  candidates?: {
    finishReason?: string
    content?: {
      parts?: { text?: string; inlineData?: WireMedia; inline_data?: WireMedia }[]
    }
  }[]
  promptFeedback?: { blockReason?: string }
  usage?: { total_input_tokens?: number; total_output_tokens?: number }
  errors?: { code?: string; message?: string }[]
  error?: { code?: number | string; message?: string; status?: string }
}

const SAFETY = /safety|prohibited|blocklist|blocked|harm|recitation|spii|csam|policy/i

/** 回包里所有的图与话（几种形状都认）。 */
function mediaOf(json: WireInteraction): { images: WireMedia[]; text: string } {
  const items: WireMedia[] = [
    ...(json.steps ?? [])
      .filter((s) => s.type === undefined || s.type === 'model_output')
      .flatMap((s) => s.content ?? []),
    ...(json.outputs ?? []),
    ...(json.output_image === undefined ? [] : [{ type: 'image', ...json.output_image }]),
    ...(json.candidates ?? []).flatMap((c) =>
      (c.content?.parts ?? []).map((p): WireMedia => {
        const inline = p.inlineData ?? p.inline_data
        return inline !== undefined
          ? { type: 'image', ...inline }
          : { type: 'text', text: p.text ?? '' }
      }),
    ),
  ]
  const images = items.filter(
    (m) =>
      (m.type === 'image' || m.type === undefined) && typeof m.data === 'string' && m.data !== '',
  )
  const text = items
    .filter((m) => m.type === 'text' && typeof m.text === 'string')
    .map((m) => m.text)
    .join(' ')
    .trim()
  return { images, text }
}

/** HTTP 不是 2xx：按 Google 的 `{ error: { code, message, status } }` 翻成人话。 */
function httpError(status: number, detail: string, model: string): Error {
  let message = ''
  let reason = ''
  try {
    const body = JSON.parse(detail) as WireInteraction
    message = body.error?.message ?? body.errors?.[0]?.message ?? ''
    reason = `${body.error?.status ?? ''} ${body.errors?.[0]?.code ?? ''}`
  } catch {
    message = detail
  }
  const all = `${reason} ${message}`
  if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(all))
    return new GatewayError(
      'unauthenticated',
      'Google 不认这把 key（或这把 key 没开通 Gemini API）。去 Google AI Studio 看一眼 key，回设置里重填。',
    )
  if (SAFETY.test(all))
    return new GatewayError('invalid_input', IMAGE_SAFETY_REFUSAL_ZH, { reason: 'content_safety' })
  if (/location is not supported|not available in your (country|region)/i.test(all))
    return new GatewayError(
      'provider_unavailable',
      'Google 生图在这台电脑所在的地区用不了（Google 按地区开放）。换成 Agents 工坊积分出图，或换一个生图接口。',
    )
  if (status === 404 || /NOT_FOUND/.test(reason))
    return new GatewayError(
      'invalid_input',
      `Google 那边没有这个生图型号（${model}）。设置 → 模型 →「生图」里把型号改成 ${NANO_BANANA_MODEL}。`,
    )
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(reason))
    return new GatewayError(
      'rate_limited',
      'Google 那边限流了或额度用完了。过一会儿再试，或去 Google AI Studio 看一眼用量与账单。',
    )
  if (status >= 500)
    return new ProviderError(`Google 那边暂时出错（HTTP ${status}），过一会儿再试。`, { status })
  return new GatewayError(
    'invalid_input',
    `Google 没接这次请求（HTTP ${status}）：${message.slice(0, 160) || '没说原因'}`,
  )
}

function inputOf(img: ImageInput): WireMedia {
  return {
    type: 'image',
    mime_type: img.content_type,
    data: Buffer.from(img.bytes).toString('base64'),
  }
}

export function geminiImageProvider(options: GeminiImageOptions): ImageProvider {
  const base = geminiNativeBase(options.baseUrl)
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const ref: ModelRef = {
    provider: options.provider,
    model: options.model,
    ...(options.region === undefined ? {} : { region: options.region }),
  }

  /** 发一次、出一张。 */
  const once = async (
    prompt: string,
    images: ImageInput[],
    size: string | undefined,
  ): Promise<{ image: GeneratedImage; input: number; output: number }> => {
    const key = options.apiKey()
    if (key === undefined || key === '')
      throw new GatewayError('invalid_input', 'missing api key', { source: 'local_vault' })
    const canvas = geminiCanvas(size)
    const url = `${base}/interactions`
    const body = JSON.stringify({
      model: options.model,
      input: [{ type: 'text', text: prompt }, ...images.map(inputOf)],
      response_format: { type: 'image', ...canvas },
    })
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? IMAGE_TIMEOUT_MS),
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      const timeout = name === 'TimeoutError' || name === 'AbortError'
      throw new ProviderError(
        timeout
          ? 'Google 生图等太久没回（超过两分钟），过一会儿再试。'
          : `连不上 Google（${describeFetchError(e)}）。这台电脑上不了 Google 的话，换成 Agents 工坊积分出图。`,
        { timeout },
      )
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw httpError(res.status, detail, options.model)
    }
    const json = (await res.json()) as WireInteraction
    if (json.status === 'failed') {
      const why = `${json.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`).join(' ') ?? ''}`
      if (SAFETY.test(why))
        throw new GatewayError('invalid_input', IMAGE_SAFETY_REFUSAL_ZH, {
          reason: 'content_safety',
        })
      throw new ProviderError(`Google 这次没出成图：${why.trim().slice(0, 160) || '没说原因'}`, {
        status: 502,
      })
    }
    const blocked =
      json.promptFeedback?.blockReason ??
      json.candidates?.find((c) => SAFETY.test(c.finishReason ?? ''))?.finishReason
    const { images: out, text } = mediaOf(json)
    const first = out[0]
    if (first === undefined) {
      // 只回了一句话、没图：几乎都是内容安全拒了（模型用话解释为什么不画）
      if (blocked !== undefined || text !== '' || json.status === 'incomplete')
        throw new GatewayError(
          'invalid_input',
          text === ''
            ? IMAGE_SAFETY_REFUSAL_ZH
            : `${IMAGE_SAFETY_REFUSAL_ZH}（模型原话：${text.slice(0, 120)}）`,
          { reason: 'content_safety' },
        )
      throw new ProviderError('Google 回了结果，但里面没有图。', { status: 502 })
    }
    const [width, height] = parseImageSize(size)
    return {
      image: {
        bytes: new Uint8Array(Buffer.from(first.data as string, 'base64')),
        content_type: first.mime_type ?? first.mimeType ?? 'image/png',
        width,
        height,
        prompt_sha256: sha256(prompt),
      },
      input: json.usage?.total_input_tokens ?? Math.ceil(prompt.length / 4),
      output: json.usage?.total_output_tokens ?? 0,
    }
  }

  /** 要几张发几次（一次一张）；任何一次失败整批算失败（不出半批、不让人为半批的钱困惑）。 */
  const batch = async (
    req: { prompt: string; size?: string; n?: number; model?: ModelRef },
    images: ImageInput[],
  ): Promise<ImageGeneration> => {
    const n = Math.max(1, Math.min(4, req.n ?? 1))
    const rows = await Promise.all(
      Array.from({ length: n }, () => once(req.prompt, images, req.size)),
    )
    return {
      assets: rows.map((r) => r.image),
      model: req.model ?? ref,
      usage: {
        input_tokens: rows.reduce((s, r) => s + r.input, 0),
        output_tokens: rows.reduce((s, r) => s + r.output, 0),
        cached_tokens: 0,
        cost_base: 0,
      },
    }
  }

  return {
    ref,
    available: true,
    max_reference_images: GEMINI_MAX_REFERENCE_IMAGES,
    // WP283：Nano Banana 没有像素遮罩（调用方别带、界面不给「圈区域」）
    supports_mask: false,
    generate: (req: ImageGenerateRequest) => batch(req, []),
    edit(req: ImageEditRequest): Promise<ImageGeneration> {
      if (req.images.length === 0)
        return Promise.reject(new GatewayError('invalid_input', 'edit needs at least one image'))
      if (req.mask !== undefined)
        return Promise.reject(
          new GatewayError(
            'invalid_input',
            'Nano Banana 不认遮罩图：不给遮罩，用一句话说清楚改哪一块（比如「只换背景，产品不动」）。',
          ),
        )
      return batch(req, req.images.slice(0, GEMINI_MAX_REFERENCE_IMAGES))
    },
  }
}
