/**
 * WP274（决策 255）：Google 生图 provider（Nano Banana 2.1）+ 认厂商 / 两个型号合一 / 估美元 + OpenAI 内容安全人话。
 * 全部替身（假的 Google 接口），不联网、不花钱。
 */
import { describe, expect, it } from 'vitest'
import {
  estimateImageUsd,
  GatewayError,
  GPT_IMAGE_EDIT_MODEL,
  GPT_IMAGE_GENERATE_MODEL,
  geminiCanvas,
  geminiImageProvider,
  geminiNativeBase,
  IMAGE_SAFETY_REFUSAL_ZH,
  imageVendorOf,
  NANO_BANANA_MODEL,
  openaiImageProvider,
  ProviderError,
  splitImageProvider,
  stubImageProvider,
} from '../src/index.js'

const meta = { workspace_id: 'ws_1', run_id: 'run_1', purpose: 'run' } as never
const png = (n: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')

interface Seen {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 假的 Google `interactions` 口：按 `reply` 回包。 */
function fakeGoogle(reply: (call: number) => { status?: number; json?: unknown; text?: string }): {
  seen: Seen[]
  fetch: Parameters<typeof geminiImageProvider>[0]['fetch']
} {
  const seen: Seen[] = []
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({
        url,
        headers: init.headers,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      })
      const r = reply(seen.length)
      const status = r.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => r.json,
        text: async () => r.text ?? JSON.stringify(r.json ?? {}),
      }
    },
  }
}

const imageReply = (bytes: number[]) => ({
  json: {
    id: 'v1_x',
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [{ type: 'image', data: b64(bytes), mime_type: 'image/jpeg' }],
      },
    ],
    usage: { total_input_tokens: 12, total_output_tokens: 1290 },
  },
})

const provider = (fetch: Parameters<typeof geminiImageProvider>[0]['fetch']) =>
  geminiImageProvider({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: () => 'g-test-key',
    model: NANO_BANANA_MODEL,
    provider: 'google',
    region: 'global',
    ...(fetch === undefined ? {} : { fetch }),
  })

