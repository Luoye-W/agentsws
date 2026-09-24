/**
 * WP143：DeepSeek Messages 口的图片走 Files API 复用（照官方 dsh-llm-deepseek@0.1.7-rc.1 移植）。
 *
 * 验收五条：同图两次只上传一次；Files 失败 / 超时整份退 base64 且不混用；file id 过期重传；
 * 模型口说 file id 不认了就作废、重传、只重试一次；令牌 / key 只在请求头，不进日志与错误信封。
 * 上游全是替身（假 Files 口 + 假 Messages 口），不联网、不花钱。
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AccountFetch,
  createModelGateway,
  DeepSeekFileStore,
  deepseekAccountProvider,
  deepseekMessagesProvider,
  type FilesFetch,
  jsonFileUploadIndex,
  MESSAGES_FILES_BETA,
  ProviderError,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

const TOKEN = 'dsk_SECRET_TOKEN_files'
const API_KEY = 'sk-SECRET-KEY-files'
const T0 = Date.parse('2026-09-24T00:00:00Z')

/** 两张"图"：内容不同的几个字节就够（网关不解码图片）。 */
const IMG_A = Buffer.from('fake-png-A-0123456789').toString('base64')
const IMG_B = Buffer.from('fake-png-B-9876543210').toString('base64')

const withImages = (...images: string[]): ChatMessage[] => [
  {
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      ...images.map((data) => ({ type: 'image' as const, mime: 'image/png', data })),
    ],
  },
]

interface Upload {
  url: string
  headers: Record<string, string>
  redirect: string
  size: number
  filename: string
}

/** 假 Files 口：按调用次序发 id；`fail` 让第 n 次（从 1 数）失败；`hang` 让它一直不回。 */
function fakeFiles(
  clock: { now: number },
  opts: { fail?: (n: number) => boolean; hang?: boolean } = {},
) {
  const uploads: Upload[] = []
  let n = 0
  const fetch: FilesFetch = async (url, init) => {
    n += 1
    const file = init.body.get('file') as File
    uploads.push({
      url,
      headers: init.headers,
      redirect: init.redirect,
      size: file.size,
      filename: file.name,
    })
    if (opts.hang === true) {
      await new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      )
    }
    if (opts.fail?.(n) === true) {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => JSON.stringify({ error: { type: 'server_error', message: 'boom' } }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: `file-${n}`,
        type: 'file',
        mime_type: file.type,
        size_bytes: file.size,
        created_at: new Date(clock.now).toISOString(),
        filename: file.name,
      }),
      text: async () => '',
    }
  }
  return { fetch, uploads }
}

interface Sent {
  headers: Record<string, string>
  body: string
  sources: { type: string; file_id?: string; data?: string }[]
}

/** 假 Messages 口：记下每次请求里图片的来源；`reject` 返回非空时按它回 4xx。 */
function fakeMessages(reject?: (sent: Sent, n: number) => string | undefined) {
  const sent: Sent[] = []
  const fetch: AccountFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as {
      messages: { content: { type: string; source?: Sent['sources'][number] }[] }[]
    }
    const sources = req.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'image' && b.source !== undefined ? [b.source] : [])),
    )
    const one = { headers: init.headers, body: init.body, sources }
    sent.push(one)
    const detail = reject?.(one, sent.length)
    if (detail !== undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => JSON.stringify({ error: { type: 'not_found_error', message: detail } }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '看到了' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      text: async () => '',
    }
  }
  return { fetch, sent }
}

const signedIn = async (): Promise<string | undefined> => TOKEN

function setup(opts: Parameters<typeof fakeFiles>[1] = {}, filesTimeoutMs?: number) {
  const clock = { now: T0 }
  const files = fakeFiles(clock, opts)
  const store = new DeepSeekFileStore({ fetch: files.fetch, now: () => clock.now })
  const messages = fakeMessages()
  const provider = deepseekAccountProvider({
    resolveToken: signedIn,
    fetch: messages.fetch,
    files: store,
    ...(filesTimeoutMs === undefined ? {} : { filesTimeoutMs }),
  })
  return { clock, files, store, messages, provider }
}

