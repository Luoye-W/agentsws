/**
 * WP268（决策 213）：参考图改图（`ImageProvider.edit`）——OpenAI 形态 `images/edits`、占位替身、出不了图那一条、
 * 宽高比 → 画布。全部替身，不联网、不花钱。
 */
import { describe, expect, it } from 'vitest'
import {
  imageFidelitySupported,
  imageSizeFor,
  openaiImageProvider,
  ProviderError,
  stubImageProvider,
  unavailableImageProvider,
} from '../src/index.js'

const meta = {
  workspace_id: 'ws_1',
  assignment_id: 'asg_1',
  role_id: 'site.shopify-theme',
  run_id: 'run_1',
  purpose: 'run',
} as never

const png = (n: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])

describe('openaiImageProvider.edit（images/edits，multipart）', () => {
  it('参考图走重复的 image[]、遮罩与 input_fidelity 带上；key 只进 header', async () => {
    const seen: { url: string; auth?: string; ctype?: string; form?: FormData }[] = []
    const provider = openaiImageProvider({
      baseUrl: 'https://cloud.example.com/v1/ai/',
      apiKey: () => 'wst_test',
      model: 'gpt-image-1',
      provider: 'agentsws_cloud',
      extraHeaders: { 'X-Agentsws-Region': 'global' },
      fetch: async (url, init) => {
        seen.push({
          url,
          ...(init.headers.authorization === undefined ? {} : { auth: init.headers.authorization }),
          ...(init.headers['content-type'] === undefined
            ? {}
            : { ctype: init.headers['content-type'] }),
          ...(init.body instanceof FormData ? { form: init.body } : {}),
        })
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ b64_json: Buffer.from([9, 9]).toString('base64') }] }),
          text: async () => '',
        }
      },
    })
    expect(provider.edit).toBeTypeOf('function')
    const out = await provider.edit?.({
      prompt: 'same bottle on a marble table, morning light',
      images: [
        { bytes: png(1), content_type: 'image/png' },
        { bytes: png(2), content_type: 'image/jpeg', filename: 'side.jpg' },
      ],
      mask: { bytes: png(3), content_type: 'image/png' },
      size: '1536x1024',
      n: 2,
      fidelity: 'high',
      meta,
    })
    expect(seen[0]?.url).toBe('https://cloud.example.com/v1/ai/images/edits')
    expect(seen[0]?.auth).toBe('Bearer wst_test')
    // multipart 的 content-type 交给 fetch（带 boundary），我们不写
    expect(seen[0]?.ctype).toBeUndefined()
    const form = seen[0]?.form as FormData
    expect(form.get('model')).toBe('gpt-image-1')
    expect(form.get('n')).toBe('2')
    expect(form.get('size')).toBe('1536x1024')
    expect(form.get('input_fidelity')).toBe('high')
    const images = form.getAll('image[]') as File[]
    expect(images.map((f) => f.name)).toEqual(['ref-1.png', 'side.jpg'])
    expect((form.get('mask') as File).name).toBe('mask.png')
    expect(out?.assets[0]?.bytes).toEqual(new Uint8Array([9, 9]))
    expect(out?.assets[0]?.width).toBe(1536)
    // 提示词只留哈希
    expect(JSON.stringify(out)).not.toContain('marble')
  })

  it('参考图多于上限只带前几张；一张都没有当场拒、不发请求', async () => {
    let calls = 0
    let count = 0
    const provider = openaiImageProvider({
      baseUrl: 'https://x/v1',
      apiKey: () => 'k',
      model: 'gpt-image-1',
      provider: 'p',
      fetch: async (_url, init) => {
        calls += 1
        count = (init.body as FormData).getAll('image[]').length
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: 'https://cdn/a.png' }] }),
          text: async () => '',
        }
      },
    })
    await expect(provider.edit?.({ prompt: 'x', images: [], meta })).rejects.toThrow(/at least one/)
    expect(calls).toBe(0)
    const imgs = [1, 2, 3, 4, 5, 6].map((n) => ({ bytes: png(n), content_type: 'image/png' }))
    const out = await provider.edit?.({ prompt: 'x', images: imgs, meta })
    expect(count).toBe(provider.max_reference_images)
    expect(out?.assets[0]?.url).toBe('https://cdn/a.png')
  })

  it('上游拒了（余额不足 / 不支持改图）照原样报 ProviderError 带状态码', async () => {
    const provider = openaiImageProvider({
      baseUrl: 'https://x/v1',
      apiKey: () => 'k',
      model: 'some-model',
      provider: 'p',
      fetch: async () => ({
        ok: false,
        status: 402,
        json: async () => ({}),
        text: async () => 'insufficient credits',
      }),
    })
    const err = await provider
      .edit?.({ prompt: 'x', images: [{ bytes: png(1), content_type: 'image/png' }], meta })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).message).toContain('402')
  })

  it('没有 key 不发请求', async () => {
    const provider = openaiImageProvider({
      baseUrl: 'https://x/v1',
      apiKey: () => undefined,
      model: 'gpt-image-1',
      provider: 'p',
      fetch: async () => {
        throw new Error('should not be called')
      },
    })
    await expect(
      provider.edit?.({
        prompt: 'x',
        images: [{ bytes: png(1), content_type: 'image/png' }],
        meta,
      }),
    ).rejects.toThrow(/missing api key/)
  })
})