describe('geminiImageProvider（Nano Banana 2.1，interactions 口）', () => {
  it('出图：打原生 interactions 口（兼容层地址去掉 /openai）、key 只进 x-goog-api-key、宽高比与尺寸档照官方枚举', async () => {
    const g = fakeGoogle(() => imageReply([1, 2, 3]))
    const out = await provider(g.fetch).generate({
      prompt: 'hero banner, product on marble',
      size: '1536x864',
      n: 2,
      meta,
    })
    expect(g.seen).toHaveLength(2) // 一次一张：要两张发两次
    const first = g.seen[0] as Seen
    expect(first.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(first.headers['x-goog-api-key']).toBe('g-test-key')
    expect(first.headers.authorization).toBeUndefined()
    expect(first.body).toEqual({
      model: NANO_BANANA_MODEL,
      input: [{ type: 'text', text: 'hero banner, product on marble' }],
      response_format: { type: 'image', aspect_ratio: '16:9', image_size: '2K' },
    })
    expect(JSON.stringify(first.body)).not.toContain('g-test-key')
    expect(out.assets).toHaveLength(2)
    expect(out.assets[0]?.content_type).toBe('image/jpeg')
    expect([...(out.assets[0]?.bytes ?? [])]).toEqual([1, 2, 3])
    expect(out.model).toEqual({ provider: 'google', model: NANO_BANANA_MODEL, region: 'global' })
    expect(out.usage.output_tokens).toBe(2580)
  })

  it('改图：多张参考图作 input 里的 image 项（base64 + mime_type），上限 10 张', async () => {
    const g = fakeGoogle(() => imageReply([7]))
    const p = provider(g.fetch)
    expect(p.max_reference_images).toBe(10)
    const images = Array.from({ length: 12 }, (_, i) => ({
      bytes: png(i),
      content_type: i % 2 === 0 ? 'image/png' : 'image/jpeg',
    }))
    const out = await p.edit?.({ prompt: '只换背景，产品不动', images, size: '1024x1024', meta })
    expect(out?.assets).toHaveLength(1)
    const input = (g.seen[0] as Seen).body.input as {
      type: string
      mime_type?: string
      data?: string
    }[]
    expect(input[0]).toEqual({ type: 'text', text: '只换背景，产品不动' })
    expect(input.slice(1)).toHaveLength(10)
    expect(input[1]).toEqual({
      type: 'image',
      mime_type: 'image/png',
      data: Buffer.from(png(0)).toString('base64'),
    })
    expect(input[2]?.mime_type).toBe('image/jpeg')
    expect((g.seen[0] as Seen).body.response_format).toEqual({
      type: 'image',
      aspect_ratio: '1:1',
      image_size: '1K',
    })
  })

  it('改图：给了遮罩当场说清楚（不悄悄丢）、一张参考图都没有是错；一次请求都不发', async () => {
    const g = fakeGoogle(() => imageReply([1]))
    const p = provider(g.fetch)
    await expect(
      p.edit?.({
        prompt: 'x',
        images: [{ bytes: png(1), content_type: 'image/png' }],
        mask: { bytes: png(2), content_type: 'image/png' },
        meta,
      }),
    ).rejects.toThrow(/不认遮罩/)
    await expect(p.edit?.({ prompt: 'x', images: [], meta })).rejects.toThrow(/at least one/)
    expect(g.seen).toHaveLength(0)
  })

  it('其它回包形状也认：SDK 的 output_image、generateContent 的 inlineData', async () => {
    const a = fakeGoogle(() => ({
      json: { output_image: { data: b64([5]), mime_type: 'image/png' } },
    }))
    expect((await provider(a.fetch).generate({ prompt: 'x', meta })).assets[0]?.content_type).toBe(
      'image/png',
    )
    const b = fakeGoogle(() => ({
      json: {
        candidates: [
          {
            content: {
              parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/webp', data: b64([6]) } }],
            },
          },
        ],
      },
    }))
    const out = await provider(b.fetch).generate({ prompt: 'x', meta })
    expect(out.assets[0]?.content_type).toBe('image/webp')
    expect([...(out.assets[0]?.bytes ?? [])]).toEqual([6])
  })

  describe('内容安全拒绝 → 人话', () => {
    it('HTTP 400 + SAFETY', async () => {
      const g = fakeGoogle(() => ({
        status: 400,
        json: {
          error: { code: 400, message: 'Request blocked: SAFETY', status: 'INVALID_ARGUMENT' },
        },
      }))
      const err = await provider(g.fetch)
        .generate({ prompt: 'x', meta })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(GatewayError)
      expect((err as Error).message).toBe(IMAGE_SAFETY_REFUSAL_ZH)
      expect((err as GatewayError).details).toEqual({ reason: 'content_safety' })
    })
    it('status failed + errors 里带 safety', async () => {
      const g = fakeGoogle(() => ({
        json: {
          status: 'failed',
          errors: [{ code: 'image_safety', message: 'prohibited content' }],
        },
      }))
      await expect(provider(g.fetch).generate({ prompt: 'x', meta })).rejects.toThrow(
        IMAGE_SAFETY_REFUSAL_ZH,
      )
    })
    it('只回一句话没出图：当拒绝，并带上模型原话', async () => {
      const g = fakeGoogle(() => ({
        json: {
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'text', text: "I can't create that image." }],
            },
          ],
        },
      }))
      const err = (await provider(g.fetch)
        .generate({ prompt: 'x', meta })
        .catch((e: unknown) => e)) as Error
      expect(err.message.startsWith(IMAGE_SAFETY_REFUSAL_ZH)).toBe(true)
      expect(err.message).toContain("I can't create that image.")
    })
    it('generateContent 形状的 promptFeedback.blockReason', async () => {
      const g = fakeGoogle(() => ({
        json: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } },
      }))
      await expect(provider(g.fetch).generate({ prompt: 'x', meta })).rejects.toThrow(
        IMAGE_SAFETY_REFUSAL_ZH,
      )
    })
  })

  describe('错误映射 → 人话', () => {
    const errOf = async (status: number, body: unknown): Promise<Error> => {
      const g = fakeGoogle(() => ({ status, json: body }))
      return (await provider(g.fetch)
        .generate({ prompt: 'x', meta })
        .catch((e: unknown) => e)) as Error
    }
    it('key 不对（400 API_KEY_INVALID / 403）', async () => {
      const a = await errOf(400, {
        error: {
          code: 400,
          message: 'API key not valid. API_KEY_INVALID',
          status: 'INVALID_ARGUMENT',
        },
      })
      expect(a.message).toMatch(/Google 不认这把 key/)
      expect((a as GatewayError).code).toBe('unauthenticated')
      const b = await errOf(403, {
        error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' },
      })
      expect(b.message).toMatch(/Google 不认这把 key/)
    })
    it('型号名不对（404）', async () => {
      const e = await errOf(404, {
        error: { code: 404, message: 'models/x not found', status: 'NOT_FOUND' },
      })
      expect(e.message).toContain(NANO_BANANA_MODEL)
    })
    it('限流 / 额度（429）', async () => {
      const e = await errOf(429, {
        error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' },
      })
      expect((e as GatewayError).code).toBe('rate_limited')
      expect(e.message).toMatch(/限流/)
    })
    it('地区不可用', async () => {
      const e = await errOf(400, {
        error: {
          code: 400,
          message: 'User location is not supported for the API use.',
          status: 'FAILED_PRECONDITION',
        },
      })
      expect((e as GatewayError).code).toBe('residency_blocked')
      expect(e.message).toMatch(/地区/)
    })
    it('Google 那边出错（5xx）是可重试的 ProviderError', async () => {
      const e = await errOf(503, {
        error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' },
      })
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).status).toBe(503)
      expect(e.message).toMatch(/Google 那边暂时出错/)
    })
    it('连不上 Google：说人话并指向积分出图', async () => {
      const p = geminiImageProvider({
        apiKey: () => 'k',
        model: NANO_BANANA_MODEL,
        provider: 'google',
        fetch: async () => {
          throw new TypeError('fetch failed')
        },
      })
      await expect(p.generate({ prompt: 'x', meta })).rejects.toThrow(/连不上 Google/)
    })
    it('没 key：一次请求都不发', async () => {
      const g = fakeGoogle(() => imageReply([1]))
      const p = geminiImageProvider({
        apiKey: () => undefined,
        model: NANO_BANANA_MODEL,
        provider: 'google',
        ...(g.fetch === undefined ? {} : { fetch: g.fetch }),
      })
      await expect(p.generate({ prompt: 'x', meta })).rejects.toThrow(/missing api key/)
      expect(g.seen).toHaveLength(0)
    })
  })

  it('画布换算与地址', () => {
    expect(geminiCanvas('1024x1024')).toEqual({ aspect_ratio: '1:1', image_size: '1K' })
    expect(geminiCanvas('1024x1280')).toEqual({ aspect_ratio: '4:5', image_size: '2K' })
    expect(geminiCanvas('3000x1000').aspect_ratio).toBe('21:9') // 3:1 不在官方枚举里，就近
    expect(geminiCanvas('4096x2304').image_size).toBe('4K')
    expect(geminiNativeBase(undefined)).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(geminiNativeBase('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    )
  })
})

