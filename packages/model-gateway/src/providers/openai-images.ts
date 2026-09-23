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
  ImageGenerateRequest,
  ImageGeneration,
  ImageProvider,
  ModelRef,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { parseImageSize } from '../images.js'
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
  return {
    ref,
    available: true,
    async generate(req: ImageGenerateRequest): Promise<ImageGeneration> {
      const key = options.apiKey()
      if (key === undefined || key === '') {
        throw new GatewayError('invalid_input', 'missing api key', { source: 'local_vault' })
      }
      const [width, height] = parseImageSize(req.size)
      const n = Math.max(1, Math.min(4, req.n ?? 1))
      const url = `${baseUrl}/images/generations`
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
            ...options.extraHeaders,
          },
          body: JSON.stringify({
            model: options.model,
            prompt: req.prompt,
            n,
            size: `${width}x${height}`,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? IMAGE_TIMEOUT_MS),
        })
      } catch (e) {
        const name = e instanceof Error ? e.name : ''
        throw new ProviderError(
          `request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
          { timeout: name === 'TimeoutError' || name === 'AbortError' },
        )
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
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
    },
  }
}
