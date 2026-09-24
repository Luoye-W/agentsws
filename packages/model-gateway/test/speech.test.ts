/**
 * WP145：识别器选择层。没注册别的识别器时，与直接调网关逐字相同；
 * 注册一个替身后，按选择走它、不经网关记账；撤下 / 重名 / 语言 / 下载源都明确报错。
 */
import { describe, expect, it } from 'vitest'
import {
  createModelGateway,
  createSpeechToText,
  GATEWAY_SPEECH_PROVIDER_ID,
  localTranscription,
  type SpeechProvider,
  stubAsrProvider,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const AUDIO = { bytes: enc('罗野：好。'), mime: 'audio/webm', duration_ms: 3000 }
const M = meta({ purpose: 'transcription' })

const gateway = () => {
  const rec = recorder()
  const g = createModelGateway({
    providers: [stubAsrProvider({ seed: 7 })],
    policy: policy({
      default: { provider: 'stub', model: 'stub-asr-v1', region: 'cn' },
      prices: { 'stub/stub-asr-v1': { in: 1_000, out: 0, cached: 0 } },
    }),
    clock: fixedClock(),
    env: {},
    eventSink: rec.sink,
  })
  return { g, rec }
}

/** 替身本机识别器：固定台词，记下收到的语言与信号。 */
const standIn = (over: Partial<SpeechProvider['info']> = {}) => {
  const seen: { language?: string | undefined; signal?: AbortSignal }[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  let hold = false
  const provider: SpeechProvider = {
    info: {
      id: 'local-stand-in',
      name: '本机替身',
      location: 'host-local',
      billing: 'none',
      languages: ['auto', 'zh', 'en'],
      downloadSources: ['https://mirror.example'],
      ...over,
    },
    async transcribe(input, ctx) {
      seen.push({ language: input.language, signal: ctx.signal })
      if (hold) await gate
      ctx.signal.throwIfAborted()
      return localTranscription('local-stand-in', input, {
        text: '本机听到的',
        segments: [{ start_ms: 0, end_ms: 1000, text: '本机听到的' }],
      })
    },
  }
  return {
    provider,
    seen,
    holdNext: () => {
      hold = true
    },
    release: () => release(),
  }
}

describe('识别器选择层', () => {
  it('没注册别的：只有网关这一个，转写结果、账目、事件与直接调网关逐字相同', async () => {
    const direct = gateway()
    const viaSlot = gateway()
    const speech = createSpeechToText({ gateway: viaSlot.g })
    expect(speech.providers().map((p) => p.id)).toEqual([GATEWAY_SPEECH_PROVIDER_ID])
    expect(speech.selection()).toEqual({ providerId: GATEWAY_SPEECH_PROVIDER_ID })

    const a = await direct.g.transcribe(AUDIO, M)
    const spec = speech.resolve({ input: AUDIO })
    expect(spec.input).toBe(AUDIO) // 入参原对象交出去，一个字段都不补
    const b = await speech.transcribe(spec, M)
    expect(b).toEqual(a)
    expect(viaSlot.g.records()).toEqual(direct.g.records())
    expect(viaSlot.rec.events).toEqual(direct.rec.events)
  })

  it('注册替身并选中：走它、不经网关记账（没有 model.usage）', async () => {
    const { g, rec } = gateway()
    const speech = createSpeechToText({ gateway: g })
    const s = standIn()
    speech.register(s.provider)
    speech.configure({ providerId: 'local-stand-in' })
    const out = await speech.transcribe(speech.resolve({ input: AUDIO }), M)
    expect(out.text).toBe('本机听到的')
    expect(out.usage.cost_base).toBe(0)
    expect(out.model).toEqual({ provider: 'local-stand-in', model: 'local-stand-in' })
    expect(out.audio.bytes).toBe(AUDIO.bytes.byteLength)
    expect(g.records()).toEqual([])
    expect(rec.ofType('model.usage')).toEqual([])
  })

  it('语言：默认语言补给识别器；不认的语言在转写前就拒绝', () => {
    const { g } = gateway()
    const speech = createSpeechToText({ gateway: g, language: 'zh' })
    speech.register(standIn().provider)
    const spec = speech.resolve({ input: AUDIO, providerId: 'local-stand-in' })
    expect(spec.input.language).toBe('zh')
    expect(() =>
      speech.resolve({ input: AUDIO, providerId: 'local-stand-in', language: 'yue' }),
    ).toThrow(expect.objectContaining({ code: 'unsupported_language' }))
    expect(() => speech.configure({ providerId: 'local-stand-in', language: 'yue' })).toThrow(
      expect.objectContaining({ code: 'unsupported_language' }),
    )
    expect(speech.selection().providerId).toBe(GATEWAY_SPEECH_PROVIDER_ID) // 没保存
  })

  it('没注册的、重名的、没有的下载源：都明确报错，不偷偷换一个', () => {
    const { g } = gateway()
    const speech = createSpeechToText({ gateway: g })
    expect(() => speech.configure({ providerId: 'sensevoice-local' })).toThrow(
      expect.objectContaining({ code: 'provider_missing' }),
    )
    speech.register(standIn().provider)
    expect(() => speech.register(standIn().provider)).toThrow(
      expect.objectContaining({ code: 'provider_duplicate' }),
    )
    expect(() =>
      speech.prepare('local-stand-in', { downloadSource: 'https://evil.example' }),
    ).toThrow(expect.objectContaining({ code: 'bad_download_source' }))
    expect(() =>
      speech.prepare('local-stand-in', { downloadSource: 'https://mirror.example' }),
    ).not.toThrow()
  })

  it('撤下：正在跑的被取消；之前解析好的选择不能再用', async () => {
    const { g } = gateway()
    const speech = createSpeechToText({ gateway: g })
    const s = standIn()
    const withdraw = speech.register(s.provider)
    const spec = speech.resolve({ input: AUDIO, providerId: 'local-stand-in' })
    s.holdNext()
    const running = speech.transcribe(spec, M)
    await Promise.resolve()
    withdraw()
    s.release()
    await expect(running).rejects.toMatchObject({ code: 'provider_withdrawn' })
    expect(s.seen[0]?.signal?.aborted).toBe(true)
    await expect(speech.transcribe(spec, M)).rejects.toMatchObject({ code: 'provider_withdrawn' })
    expect(speech.providers().map((p) => p.id)).toEqual([GATEWAY_SPEECH_PROVIDER_ID])
  })
})