describe('认厂商 / 两个型号合一 / 估美元', () => {
  it('只认官方主机', () => {
    expect(imageVendorOf('https://api.openai.com/v1')).toBe('openai')
    expect(imageVendorOf('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe('google')
    expect(imageVendorOf('https://api.deepseek.com')).toBeUndefined()
    expect(imageVendorOf('https://my-proxy.example.com/v1')).toBeUndefined()
    expect(imageVendorOf('not a url')).toBeUndefined()
  })

  it('出图走 flare、改图走 sunburst', async () => {
    const gen = stubImageProvider({
      seed: 1,
      ref: { provider: 'openai', model: GPT_IMAGE_GENERATE_MODEL },
    })
    const edit = stubImageProvider({
      seed: 1,
      ref: { provider: 'openai', model: GPT_IMAGE_EDIT_MODEL },
    })
    const p = splitImageProvider({ generate: gen, edit })
    expect(p.ref.model).toBe(GPT_IMAGE_GENERATE_MODEL)
    expect((await p.generate({ prompt: 'x', meta })).model.model).toBe(GPT_IMAGE_GENERATE_MODEL)
    const out = await p.edit?.({
      prompt: 'x',
      images: [{ bytes: png(1), content_type: 'image/png' }],
      meta,
    })
    expect(out?.model.model).toBe(GPT_IMAGE_EDIT_MODEL)
  })

  it('估美元：Nano Banana 按张、GPT Image 按像素、不认识的不编', () => {
    expect(
      estimateImageUsd({ model: NANO_BANANA_MODEL, size: '1024x1024', operation: 'generate' }),
    ).toBe(0.0336)
    expect(
      estimateImageUsd({ model: NANO_BANANA_MODEL, size: '2048x1152', operation: 'generate' }),
    ).toBe(0.0504)
    expect(
      estimateImageUsd({
        model: NANO_BANANA_MODEL,
        size: '1024x1024',
        operation: 'edit',
        references: 3,
      }),
    ).toBe(0.0366)
    expect(
      estimateImageUsd({
        model: GPT_IMAGE_GENERATE_MODEL,
        size: '1024x1024',
        operation: 'generate',
      }),
    ).toBe(0.013)
    expect(
      estimateImageUsd({ model: 'doubao-seedream-5-0-pro', operation: 'generate' }),
    ).toBeUndefined()
  })
})

describe('openaiImageProvider：内容安全拦了说人话（WP274）', () => {
  it('moderation_blocked → 那句人话', async () => {
    const p = openaiImageProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: () => 'sk-test',
      model: GPT_IMAGE_GENERATE_MODEL,
      provider: 'openai',
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () =>
          JSON.stringify({
            error: {
              code: 'moderation_blocked',
              message: 'Your request was rejected by the safety system.',
            },
          }),
      }),
    })
    await expect(p.generate({ prompt: 'x', meta })).rejects.toThrow(IMAGE_SAFETY_REFUSAL_ZH)
  })
})
