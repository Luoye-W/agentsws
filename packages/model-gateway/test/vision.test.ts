/**
 * WP127：文字模型必须能看图 —— 验证三步、能力声明、网关拦截、生图那一档。
 */
import type { ChatMessage, ModelProvider } from '@agentsws/contracts'
import { NO_VISION_REASON } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  CANNOT_SEE_IMAGES_ZH,
  catalogVision,
  catalogVisionByName,
  checkModel,
  createModelGateway,
  type FetchLike,
  GatewayError,
  openaiCompatibleProvider,
  openaiImageProvider,
  ProviderError,
  stubImageProvider,
  stubProvider,
  VISION_PROBE_WORD,
  visionProbeMessages,
  visionProbePassed,
  visionProbePng,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

const gatewayOf = (provider: ModelProvider) =>
  createModelGateway({
    providers: [provider],
    policy: policy(),
    clock: fixedClock(),
    eventSink: recorder().sink,
    env: {},
  })

/** 与 `apps/server` 同一种拆法：先钻 `details.attempts`，钻不进就用外层。 */
const describeError = (e: unknown) => {
  const code =
    typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'x'
  const attempts = (e as { details?: { attempts?: { status?: number; message: string }[] } })
    .details?.attempts
  const last = attempts?.[attempts.length - 1]
  const detail =
    last === undefined
      ? e instanceof Error
        ? e.message
        : String(e)
      : `${last.status === undefined ? '' : `HTTP ${last.status} `}${last.message}`
  return { reason: code, detail }
}

const checkThrough = (provider: ModelProvider) => {
  const gateway = gatewayOf(provider)
  return checkModel({
    complete: (messages: ChatMessage[]) =>
      gateway.complete({
        messages,
        meta: meta({ purpose: 'judge' }),
        model: provider.ref,
        capability_probe: true,
      }),
    describe: describeError,
  })
}

describe('测试图', () => {
  it('几百字节、确定性、是真 PNG', () => {
    const png = visionProbePng()
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(png.length).toBeLessThan(4096)
    expect(visionProbePng()).toBe(png)
  })

  it('念出那个词才算看见（大小写、标点不计较）', () => {
    expect(visionProbePassed(VISION_PROBE_WORD)).toBe(true)
    expect(visionProbePassed(`It says "${VISION_PROBE_WORD.toLowerCase()}".`)).toBe(true)
    expect(visionProbePassed('我看不到图片')).toBe(false)
    expect(visionProbePassed('HORSE')).toBe(false)
  })
})

describe('验证三步（checkModel）', () => {
  it('能看图的模型：三步全过', async () => {
    const out = await checkThrough(stubProvider({ seed: 1 }))
    expect(out.ok).toBe(true)
    expect(out.vision).toBe(true)
    expect(out.steps.map((s) => [s.step, s.ok])).toEqual([
      ['connect', true],
      ['text', true],
      ['vision', true],
    ])
    expect(out.tokens).toBeGreaterThan(0)
  })

  it('看不了图（上游 400 不认图片）：卡在第 ③ 步，码是 no_vision', async () => {
    const out = await checkThrough(stubProvider({ seed: 1, vision: false }))
    expect(out.ok).toBe(false)
    expect(out.failed_step).toBe('vision')
    expect(out.reason).toBe(NO_VISION_REASON)
    expect(out.vision).toBe(false)
    expect(out.steps[2]).toEqual({ step: 'vision', ok: false })
  })

  it('回了话但念不出那个词：也算看不了', async () => {
    const blind: ModelProvider = {
      ref: { provider: 'stub', model: 'stub-v1', region: 'cn' },
      complete: async () => ({
        text: '我看不到图片，但我猜是一只猫',
        usage: { input_tokens: 3, output_tokens: 3, cached_tokens: 0 },
      }),
    }
    const out = await checkThrough(blind)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe(NO_VISION_REASON)
    expect(out.detail).toContain(VISION_PROBE_WORD)
  })

  it('连不上：卡在第 ① 步，后两步标"没跑"', async () => {
    const down: ModelProvider = {
      ref: { provider: 'stub', model: 'stub-v1', region: 'cn' },
      complete: () => Promise.reject(new ProviderError('getaddrinfo ENOTFOUND api.example.com')),
    }
    const out = await checkThrough(down)
    expect(out.failed_step).toBe('connect')
    expect(out.steps.filter((s) => s.skipped === true).map((s) => s.step)).toEqual([
      'text',
      'vision',
    ])
    expect(out.vision).toBeUndefined()
  })

  it('密钥不对：连上了，卡在第 ② 步', async () => {
    const badKey: ModelProvider = {
      ref: { provider: 'stub', model: 'stub-v1', region: 'cn' },
      complete: () =>
        Promise.reject(new ProviderError('provider http 401: invalid api key', { status: 401 })),
    }
    const out = await checkThrough(badKey)
    expect(out.failed_step).toBe('text')
    expect(out.steps[0]).toEqual({ step: 'connect', ok: true })
    expect(out.reason).not.toBe(NO_VISION_REASON)
  })

  it('第 ③ 步余额不足：照实报余额，不冤枉成"看不了图"', async () => {
    let calls = 0
    const broke: ModelProvider = {
      ref: { provider: 'stub', model: 'stub-v1', region: 'cn' },
      complete: () => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve({
            text: '好',
            usage: { input_tokens: 2, output_tokens: 1, cached_tokens: 0 },
          })
        }
        return Promise.reject(
          new ProviderError('provider http 402: insufficient balance', { status: 402 }),
        )
      },
    }
    const out = await checkThrough(broke)
    expect(out.failed_step).toBe('vision')
    expect(out.reason).not.toBe(NO_VISION_REASON)
    expect(out.vision).toBeUndefined()
  })
})

