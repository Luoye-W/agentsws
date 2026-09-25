/**
 * WP127：文字模型必须能看图——契约这一侧的三样东西。
 */
import { describe, expect, it } from 'vitest'
import {
  type ModelProvider,
  modelFailureKind,
  NO_VISION_REASON,
  VISION_MODEL_EXAMPLES,
} from '../src/index.js'

describe('WP127 模型能力', () => {
  it('看不了图是单独一档，不混进"认不出来"', () => {
    expect(modelFailureKind({ reason: NO_VISION_REASON })).toBe('vision')
    // 原文里提到 image 也不会被误判成别的档：码优先
    expect(modelFailureKind({ reason: NO_VISION_REASON, detail: 'HTTP 404 image_url' })).toBe(
      'vision',
    )
    // 老五档不受影响
    expect(modelFailureKind({ reason: 'no_key' })).toBe('key')
    expect(modelFailureKind({ detail: 'HTTP 401 unauthorized' })).toBe('key')
    expect(modelFailureKind({ detail: 'something odd' })).toBe('other')
  })

  it('WP150：unauthenticated（账号登录失效 / 没登录）归"凭据"那一档', () => {
    expect(
      modelFailureKind({ reason: 'unauthenticated', detail: '没通：DeepSeek 账号的登录过期了' }),
    ).toBe('key')
  })

  it('能力声明是可选的：老 provider 不改一行照样合法', () => {
    const old: ModelProvider = {
      ref: { provider: 'x', model: 'y' },
      complete: () =>
        Promise.resolve({
          text: '',
          usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
        }),
    }
    expect(old.capabilities).toBeUndefined()
    const declared: ModelProvider = {
      ...old,
      capabilities: { vision: true, image_generation: false },
    }
    expect(declared.capabilities?.vision).toBe(true)
  })

  it('常见能看图的型号名：只是公开型号名，不空、不重复', () => {
    expect(VISION_MODEL_EXAMPLES.length).toBeGreaterThan(3)
    expect(new Set(VISION_MODEL_EXAMPLES).size).toBe(VISION_MODEL_EXAMPLES.length)
    for (const name of VISION_MODEL_EXAMPLES) expect(name).toMatch(/^[a-z0-9][a-z0-9.-]+$/)
  })
})
