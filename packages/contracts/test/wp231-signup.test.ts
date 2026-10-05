/**
 * WP231：注册与登录分开——契约这一层钉住的几条：
 * 条款版本与官网条款页的生效日期一致、条款链接的形状、密码强度分档、新路由在契约表里且老的 magic-link 还在。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LEGAL_TERMS_VERSION,
  legalDocumentUrl,
  passwordStrength,
  SITE_BASE_URL,
} from '../src/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('WP231 注册 / 登录契约', () => {
  it('条款版本 = 官网条款页的生效日期（改条款要两处一起改）', () => {
    const config = readFileSync(join(ROOT, 'apps/site/src/config.ts'), 'utf8')
    const m = /LEGAL_EFFECTIVE_DATE = '([0-9-]+)'/u.exec(config)
    expect(m?.[1]).toBe(LEGAL_TERMS_VERSION)
  })

  it('条款 / 隐私链接：中文在根下、英文在 /en/ 下', () => {
    expect(legalDocumentUrl('terms', 'zh')).toBe(`${SITE_BASE_URL}/terms/`)
    expect(legalDocumentUrl('privacy', 'en')).toBe(`${SITE_BASE_URL}/en/privacy/`)
  })

  it('密码强度：不够 8 位是 0，长度 / 大小写 / 数字 / 符号各加一档', () => {
    expect(passwordStrength('short1!')).toBe(0)
    expect(passwordStrength('abcdefgh')).toBe(1)
    expect(passwordStrength('abcdefgh12')).toBe(2)
    expect(passwordStrength('Abcdefgh12!')).toBe(4)
    expect(passwordStrength('Abcdefghijkl12!')).toBe(4)
  })

  it('契约里有注册、登录两条，老的 magic-link 一条没少（只加不删）', () => {
    const doc = JSON.parse(
      readFileSync(join(ROOT, 'packages/contracts/cloud-openapi.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> }
    for (const path of [
      '/v1/cloud/auth/signup',
      '/v1/cloud/auth/signup/verify',
      '/v1/cloud/auth/otp',
      '/v1/cloud/auth/otp/verify',
      '/v1/cloud/auth/password',
      '/v1/cloud/auth/password/forgot',
      '/v1/cloud/auth/password/reset',
      '/v1/cloud/auth/magic-link',
      '/v1/cloud/auth/verify',
    ])
      expect(doc.paths[path]?.post, path).toBeDefined()
  })
})
