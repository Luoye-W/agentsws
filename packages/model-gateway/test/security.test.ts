import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GatewayError, openaiCompatibleProvider } from '../src/index.js'

const srcDir = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

describe('22 §5.1 业务代码里 grep 不到 provider key', () => {
  const files = walk(srcDir)

  it('源码里没有任何 provider key 字面量', () => {
    const keyLike = /(?<![A-Za-z])(sk|xai|gsk|ak)-[A-Za-z0-9_-]{4,}/
    const offenders = files.filter((f) => keyLike.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('源码里出现的 Bearer 只来自变量插值，没有硬编码值', () => {
    const hardCoded = /Bearer\s+[A-Za-z0-9_-]{8,}/
    const offenders = files.filter((f) => hardCoded.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('凭据只从环境变量名读取；变量缺失即拒绝调用', async () => {
    const provider = openaiCompatibleProvider({
      apiKeyEnv: 'AGENTSWS_TEST_DEEPSEEK_KEY',
      model: 'deepseek-chat',
      env: {},
      fetch: () => {
        throw new Error('must not reach network')
      },
    })
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { env_var: 'AGENTSWS_TEST_DEEPSEEK_KEY' },
    })
    await expect(provider.complete({ messages: [] })).rejects.toBeInstanceOf(GatewayError)
  })
})
