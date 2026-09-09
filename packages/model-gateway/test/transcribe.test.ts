/**
 * 22 ASR 槽（WP23）：stub provider 的确定性、网关的路由 / 记账 / 驻留 / 预算 / 急停，
 * 以及 OpenAI 兼容 provider 的 `/audio/transcriptions`（fixture 回放，不联网）。
 *
 * 一条红线单独测：**音频字节永不进事件日志**，只有摘要。
 */
import type { ModelProvider } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { FetchLike, ModelGatewayPolicy } from '../src/index.js'
import {
  createModelGateway,
  decodeReadableText,
  extensionFor,
  openaiCompatibleProvider,
  segmentText,
  stubAsrProvider,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

const asrPolicy = () =>
  policy({
    default: { provider: 'stub', model: 'stub-asr-v1', region: 'cn' },
    prices: {
      // ASR 按音频秒数计价：秒数记在 input_tokens 上，价目表同一套换算
      'stub/stub-asr-v1': { in: 1_000, out: 0, cached: 0 },
      'openai/whisper-1': { in: 6_000, out: 0, cached: 0 },
    },
  })

interface GatewayOver {
  providers?: ModelProvider[]
  policy?: ModelGatewayPolicy
  env?: Record<string, string | undefined>
}

const gateway = (over: GatewayOver = {}) => {
  const rec = recorder()
  const g = createModelGateway({
    providers: over.providers ?? [stubAsrProvider({ seed: 7 })],
    policy: over.policy ?? asrPolicy(),
    clock: fixedClock(),
    env: over.env ?? {},
    eventSink: rec.sink,
  })
  return { g, rec }
}

describe('stub ASR provider', () => {
  it('确定性：同一 (bytes, mime, language, seed) 两次转写逐字节一致', async () => {
    const p = stubAsrProvider({ seed: 7 })
    const a = await p.transcribe?.({ bytes: enc('罗野：好。'), mime: 'audio/webm' })
    const b = await p.transcribe?.({ bytes: enc('罗野：好。'), mime: 'audio/webm' })
    expect(a).toEqual(b)
  })

  it('回声档：字节是可读文本时直接当台词，按 `姓名：` 切说话人', async () => {
    const p = stubAsrProvider({ seed: 1, segmentMs: 1000 })
    const t = await p.transcribe?.({
      bytes: enc('罗野：甲。\n张三：乙。'),
      mime: 'audio/webm',
      language: 'zh',
    })
    expect(t?.segments).toEqual([
      { start_ms: 0, end_ms: 1000, speaker: '罗野', text: '甲。' },
      { start_ms: 1000, end_ms: 2000, speaker: '张三', text: '乙。' },
    ])
    expect(t?.speakers).toEqual(['罗野', '张三'])
    expect(t?.language).toBe('zh')
  })

  it('词表档：真二进制按 seed 生成句子；换 seed 换结果', async () => {
    const bin = new Uint8Array([0x00, 0x01, 0xff, 0xfe])
    const a = await stubAsrProvider({ seed: 1 }).transcribe?.({ bytes: bin, mime: 'audio/webm' })
    const b = await stubAsrProvider({ seed: 2 }).transcribe?.({ bytes: bin, mime: 'audio/webm' })
    expect(a?.text.length).toBeGreaterThan(0)
    expect(a?.text).not.toBe(b?.text)
    expect(a?.speakers).toBeUndefined()
  })

  it('ASR-only provider 不做补全', async () => {
    await expect(async () =>
      stubAsrProvider({ seed: 1 }).complete({ messages: [] }),
    ).rejects.toThrow(/does not implement complete/)
  })

  it('可读文本判定：空白、控制字符、非 UTF-8 都不算可读', () => {
    expect(decodeReadableText(enc('你好'))).toBe('你好')
    expect(decodeReadableText(enc('   '))).toBeUndefined()
    expect(decodeReadableText(new Uint8Array([0x01, 0x41]))).toBeUndefined()
    expect(decodeReadableText(new Uint8Array([0xff, 0xfe]))).toBeUndefined()
  })

  it('切段：没有说话人前缀的整行当正文', () => {
    expect(segmentText('随便一句', 2000)).toEqual([{ start_ms: 0, end_ms: 2000, text: '随便一句' }])
    expect(segmentText('名字：', 1000)).toEqual([{ start_ms: 0, end_ms: 1000, text: '名字：' }])
  })
})

describe('网关 transcribe', () => {
  it('转写：回文本 + 段落 + 音频摘要；usage 按秒计价', async () => {
    const { g, rec } = gateway()
    const t = await g.transcribe(
      { bytes: enc('罗野：甲。'), mime: 'audio/webm', duration_ms: 4200 },
      meta({ purpose: 'transcription' }),
    )
    expect(t.text).toBe('罗野：甲。')
    expect(t.model).toEqual({ provider: 'stub', model: 'stub-asr-v1', region: 'cn' })
    expect(t.audio).toMatchObject({ duration_ms: 4200, mime: 'audio/webm' })
    expect(t.audio.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(t.audio.bytes).toBe(enc('罗野：甲。').byteLength)
    expect(t.usage.cost_base).toBeGreaterThan(0)

    const usage = rec.ofType('model.usage')
    expect(usage).toHaveLength(1)
    const payload = usage[0]?.payload as { audio: unknown }
    expect(payload.audio).toEqual(t.audio)
    // 红线：字节与转写正文都不在事件里
    expect(JSON.stringify(usage[0])).not.toContain('罗野：甲。')
  })

  it('记账：usage 报表与事件求和一致，按 run 也筛得出来', async () => {
    const { g } = gateway()
    await g.transcribe(
      { bytes: enc('a'), mime: 'audio/webm', duration_ms: 1000 },
      meta({ purpose: 'transcription' }),
    )
    await g.transcribe(
      { bytes: enc('b'), mime: 'audio/webm', duration_ms: 1000 },
      meta({ purpose: 'transcription', run_id: 'run_2' }),
    )
    const all = await g.usage({ workspace_id: 'ws_1' })
    expect(all.calls).toBe(2)
    const one = await g.usage({ workspace_id: 'ws_1', run_id: 'run_2' })
    expect(one.calls).toBe(1)
    expect(g.records().every((r) => r.purpose === 'transcription')).toBe(true)
  })

  it('驻留：cn 下 global provider 被拦；音频同 eu 规则', async () => {
    const cn = gateway({
      providers: [
        stubAsrProvider({
          seed: 1,
          ref: { provider: 'openai', model: 'whisper-1', region: 'global' },
        }),
      ],
      policy: {
        ...asrPolicy(),
        default: { provider: 'openai', model: 'whisper-1', region: 'global' },
      },
    })
    await expect(async () =>
      cn.g.transcribe({ bytes: enc('a'), mime: 'audio/webm' }, meta({ purpose: 'transcription' })),
    ).rejects.toThrow(/data_residency cn/)
    expect(cn.rec.ofType('model.blocked_residency')).toHaveLength(1)

    const eu = gateway({
      providers: [stubAsrProvider({ seed: 1, ref: { provider: 'cloud_brain', model: 'asr' } })],
      policy: {
        ...asrPolicy(),
        data_residency: 'any',
        default: { provider: 'cloud_brain', model: 'asr' },
        prices: { 'cloud_brain/asr': { in: 1, out: 0, cached: 0 } },
      },
    })
    await expect(async () =>
      eu.g.transcribe(
        { bytes: enc('a'), mime: 'audio/webm', eu_customer: true },
        meta({ purpose: 'transcription' }),
      ),
    ).rejects.toThrow(/eu customer/)
  })

  it('provider 没有 transcribe → not_implemented；provider 抛错 → provider_unavailable + 事件', async () => {
    const noAsr = gateway({
      providers: [
        {
          ref: { provider: 'stub', model: 'stub-asr-v1', region: 'cn' },
          complete: async () => ({
            text: '',
            usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
          }),
        },
      ],
    })
    await expect(async () =>
      noAsr.g.transcribe(
        { bytes: enc('a'), mime: 'audio/webm' },
        meta({ purpose: 'transcription' }),
      ),
    ).rejects.toThrow(/does not support transcribe/)

    const broken = gateway({
      providers: [
        {
          ref: { provider: 'stub', model: 'stub-asr-v1', region: 'cn' },
          complete: async () => ({
            text: '',
            usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
          }),
          transcribe: async () => {
            throw new Error('ASR 挂了')
          },
        },
      ],
    })
    await expect(async () =>
      broken.g.transcribe(
        { bytes: enc('a'), mime: 'audio/webm' },
        meta({ purpose: 'transcription' }),
      ),
    ).rejects.toThrow(/transcribe provider failed/)
    expect(broken.rec.ofType('model.provider_down')).toHaveLength(1)
    // 失败不记账
    expect(await broken.g.usage({ workspace_id: 'ws_1' })).toMatchObject({ calls: 0 })
  })

  it('急停：AGENTSWS_MODEL_HALT=1 时转写也停', async () => {
    const { g } = gateway({ env: { AGENTSWS_MODEL_HALT: '1' } })
    await expect(async () =>
      g.transcribe({ bytes: enc('a'), mime: 'audio/webm' }, meta({ purpose: 'transcription' })),
    ).rejects.toThrow(/halted/)
  })

  it('运行预算：超过 max_cost_base 就拦，并发预留照走同一套账本', async () => {
    const { g, rec } = gateway()
    await expect(async () =>
      g.transcribe(
        { bytes: enc('a'), mime: 'audio/webm', duration_ms: 3_600_000, max_cost_base: 0.000_001 },
        meta({ purpose: 'transcription' }),
      ),
    ).rejects.toThrow()
    expect(rec.ofType('budget.exhausted').length).toBeGreaterThan(0)
  })

  it('没给时长时按 1 秒下限估算，仍然记得出账', async () => {
    const { g } = gateway()
    const t = await g.transcribe(
      { bytes: enc('a'), mime: 'audio/webm' },
      meta({ purpose: 'transcription' }),
    )
    expect(t.audio.duration_ms).toBe(0)
    expect((await g.usage({ workspace_id: 'ws_1' })).calls).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* OpenAI 兼容 provider 的 /audio/transcriptions（fixture 回放）           */
/* ------------------------------------------------------------------ */

const KEY_ENV = 'AGENTSWS_TEST_ASR_KEY'
const env = { [KEY_ENV]: 'test-value-not-a-real-credential' }

/** 录自 OpenAI `/audio/transcriptions`（`response_format: verbose_json`）的形状。 */
const VERBOSE_JSON = {
  task: 'transcribe',
  language: 'chinese',
  duration: 12.34,
  text: '我们决定下周一上线。 我来跟进。',
  segments: [
    { id: 0, start: 0.0, end: 4.2, text: '我们决定下周一上线。', speaker: 'SPEAKER_00' },
    { id: 1, start: 4.2, end: 6.1, text: '我来跟进。', speaker: 'SPEAKER_01' },
  ],
}

const mockFetch = (
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetch: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } => {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  return { fetch, calls }
}

describe('openaiCompatibleProvider · /audio/transcriptions', () => {
  it('回放 verbose_json：段落换成毫秒、说话人带上、时长进 usage', async () => {
    const { fetch, calls } = mockFetch(VERBOSE_JSON)
    const p = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'gpt-x',
      provider: 'openai',
      env,
      fetch,
      transcriptionModel: 'whisper-1',
    })
    const t = await p.transcribe?.({ bytes: enc('audio'), mime: 'audio/webm', language: 'zh' })
    expect(calls[0]?.url).toContain('/audio/transcriptions')
    // multipart：boundary 由 fetch 自己写，手工 content-type 会让上游解不出来
    expect(calls[0]?.init.headers['content-type']).toBeUndefined()
    expect(calls[0]?.init.body).toBeInstanceOf(FormData)
    const form = calls[0]?.init.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('language')).toBe('zh')
    expect((form.get('file') as File).name).toBe('audio.webm')

    expect(t?.text).toBe(VERBOSE_JSON.text)
    expect(t?.segments[0]).toEqual({
      start_ms: 0,
      end_ms: 4200,
      speaker: 'SPEAKER_00',
      text: '我们决定下周一上线。',
    })
    expect(t?.speakers).toEqual(['SPEAKER_00', 'SPEAKER_01'])
    expect(t?.language).toBe('chinese')
    expect(t?.usage.input_tokens).toBe(13)
  })

  it('上游只回 text（没有 segments / duration）也接得住', async () => {
    const { fetch } = mockFetch({ text: 'hello' })
    const p = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'gpt-x',
      env,
      fetch,
      transcriptionModel: 'whisper-1',
    })
    const t = await p.transcribe?.({ bytes: enc('a'), mime: 'audio/mpeg' })
    expect(t?.segments).toEqual([])
    expect(t?.speakers).toBeUndefined()
    expect(t?.usage.input_tokens).toBe(1)
  })

  it('不配 transcriptionModel 就不暴露 transcribe；embed 与 asr 可以同时有', () => {
    const plain = openaiCompatibleProvider({ apiKeyEnv: KEY_ENV, model: 'gpt-x', env })
    expect(plain.transcribe).toBeUndefined()
    const both = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'gpt-x',
      env,
      transcriptionModel: 'whisper-1',
      embeddingModel: 'emb-1',
    })
    expect(both.transcribe).toBeDefined()
    expect(both.embed).toBeDefined()
  })

  it('mime → 文件后缀（上游按后缀判格式）', () => {
    expect(extensionFor('audio/webm')).toBe('webm')
    expect(extensionFor('audio/mpeg; codecs=mp3')).toBe('mp3')
    expect(extensionFor('application/octet-stream')).toBe('bin')
  })

  it('凭据只从环境变量读：没有 key 就在发请求前拒', async () => {
    const { fetch, calls } = mockFetch(VERBOSE_JSON)
    const p = openaiCompatibleProvider({
      apiKeyEnv: 'AGENTSWS_TEST_MISSING_KEY',
      model: 'gpt-x',
      env: {},
      fetch,
      transcriptionModel: 'whisper-1',
    })
    await expect(async () =>
      p.transcribe?.({ bytes: enc('a'), mime: 'audio/webm' }),
    ).rejects.toThrow(/missing api key/)
    expect(calls).toHaveLength(0)
  })
})
