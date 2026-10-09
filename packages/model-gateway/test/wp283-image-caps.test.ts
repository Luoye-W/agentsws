/**
 * WP283（决策 300 / 301）：生图型号能力表——认不认遮罩只在一处判；退役型号（gpt-image-1.5）指到 gpt-image-2。
 */
import { describe, expect, it } from 'vitest'
import {
  geminiImageProvider,
  IMAGE_MODEL_CAPS,
  imageMaskSupported,
  isRetiredImageModel,
  normalizeImageModel,
  openaiImageProvider,
  splitImageProvider,
  stubImageProvider,
} from '../src/index.js'

const meta = { workspace_id: 'ws', run_id: 'run_1', purpose: 'run' } as never
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])

describe('能力表：认不认遮罩', () => {
  it('经 Agents 工坊云的一律不认（OpenRouter 的 GPT / Nano Banana、Seedream）', () => {
    for (const m of [
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gpt-image-2',
      'gpt-image-1',
      'gpt-image-1-mini',
      'gemini-nano-banana-2.1',
      'doubao-seedream-5-0-pro-260628',
      'doubao-seedream-5-0-lite-260128',
    ])
      expect(imageMaskSupported(m, 'cloud'), m).toBe(false)
  })

  it('直连：OpenAI 那一族认（含表里没有的日期快照）；Nano Banana / Seedream / 认不出的不认', () => {
    expect(imageMaskSupported('gpt-image-2.5-sunburst', 'direct')).toBe(true)
    expect(imageMaskSupported('gpt-image-2.5-sunburst-2026-09-08', 'direct')).toBe(true)
    expect(imageMaskSupported('gpt-image-1.5', 'direct')).toBe(true)
    expect(imageMaskSupported('dall-e-2', 'direct')).toBe(true)
    expect(imageMaskSupported('gemini-nano-banana-2.1', 'direct')).toBe(false)
    expect(imageMaskSupported('doubao-seedream-5-0-pro-260628', 'direct')).toBe(false)
    expect(imageMaskSupported('qwen-image-3.0-pro', 'direct')).toBe(false)
  })

  it('表里每一行都有名字与两列', () => {
    for (const [id, caps] of Object.entries(IMAGE_MODEL_CAPS)) {
      expect(caps.label, id).not.toBe('')
      expect(typeof caps.mask.direct).toBe('boolean')
      expect(typeof caps.mask.cloud).toBe('boolean')
    }
  })
})

describe('退役型号：gpt-image-1.5 → gpt-image-2（决策 301）', () => {
  it('含日期快照、大小写与空格都认；别的原样', () => {
    expect(normalizeImageModel('gpt-image-1.5')).toBe('gpt-image-2')
    expect(normalizeImageModel(' GPT-Image-1.5 ')).toBe('gpt-image-2')
    expect(normalizeImageModel('gpt-image-1.5-2025-12-16')).toBe('gpt-image-2')
    expect(normalizeImageModel('gpt-image-1')).toBe('gpt-image-1')
    expect(normalizeImageModel('gpt-image-2.5-flare')).toBe('gpt-image-2.5-flare')
    expect(isRetiredImageModel('gpt-image-1.5')).toBe(true)
    expect(isRetiredImageModel('gpt-image-1-mini')).toBe(false)
  })
})

describe('provider 报 supports_mask', () => {
  const fakeFetch = (forms: FormData[]) => async (_url: string, init: { body?: unknown }) => {
    if (init.body instanceof FormData) forms.push(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: Buffer.from([1]).toString('base64') }] }),
      text: async () => '',
    }
  }

  it('openai：mask:false → 报不认、遮罩不往上游带；没给 → 不报（照旧带）', async () => {
    const forms: FormData[] = []
    const off = openaiImageProvider({
      baseUrl: 'https://cloud.test.invalid/v1/ai',
      apiKey: () => 'wst',
      model: 'gpt-image-2.5-sunburst',
      provider: 'agentsws_cloud',
      mask: false,
      fetch: fakeFetch(forms) as never,
    })
    expect(off.supports_mask).toBe(false)
    await off.edit?.({
      prompt: 'x',
      images: [{ bytes: png, content_type: 'image/png' }],
      mask: { bytes: png, content_type: 'image/png' },
      meta,
    })
    expect(forms[0]?.get('mask')).toBeNull()
    const plain = openaiImageProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: () => 'sk',
      model: 'gpt-image-1',
      provider: 'openai',
      fetch: fakeFetch(forms) as never,
    })
    expect(plain.supports_mask).toBeUndefined()
    await plain.edit?.({
      prompt: 'x',
      images: [{ bytes: png, content_type: 'image/png' }],
      mask: { bytes: png, content_type: 'image/png' },
      meta,
    })
    expect(forms[1]?.get('mask')).not.toBeNull()
  })

  it('gemini：不认；出图 / 改图两个合一时看改图那一个', () => {
    const gem = geminiImageProvider({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: () => 'g',
      model: 'gemini-nano-banana-2.1',
      provider: 'google',
    })
    expect(gem.supports_mask).toBe(false)
    const split = splitImageProvider({
      generate: stubImageProvider({ seed: 1 }),
      edit: { ...stubImageProvider({ seed: 2 }), supports_mask: true },
    })
    expect(split.supports_mask).toBe(true)
    expect(
      splitImageProvider({ generate: stubImageProvider({ seed: 1 }), edit: gem }).supports_mask,
    ).toBe(false)
  })
})
