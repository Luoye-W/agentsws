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
      // 报错里只有"key 从哪儿来"，永远没有值
      details: { source: 'AGENTSWS_TEST_DEEPSEEK_KEY' },
    })
    await expect(provider.complete({ messages: [] })).rejects.toBeInstanceOf(GatewayError)
  })

  /**
   * WP25：设置页填的 key 存在本机加密库里，不在环境变量里，所以 provider 多了一条
   * `apiKey()` 取值回调。这一条盯的是同一件事：**值只在请求那一刻出现一次**，
   * 不进配置对象、不进错误信封，而且改完下一次请求自然是新的。
   */
  it('取值回调档：key 每次现取，报错里只说来源不说值', async () => {
    const KEY = 'sk-vault-only-never-logged-42'
    let current: string | undefined
    let seenAuth = ''
    const provider = openaiCompatibleProvider({
      apiKey: () => current,
      model: 'deepseek-chat',
      env: {},
      fetch: async (_url, init) => {
        seenAuth = init.headers.authorization ?? ''
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '好' } }] }),
          text: async () => '',
        }
      },
    })
    // 还没配 key：拒绝调用，信封里只有 local_vault 这个来源
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { source: 'local_vault' },
    })
    // 配上之后立刻生效——没有重建 provider，也没有重启
    current = KEY
    const done = await provider.complete({ messages: [] })
    expect(done.text).toBe('好')
    expect(seenAuth).toBe(`Bearer ${KEY}`)
    // provider 对象本身不许留着这把 key
    expect(JSON.stringify(provider)).not.toContain(KEY)
  })
})
