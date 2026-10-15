/**
 * WP341（决策 814 / 847）端到端：对话里的表单带一格口令——值**只**走本机原生表单那条路进加密库，AI 只收到「已填好」。
 *
 * 真服务进程（落盘档 + 真网关 + 随便聊的模型网关，上游 HTTP 是回放）+ 企业微信长连接的内存替身，一行网都不出。
 * 1. AI 在随便聊里回一张表（BotID + Secret + 提交）；过滤后 Secret 那格是宿主的口令格（绑 `im:wecom`）；
 * 2. 人在口令格里填（工作台画的就是消息渠道页那张本机表单：直接打 `/v1/im/wecom`）→ 连上；
 * 3. 人交表：对话里多一条结构化回话（BotID + 「Secret：已填好」），随便聊和事项线程各发一次；
 * 4. Secret 不在事件日志、时间线、给模型的输入、随便聊存的话里，落盘档每个文件的字节里也没有。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeChatSessionView } from '@agentsws/api'
import type { WecomSocket } from '@agentsws/channels'
import { filterGenuiSpec, genuiNodes, resolveGenuiAction } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const SECRET = 'WECOM-SECRET-wp341-9a7c3e1f'

const FORM = {
  items: [
    { type: 'input', id: 'bot_id', label: 'BotID' },
    {
      type: 'input',
      id: 'wecom_secret',
      label: '企业微信 Secret',
      inputType: 'password',
      service: 'im:wecom',
    },
    { type: 'submit', label: '连上' },
  ],
}
const FORM_REPLY = ['填一下这两样就能连上：', '```dsh-ui', JSON.stringify(FORM), '```'].join('\n')

class FakeSocket implements WecomSocket {
  closed = false
  #h: Record<string, ((a: never) => void)[]> = {}
  send(): void {}
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', undefined)
  }
  on(event: string, cb: (a: never) => void): void {
    this.#h[event] = [...(this.#h[event] ?? []), cb]
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.#h[event] ?? []) (cb as (a: unknown) => void)(arg)
  }
}

let server: Server | undefined
const dirs: string[] = []
afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (readFileSync(p).includes(needle)) hits.push(p)
    }
  }
  walk(dir)
  return hits
}

describe('WP341 口令格：值不经 AI', () => {
  it('表单里的口令只进本机加密库；对话里只有「已填好」；哪儿都没有明文', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp341-secret-'))
    dirs.push(dbDir)
    const upstream: string[] = []
    const fetch: FetchLike = async (url, init) => {
      const body = typeof init.body === 'string' ? init.body : ''
      if (url.endsWith('/chat/completions')) upstream.push(body)
      const text =
        body.includes('帮我接企业微信') && !body.includes('已填好') ? FORM_REPLY : '好，连上了。'
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`
      const json = url.endsWith('/models')
        ? { object: 'list', data: [{ id: 'deepseek-flash' }] }
        : {
            choices: [{ message: { content: text } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }
      return {
        ok: true,
        status: 200,
        json: async () => json,
        text: async () => (body.includes('"stream":true') ? sse : JSON.stringify(json)),
      }
    }
    const sockets: FakeSocket[] = []
    server = await createServer({
      dbDir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
      modelFetch: fetch,
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      liveDataIntervalMs: 0,
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      imTransports: {
        wecomSocket: () => {
          const s = new FakeSocket()
          sockets.push(s)
          return s
        },
      },
    })
    const s = server
    const owner = s.bootstrap.ownerAssignment.id
    const call = (method: string, path: string, body?: unknown) =>
      s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${s.bootstrap.internalToken}`,
            'X-Assignment': owner,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
    expect(
      (
        await call('PUT', '/v1/models/providers/deepseek', {
          kind: 'deepseek',
          model: 'deepseek-flash',
          api_key: 'sk-wp341-test-0001',
        })
      ).status,
    ).toBe(200)

    // ① AI 回一张表；过滤后 Secret 那格是宿主的口令格
    const session = await dataOf<FreeChatSessionView>(
      await call('POST', '/v1/free-chat/sessions', {}),
    )
    await (
      await call('POST', `/v1/free-chat/sessions/${session.id}/messages`, {
        text: '帮我接企业微信',
      })
    ).text()
    const said = await dataOf<{ role: string; text: string }[]>(
      await call('GET', `/v1/free-chat/sessions/${session.id}/messages`),
    )
    const body = /```dsh-ui\n([\s\S]*?)\n```/u.exec(said.at(-1)?.text ?? '')?.[1] ?? ''
    const spec = filterGenuiSpec(JSON.parse(body)).spec
    if (spec === undefined) throw new Error('没画出来')
    expect(genuiNodes(spec).find((n) => n.id === 'wecom_secret')).toEqual({
      type: 'ws-secret',
      id: 'wecom_secret',
      label: '企业微信 Secret',
      service: 'im:wecom',
    })

    // ② 口令格里填：就是消息渠道页那张本机表单（直接打 /v1/im/wecom）
    expect((await call('PUT', '/v1/im/wecom', { bot_id: 'BOT1', secret: SECRET })).status).toBe(200)
    sockets[0]?.emit('open', undefined)
    sockets[0]?.emit('message', JSON.stringify({ cmd: 'aibot_subscribe', errcode: 0 }))

    // ③ 交表：一条结构化回话（插件的提交收不到口令格的值；宿主只记「已填好」）
    const out = resolveGenuiAction(
      spec,
      'submit',
      { type: 'submit', answers: {}, fields: { bot_id: 'BOT1' }, total: 0, answered: 1 },
      ['企业微信 Secret'],
    )
    if (out.kind !== 'reply') throw new Error(out.kind)
    expect(out.text).toContain('企业微信 Secret：已填好')
    upstream.length = 0
    await (
      await call('POST', `/v1/free-chat/sessions/${session.id}/messages`, { text: out.text })
    ).text()
    expect(upstream.some((b) => b.includes('已填好'))).toBe(true)
    // 事项线程里同样交一次
    const m = await dataOf<{ matter: { id: string } }>(
      await call('POST', `/v1/positions/${owner}/matters`, {
        title: '接企业微信',
        role_id: 'common.owner',
      }),
    )
    expect(
      (await call('POST', `/v1/matters/${m.matter.id}/messages`, { text: out.text })).status,
    ).toBe(201)
    const timeline = JSON.stringify(await dataOf(await call('GET', `/v1/matters/${m.matter.id}`)))
    expect(timeline).toContain('已填好')
    await new Promise((r) => setTimeout(r, 200))

    // ④ 哪儿都没有明文
    expect(upstream.join('\n')).not.toContain(SECRET)
    expect(timeline).not.toContain(SECRET)
    const listed = JSON.stringify(
      await dataOf(await call('GET', `/v1/free-chat/sessions/${session.id}/messages`)),
    )
    expect(listed).not.toContain(SECRET)
    expect(
      JSON.stringify(s.kernel.eventLog.readSync({ workspace_id: s.bootstrap.workspace.id })),
    ).not.toContain(SECRET)
    expect(filesContaining(dbDir, SECRET)).toEqual([])
  })
})