describe('WP143 Files 复用：同一张图只传一次', () => {
  it('同图两次请求只上传一次；带 file id 时有 beta 头，请求里没有 base64', async () => {
    const { files, messages, provider } = setup()
    await provider.complete({ messages: withImages(IMG_A) })
    await provider.complete({ messages: withImages(IMG_A) })
    expect(files.uploads).toHaveLength(1)
    const up = files.uploads[0]
    expect(up?.url).toBe('https://api.deepseek.com/anthropic/v1/files')
    expect(up?.headers['x-dsh-auth-token']).toBe(TOKEN)
    expect(up?.headers['anthropic-beta']).toBe(MESSAGES_FILES_BETA)
    expect(up?.headers.authorization).toBeUndefined()
    expect(up?.redirect).toBe('error')
    expect(up?.filename).toMatch(/^agentsws-[0-9a-f]{16}\.png$/)
    for (const s of messages.sent) {
      expect(s.sources).toEqual([{ type: 'file', file_id: 'file-1' }])
      expect(s.headers['anthropic-beta']).toBe(MESSAGES_FILES_BETA)
      expect(s.body).not.toContain(IMG_A)
    }
  })

  it('同一请求里同一张图出现两次、并发两次请求：都只传一次', async () => {
    const { files, provider } = setup()
    const history: ChatMessage[] = [
      ...withImages(IMG_A),
      { role: 'assistant', content: '收到' },
      ...withImages(IMG_A, IMG_B),
    ]
    await Promise.all([
      provider.complete({ messages: history }),
      provider.complete({ messages: history }),
    ])
    expect(files.uploads).toHaveLength(2)
  })

  it('没有图：一个 Files 请求都不发，也不带 beta 头', async () => {
    const { files, messages, provider } = setup()
    await provider.complete({ messages: [{ role: 'user', content: '在吗' }] })
    expect(files.uploads).toHaveLength(0)
    expect(messages.sent[0]?.headers['anthropic-beta']).toBeUndefined()
  })

  it('注入了 fetch 替身但没给 store：Files 关掉，图照旧内联（替身不会把上传漏到真网络）', async () => {
    const messages = fakeMessages()
    const p = deepseekAccountProvider({ resolveToken: signedIn, fetch: messages.fetch })
    await p.complete({ messages: withImages(IMG_A) })
    expect(messages.sent[0]?.sources[0]?.type).toBe('base64')
  })
})

describe('WP143 Files 失败：整份退回内联 base64，一次请求绝不混用', () => {
  it('两张图里第二张上传失败：两张都内联，没有 file 源，没有 beta 头', async () => {
    const { messages, provider } = setup({ fail: (n) => n === 2 })
    await provider.complete({ messages: withImages(IMG_A, IMG_B) })
    const s = messages.sent[0]
    expect(s?.sources.map((x) => x.type)).toEqual(['base64', 'base64'])
    expect(s?.headers['anthropic-beta']).toBeUndefined()
  })

  it('上传超时：整份内联，请求照常发出', async () => {
    const { messages, provider } = setup({ hang: true }, 20)
    const out = await provider.complete({ messages: withImages(IMG_A) })
    expect(out.text).toBe('看到了')
    expect(messages.sent[0]?.sources).toEqual([
      { type: 'base64', media_type: 'image/png', data: IMG_A },
    ])
  })
})

describe('WP143 file id 过期 / 不认了：重传', () => {
  it('复用期快到了（剩不到 1 小时）就换一个新 id', async () => {
    const { clock, files, messages, provider } = setup()
    await provider.complete({ messages: withImages(IMG_A) })
    clock.now += (7 * 24 - 1) * 3600 * 1000 + 1
    await provider.complete({ messages: withImages(IMG_A) })
    expect(files.uploads).toHaveLength(2)
    expect(messages.sent.map((s) => s.sources[0]?.file_id)).toEqual(['file-1', 'file-2'])
  })

  it('模型口回 404 点名 file-1：作废、重传、只重试一次就成', async () => {
    const clock = { now: T0 }
    const files = fakeFiles(clock)
    const store = new DeepSeekFileStore({ fetch: files.fetch, now: () => clock.now })
    const messages = fakeMessages((s) =>
      s.sources[0]?.file_id === 'file-1' ? 'File not found: file-1' : undefined,
    )
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      files: store,
    })
    const out = await p.complete({ messages: withImages(IMG_A) })
    expect(out.text).toBe('看到了')
    expect(messages.sent.map((s) => s.sources[0]?.file_id)).toEqual(['file-1', 'file-2'])
    // 下一次直接用新 id，不再传
    await p.complete({ messages: withImages(IMG_A) })
    expect(files.uploads).toHaveLength(2)
  })

  it('重传之后还说不认：不再无限重试，抛出上游错误', async () => {
    const { files, store } = setup()
    const messages = fakeMessages(() => 'file_id expired')
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      files: store,
    })
    const err = await p.complete({ messages: withImages(IMG_A) }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(messages.sent).toHaveLength(2)
    expect(files.uploads).toHaveLength(2)
  })

  it('别的 4xx（不是 file id 的事）不重试', async () => {
    const { store } = setup()
    const messages = fakeMessages(() => 'insufficient balance')
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      files: store,
    })
    await expect(p.complete({ messages: withImages(IMG_A) })).rejects.toBeInstanceOf(ProviderError)
    expect(messages.sent).toHaveLength(1)
  })
})