describe('能力声明与网关拦截', () => {
  const imageMessage = visionProbeMessages()

  it('声明了 vision: false：带图请求在网关就拦下，说人话、不花钱', async () => {
    const rec = recorder()
    const gateway = createModelGateway({
      providers: [stubProvider({ seed: 1, vision: false })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const err = await gateway
      .complete({ messages: imageMessage, meta: meta() })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).message).toBe(CANNOT_SEE_IMAGES_ZH)
    expect((err as GatewayError).details).toMatchObject({ reason: NO_VISION_REASON })
    expect(rec.ofType('model.usage')).toHaveLength(0)
    // 纯文字照常
    await expect(
      gateway.complete({ messages: [{ role: 'user', content: '在吗' }], meta: meta() }),
    ).resolves.toMatchObject({ model: { provider: 'stub' } })
  })

  it('没声明（没验证过）：照常放行——"不知道"不等于"不能"', async () => {
    const provider = openaiCompatibleProvider({
      model: 'm',
      provider: 'stub',
      apiKey: () => 'k',
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: VISION_PROBE_WORD } }] }),
        text: async () => '',
      })) as FetchLike,
    })
    expect(provider.capabilities).toBeUndefined()
    const gateway = gatewayOf({ ...provider, ref: { provider: 'stub', model: 'stub-v1' } })
    await expect(gateway.complete({ messages: imageMessage, meta: meta() })).resolves.toMatchObject(
      { text: VISION_PROBE_WORD },
    )
  })

  it('openai 兼容口：装配方给了声明就带上', () => {
    const provider = openaiCompatibleProvider({
      model: 'm',
      capabilities: { vision: true, image_generation: false },
    })
    expect(provider.capabilities).toEqual({ vision: true, image_generation: false })
  })

  it('reconfigure 换生图那一档；null 退回装配时那一条', () => {
    const gateway = gatewayOf(stubProvider({ seed: 1 }))
    expect(gateway.images.available).toBe(false)
    gateway.reconfigure({ images: stubImageProvider({ seed: 1 }) })
    expect(gateway.images.available).toBe(true)
    gateway.reconfigure({ images: null })
    expect(gateway.images.available).toBe(false)
  })
})

describe('内置价目表里写明的能力', () => {
  it('官方接口默认的 deepseek-flash 写明能看图（v4-pro 写明不能）', () => {
    expect(catalogVision('https://api.deepseek.com', 'deepseek-flash')).toBe(true)
    expect(catalogVision('https://api.deepseek.com', 'deepseek-v4-pro')).toBe(false)
    expect(catalogVisionByName('deepseek-flash')).toBe(true)
    expect(catalogVisionByName('gpt-4o-mini')).toBe(true)
    // 没写的就是不知道
    expect(catalogVisionByName('glm-5.3')).toBeUndefined()
  })
})

describe('生图（openaiImageProvider）', () => {
  it('b64 与 URL 两种回法都收；key 只进 header', async () => {
    const seen: { url: string; auth: string | undefined; body: string }[] = []
    const provider = openaiImageProvider({
      baseUrl: 'https://img.example.com/v1/',
      apiKey: () => 'sk-test',
      model: 'gpt-image-1',
      provider: 'mine',
      fetch: (async (url, init) => {
        seen.push({ url, auth: init.headers.authorization, body: String(init.body) })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { b64_json: Buffer.from([1, 2, 3]).toString('base64') },
              { url: 'https://cdn/x.png' },
            ],
          }),
          text: async () => '',
        }
      }) as FetchLike,
    })
    const out = await provider.generate({
      prompt: '白底摆台',
      size: '512x512',
      n: 2,
      meta: meta(),
    })
    expect(seen[0]?.url).toBe('https://img.example.com/v1/images/generations')
    expect(seen[0]?.auth).toBe('Bearer sk-test')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ model: 'gpt-image-1', n: 2 })
    expect(out.assets).toHaveLength(2)
    expect([...(out.assets[0]?.bytes ?? [])]).toEqual([1, 2, 3])
    expect(out.assets[1]?.url).toBe('https://cdn/x.png')
    expect(out.assets[0]?.width).toBe(512)
  })

  it('上游拒了：抛带状态码的错，不假装出了图', async () => {
    const provider = openaiImageProvider({
      baseUrl: 'https://img.example.com/v1',
      apiKey: () => 'k',
      model: 'x',
      provider: 'mine',
      fetch: (async () => ({
        ok: false,
        status: 402,
        json: async () => ({}),
        text: async () => 'insufficient credits',
      })) as FetchLike,
    })
    await expect(provider.generate({ prompt: 'p', meta: meta() })).rejects.toMatchObject({
      status: 402,
    })
  })
})
