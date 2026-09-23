import { describe, expect, it } from 'vitest'
import {
  createModelGateway,
  NO_IMAGE_MODEL_ZH,
  parseImageSize,
  placeholderPng,
  stubImageProvider,
  stubProvider,
  unavailableImageProvider,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

const gateway = (images?: ReturnType<typeof stubImageProvider>) =>
  createModelGateway({
    providers: [stubProvider({ seed: 1 })],
    policy: policy(),
    clock: fixedClock(),
    eventSink: recorder().sink,
    env: {},
    ...(images === undefined ? {} : { images }),
  })

describe('22 图片槽（WP76，58 §1）', () => {
  it('没装图片 provider 时也有一条 —— 它 available: false 并说出为什么', () => {
    const images = gateway().images
    expect(images?.available).toBe(false)
    expect(images?.unavailable_reason).toBe(NO_IMAGE_MODEL_ZH)
  })

  it('装了「出不了图」那一条：available false + 一句人话', async () => {
    const provider = unavailableImageProvider()
    expect(provider.available).toBe(false)
    expect(provider.unavailable_reason).toBe(NO_IMAGE_MODEL_ZH)
    expect(NO_IMAGE_MODEL_ZH).toContain('生图')
    await expect(
      provider.generate({ prompt: '白底摆台', meta: meta({ purpose: 'run' }) }),
    ).rejects.toMatchObject({ code: 'not_implemented' })
  })

  it('stub：同一 (prompt, size, n, seed) 出同一批字节（26 §模拟替身）', async () => {
    const a = stubImageProvider({ seed: 42 })
    const b = stubImageProvider({ seed: 42 })
    const req = { prompt: '纯白底，产品居中', size: '1080x1080', n: 3, meta: meta() }
    const left = await a.generate(req)
    const right = await b.generate(req)
    expect(left.assets).toHaveLength(3)
    expect(left.assets.map((x) => [...(x.bytes ?? [])].slice(0, 32))).toEqual(
      right.assets.map((x) => [...(x.bytes ?? [])].slice(0, 32)),
    )
  })

  it('stub：三张变体彼此不同（不然挑图卡上看到的是同一张三次）', async () => {
    const out = await stubImageProvider({ seed: 7 }).generate({
      prompt: '实拍摆台',
      size: '1080x1350',
      n: 3,
      meta: meta(),
    })
    const bodies = out.assets.map((x) => Buffer.from(x.bytes ?? new Uint8Array()).toString('hex'))
    expect(new Set(bodies).size).toBe(3)
  })

  it('stub：提示词哈希进 provenance，**提示词原文不进**（58 §1 末行）', async () => {
    const out = await stubImageProvider({ seed: 1 }).generate({
      prompt: '客户 A 的未发布卖点',
      meta: meta(),
    })
    const asset = out.assets[0]
    expect(asset?.prompt_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify({ ...asset, bytes: undefined })).not.toContain('未发布')
  })

  it('stub 挂到网关上之后从 `gateway.images` 取得到', async () => {
    const gw = gateway(stubImageProvider({ seed: 3 }))
    expect(gw.images?.available).toBe(true)
    const out = await gw.images?.generate({ prompt: 'x', size: '512x512', n: 1, meta: meta() })
    expect(out?.assets[0]?.width).toBe(512)
  })

  it('尺寸写不对就按 1024 见方（尺寸是建议不是契约）', () => {
    expect(parseImageSize('1080x1920')).toEqual([1080, 1920])
    expect(parseImageSize(undefined)).toEqual([1024, 1024])
    expect(parseImageSize('大一点')).toEqual([1024, 1024])
  })

  it('出来的真的是一张能解析的 PNG（宽高写在 IHDR 里）', () => {
    const png = placeholderPng(1080, 1920, 'a1b2c3d4e5f6')
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(view.getUint32(16)).toBe(1080)
    expect(view.getUint32(20)).toBe(1920)
    // 纯色块压得很小——3000×600 的旗舰店画布也不拖慢模拟
    expect(placeholderPng(3000, 600, 'ffeeddccbbaa').length).toBeLessThan(40_000)
  })
})
