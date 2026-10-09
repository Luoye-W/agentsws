/**
 * 生图那一档的真实现（WP127 交付 3：生图单独一档）。
 *
 * OpenAI 形态的 `POST {base}/images/generations`——OpenAI 本身、Agents 工坊官方接口
 * （`/v1/ai/images/generations`，按积分）、以及各家兼容网关都是这个形状。
 * 这正是 `images.ts` 文件头预告的那个落点：`ImageProvider` 接口一个字没改。
 *
 * 两条纪律与文字那一路相同：
 * 1. key 只在 `apiKey()` 回调里出现一次，直接进 `Authorization` 头；
 * 2. 图片字节永不进事件日志——这里只把字节 / 限时 URL 交还给宿主，落哪儿是宿主的事。
 *
 * 不带 `response_format`：新一代图片模型（`gpt-image-*`）不认这个参数、一律回 base64，
 * 老的回 URL——两种回法这里都收。
 */
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGeneration,
  ImageProvider,
  ModelMeta,
  ModelRef,
} from '@agentsws/contracts'
import { IMAGE_EDIT_MAX_REFERENCES } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { IMAGE_SAFETY_REFUSAL_ZH, imageFidelitySupported, parseImageSize } from '../images.js'
import { describeFetchError } from '../net-cause.js'
import { GatewayError, ProviderError } from '../types.js'
import type { FetchLike } from './openai-compatible.js'

export interface OpenAiImageOptions {
  baseUrl: string
  /** 凭据取值回调，每次请求现取（同文字那一路）。 */
  apiKey: () => string | undefined
  model: string
  provider: string
  region?: 'cn' | 'global'
  fetch?: FetchLike
  timeoutMs?: number
  extraHeaders?: Record<string, string>
  /**
   * WP283（决策 310）：每次请求现算的请求头——Agents 工坊官方接口那一条用它带
   * `X-Agentsws-Member` / `X-Agentsws-Position`（同文字那一路的 `requestHeaders`）；别家不给。
   */
  requestHeaders?: (meta: ModelMeta | undefined) => Record<string, string>
}

interface WireImageResponse {
  data?: { b64_json?: string; url?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** 默认等两分钟：出一张图比回一句话慢得多。 */
export const IMAGE_TIMEOUT_MS = 120_000

export function openaiImageProvider(options: OpenAiImageOptions): ImageProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const ref: ModelRef = {
    provider: options.provider,
    model: options.model,
    ...(options.region === undefined ? {} : { region: options.region }),
  }
  const keyOrThrow = (): string => {
    const key = options.apiKey()
    if (key === undefined || key === '') {
      throw new GatewayError('invalid_input', 'missing api key', { source: 'local_vault' })
    }
    return key
  }

  /** 发一次、收回包：两条口（generations / edits）只差 URL 与 body 的形状。 */
  const send = async (
    path: 'generations' | 'edits',
    body: string | FormData,
    req: { prompt: string; size?: string; model?: ModelRef; meta?: ModelMeta },
  ): Promise<ImageGeneration> => {
    const key = keyOrThrow()
    const [width, height] = parseImageSize(req.size)
    const url = `${baseUrl}/images/${path}`
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          // multipart 的 content-type（带 boundary）交给 fetch 自己填
          ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${key}`,
          ...options.extraHeaders,
          // WP283：官方接口那一条带上「谁 / 哪个岗位」
          ...options.requestHeaders?.(req.meta),
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? IMAGE_TIMEOUT_MS),
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      throw new ProviderError(`request to ${url} failed: ${describeFetchError(e)}`, {
        timeout: name === 'TimeoutError' || name === 'AbortError',
      })
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // WP274：内容安全拦了（OpenAI `moderation_blocked` / 老的 `content_policy_violation`）说人话
      if (/moderation_blocked|content_policy_violation|safety system/i.test(detail))
        throw new GatewayError('invalid_input', IMAGE_SAFETY_REFUSAL_ZH, {
          reason: 'content_safety',
        })
      throw new ProviderError(`provider http ${res.status}: ${detail.slice(0, 200)}`, {
        status: res.status,
      })
    }
    const json = (await res.json()) as WireImageResponse
    const prompt_sha256 = sha256(req.prompt)
    const assets: GeneratedImage[] = []
    for (const row of json.data ?? []) {
      const base = { content_type: 'image/png', width, height, prompt_sha256 }
      if (typeof row.b64_json === 'string' && row.b64_json !== '') {
        assets.push({ ...base, bytes: new Uint8Array(Buffer.from(row.b64_json, 'base64')) })
      } else if (typeof row.url === 'string' && row.url !== '') {
        assets.push({ ...base, url: row.url })
      }
    }
    if (assets.length === 0) {
      throw new ProviderError('provider returned no image', { status: 502 })
    }
    return {
      assets,
      model: req.model ?? ref,
      usage: {
        input_tokens: json.usage?.input_tokens ?? Math.ceil(req.prompt.length / 4),
        output_tokens: json.usage?.output_tokens ?? 0,
        cached_tokens: 0,
        cost_base: 0,
      },
    }
  }

  return {
    ref,
    available: true,
    max_reference_images: IMAGE_EDIT_MAX_REFERENCES,
    generate(req: ImageGenerateRequest): Promise<ImageGeneration> {
      const [width, height] = parseImageSize(req.size)
      const n = Math.max(1, Math.min(4, req.n ?? 1))
      return send(
        'generations',
        JSON.stringify({ model: options.model, prompt: req.prompt, n, size: `${width}x${height}` }),
        req,
      )
    },
    /**
     * WP268：参考图改图，OpenAI 形态 `POST {base}/images/edits`（multipart）。
     *
     * 参考图走重复的 `image[]` 字段（`gpt-image-*` 认多张；只认一张的上游只看第一张）；遮罩可选；
     * `input_fidelity` 只在要「保持产品」且型号认它时带（`imageFidelitySupported`）。
     */
    edit(req: ImageEditRequest): Promise<ImageGeneration> {
      if (req.images.length === 0)
        return Promise.reject(new GatewayError('invalid_input', 'edit needs at least one image'))
      const [width, height] = parseImageSize(req.size)
      const n = Math.max(1, Math.min(4, req.n ?? 1))
      const form = new FormData()
      form.append('model', options.model)
      form.append('prompt', req.prompt)
      form.append('n', String(n))
      form.append('size', `${width}x${height}`)
      // 只有认这个参数的型号才带（gpt-image-2 传了会被上游拒）
      if (req.fidelity !== undefined && imageFidelitySupported(options.model))
        form.append('input_fidelity', req.fidelity)
      req.images.slice(0, IMAGE_EDIT_MAX_REFERENCES).forEach((img, i) => {
        form.append(
          'image[]',
          new Blob([new Uint8Array(img.bytes)], { type: img.content_type }),
          img.filename ?? `ref-${i + 1}.${extOf(img.content_type)}`,
        )
      })
      if (req.mask !== undefined)
        form.append(
          'mask',
          new Blob([new Uint8Array(req.mask.bytes)], { type: req.mask.content_type }),
          req.mask.filename ?? 'mask.png',
        )
      return send('edits', form, req)
    },
  }
}

function extOf(content_type: string): string {
  if (content_type === 'image/jpeg') return 'jpg'
  if (content_type === 'image/webp') return 'webp'
  return 'png'
}