describe('WP143 凭据：令牌 / key 只在请求头', () => {
  it('API key 这一路：上传与模型请求都走 x-api-key，不出现 x-dsh-auth-token', async () => {
    const clock = { now: T0 }
    const files = fakeFiles(clock)
    const messages = fakeMessages()
    const p = deepseekMessagesProvider({
      credential: { kind: 'api_key', apiKey: () => API_KEY },
      fetch: messages.fetch,
      files: new DeepSeekFileStore({ fetch: files.fetch, now: () => clock.now }),
    })
    expect(p.ref.provider).toBe('deepseek')
    await p.complete({ messages: withImages(IMG_A) })
    expect(files.uploads[0]?.headers['x-api-key']).toBe(API_KEY)
    expect(files.uploads[0]?.headers['x-dsh-auth-token']).toBeUndefined()
    expect(messages.sent[0]?.headers['x-api-key']).toBe(API_KEY)
    expect(messages.sent[0]?.body).not.toContain(API_KEY)
  })

  it('API key 取不到：当场失败，Files 与模型口一个请求都不发', async () => {
    const { files, messages } = setup()
    const p = deepseekMessagesProvider({
      credential: { kind: 'api_key', apiKey: () => undefined },
      fetch: messages.fetch,
      files: new DeepSeekFileStore({ fetch: files.fetch }),
    })
    await expect(p.complete({ messages: withImages(IMG_A) })).rejects.toThrow(/missing api key/)
    expect(files.uploads).toHaveLength(0)
    expect(messages.sent).toHaveLength(0)
  })

  it('上传失败与模型报错：错误信封、网关事件里都没有令牌', async () => {
    const clock = { now: T0 }
    const files = fakeFiles(clock, { fail: () => true })
    const messages = fakeMessages(() => 'file_id expired')
    const rec = recorder()
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      files: new DeepSeekFileStore({ fetch: files.fetch }),
      provider: 'deepseek-account',
    })
    const gateway = createModelGateway({
      providers: [p],
      policy: policy({
        default: p.ref,
        prices: { 'deepseek-account/deepseek-flash': { in: 0, out: 0, cached: 0 } },
      }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const err = await gateway
      .complete({ messages: withImages(IMG_A), meta: meta() })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(JSON.stringify(err)).not.toContain(TOKEN)
    expect(String((err as Error).message)).not.toContain(TOKEN)
    expect(JSON.stringify(rec.events)).not.toContain(TOKEN)
  })

  it('落本机的索引：0600、只有哈希与 file id，换一个 store 读回来照样复用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp143-'))
    const path = join(dir, 'deepseek-files.json')
    const clock = { now: T0 }
    const files = fakeFiles(clock)
    const storeOf = () =>
      new DeepSeekFileStore({
        fetch: files.fetch,
        now: () => clock.now,
        index: jsonFileUploadIndex(path),
      })
    const messages = fakeMessages()
    const run = (store: DeepSeekFileStore) =>
      deepseekAccountProvider({
        resolveToken: signedIn,
        fetch: messages.fetch,
        files: store,
      }).complete({ messages: withImages(IMG_A) })
    await run(storeOf())
    await run(storeOf())
    expect(files.uploads).toHaveLength(1)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('file-1')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(IMG_A)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('WP143 用量：上传不另记账；同一张图第二次引用的请求体对比', () => {
  it('两次带图的调用只记两笔模型账；第二次请求体比内联小（估算写进报告）', async () => {
    // 一张 ~200 KB 的"图"：第二次引用时内联要再带一遍 base64，file id 只要几十字节
    const big = Buffer.alloc(200 * 1024, 7).toString('base64')
    const { files, messages, provider } = setup()
    const inline = fakeMessages()
    const inlineProvider = deepseekAccountProvider({ resolveToken: signedIn, fetch: inline.fetch })
    const rec = recorder()
    const gateway = createModelGateway({
      providers: [provider],
      policy: policy({
        default: provider.ref,
        prices: { 'deepseek-account/deepseek-flash': { in: 1, out: 2, cached: 0.1 } },
      }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    for (let i = 0; i < 2; i++) {
      await gateway.complete({ messages: withImages(big), meta: meta() })
      await inlineProvider.complete({ messages: withImages(big) })
    }
    expect(files.uploads).toHaveLength(1)
    const usage = await gateway.usage({ workspace_id: 'ws_1' })
    expect(usage.calls).toBe(2)
    const fileBody = messages.sent[1]?.body.length ?? 0
    const inlineBody = inline.sent[1]?.body.length ?? 0
    expect(inlineBody - fileBody).toBeGreaterThan(big.length - 200)
    expect(fileBody).toBeLessThan(1024)
  })
})