describe('替身与「没配」那一条', () => {
  it('stub 改图：同一组输入同一批字节；换一张参考图就换颜色', async () => {
    const stub = stubImageProvider({ seed: 7 })
    const a = await stub.edit?.({
      prompt: 'scene',
      images: [{ bytes: png(1), content_type: 'image/png' }],
      size: '64x64',
      n: 2,
      meta,
    })
    const b = await stub.edit?.({
      prompt: 'scene',
      images: [{ bytes: png(1), content_type: 'image/png' }],
      size: '64x64',
      n: 2,
      meta,
    })
    const c = await stub.edit?.({
      prompt: 'scene',
      images: [{ bytes: png(2), content_type: 'image/png' }],
      size: '64x64',
      n: 2,
      meta,
    })
    expect(a?.assets).toHaveLength(2)
    expect(a?.assets[0]?.bytes).toEqual(b?.assets[0]?.bytes)
    expect(a?.assets[0]?.bytes).not.toEqual(c?.assets[0]?.bytes)
    expect(a?.assets[0]?.bytes).not.toEqual(a?.assets[1]?.bytes)
  })

  it('没配生图：改图也说那句人话', async () => {
    const p = unavailableImageProvider()
    await expect(
      p.edit?.({ prompt: 'x', images: [{ bytes: png(1), content_type: 'image/png' }], meta }),
    ).rejects.toThrow(/生图还没配/)
  })
})

describe('宽高比 → 画布（imageSizeFor）', () => {
  it('gpt-image 只认三种：横的取 1536x1024、竖的 1024x1536、方的 1024x1024', () => {
    expect(imageSizeFor('16:9', 'gpt-image-1')).toBe('1536x1024')
    expect(imageSizeFor('3:1', 'gpt-image-1-mini')).toBe('1536x1024')
    expect(imageSizeFor('9:16', 'gpt-image-1')).toBe('1024x1536')
    expect(imageSizeFor('4:5', 'gpt-image-1')).toBe('1024x1536')
    expect(imageSizeFor('1:1', 'gpt-image-1')).toBe('1024x1024')
    expect(imageSizeFor(undefined, 'gpt-image-1')).toBe('1024x1024')
  })

  it('gpt-image-2 / 2.5：任意画布，边长 16 的倍数、比例夹在 1:3–3:1', () => {
    const [w, h] = imageSizeFor('16:9', 'gpt-image-2.5-flare').split('x').map(Number) as [
      number,
      number,
    ]
    expect(w % 16).toBe(0)
    expect(h % 16).toBe(0)
    expect(Math.abs(w / h - 16 / 9)).toBeLessThan(0.03)
    const [w2, h2] = imageSizeFor('21:9', 'gpt-image-2').split('x').map(Number) as [number, number]
    expect(w2 / h2).toBeLessThanOrEqual(3.01)
  })

  it('input_fidelity 只给 gpt-image-1 / 1.5（2 / 2.5 传了会被拒）', () => {
    expect(imageFidelitySupported('gpt-image-1')).toBe(true)
    expect(imageFidelitySupported('gpt-image-1.5')).toBe(true)
    expect(imageFidelitySupported('gpt-image-1-mini')).toBe(false)
    expect(imageFidelitySupported('gpt-image-2.5-sunburst')).toBe(false)
    expect(imageFidelitySupported('doubao-seedream-5-0-pro-260628')).toBe(false)
  })

  it('别的模型按比例算约 1 百万像素、边长是 64 的倍数', () => {
    const [w, h] = imageSizeFor('16:9', 'gemini-2.5-flash-image').split('x').map(Number) as [
      number,
      number,
    ]
    expect(w % 64).toBe(0)
    expect(h % 64).toBe(0)
    expect(Math.abs(w / h - 16 / 9)).toBeLessThan(0.05)
    expect(imageSizeFor('1:1', 'doubao-seedream-5-0-pro-260628')).toBe('1024x1024')
  })

  it('不认 input_fidelity 的型号不带这个字段', async () => {
    let form: FormData | undefined
    const provider = openaiImageProvider({
      baseUrl: 'https://x/v1',
      apiKey: () => 'k',
      model: 'gpt-image-2.5-sunburst',
      provider: 'p',
      fetch: async (_u, init) => {
        form = init.body as FormData
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: 'https://cdn/a.png' }] }),
          text: async () => '',
        }
      },
    })
    await provider.edit?.({
      prompt: 'x',
      images: [{ bytes: png(1), content_type: 'image/png' }],
      fidelity: 'high',
      meta,
    })
    expect(form?.has('input_fidelity')).toBe(false)
  })
})
