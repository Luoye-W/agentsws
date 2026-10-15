/**
 * WP334（决策 724 / 725）端到端：真服务进程（落盘档 + 真网关 + stub 运行时）+ 企业微信长连接的内存替身，一行网都不出。
 *
 * 1. 任务里 AI 发现要先连上企业微信 → 自己调 `request_setup` → 这一轮收尾出**连接卡**（卡面是 AI 那句为什么）、停下；
 *    第二件事撞上同一缺项 → 不再出新卡、挂到同一张上；
 * 2. 人在卡上的本机表单填好企业微信（BotID + Secret 直接打 `/v1/im/wecom`）→ 长连接连上 → 服务端复查 →
 *    卡自己收起、两件事都按原话接着做（只做一次）；接着跑时 AI 再问一次，工具说「已经连上了」；
 * 3. **口令永不进 AI 上下文**：Secret 不在事件日志、时间线、卡的载荷里，也不在落盘档的任何一个文件里（明文）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WecomSocket } from '@agentsws/channels'
import type { ApprovalItem, ConnectRequestPayload } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

/** 企业微信的内存长连接。 */
class FakeSocket implements WecomSocket {
  readonly sent: Record<string, unknown>[] = []
  closed = false
  #h: Record<string, ((a: never) => void)[]> = {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
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

/** 填进本机表单的那把（只在这一个测试里；断言它哪儿都不出现）。 */
const SECRET = 'WECOM-SECRET-7f3a9c2e4b8d1f60'

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const waitFor = async (fn: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等不到：${what}`)
}

/** 落盘档里每个文件的字节里有没有这一串（明文）。 */
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

describe('WP334 AI 自己要连接卡（stub，企业微信）', () => {
  it('AI 要卡 → 出卡停下、去重 → 卡上填好连上 → 两件事接着做；Secret 哪儿都没有', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp334-setup-'))
    dirs.push(dbDir)
    const sockets: FakeSocket[] = []
    server = await createServer({
      dbDir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
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
    const call = async (method: string, path: string, body?: unknown) =>
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
    type Tl = { kind: string; text: string; approval_item_id?: string; blocked?: unknown }[]
    const timeline = async (m: string): Promise<Tl> =>
      (await dataOf<{ timeline: Tl }>(await call('GET', `/v1/matters/${m}`))).timeline
    const queue = async (): Promise<ApprovalItem[]> =>
      s.txn.approvals.queue({
        workspace_id: s.bootstrap.workspace.id,
        person_id: s.bootstrap.person.id,
        lane: 'mine',
      })
    const newMatter = async (title: string) =>
      dataOf<{ matter: { id: string } }>(
        await call('POST', `/v1/positions/${owner}/matters`, { title, role_id: 'common.owner' }),
      )

    // ① AI 发现要先连企业微信 → 自己要卡 → 出卡停下
    const a = await newMatter('先连上企业微信，再把今天的待办发到群里')
    await waitFor(async () => (await queue()).some((c) => c.kind === 'connect_request'), '连接卡')
    const b = await newMatter('帮我接上企业微信，以后日报发群里')
    await waitFor(
      async () => (await timeline(b.matter.id)).some((e) => e.blocked !== undefined),
      '第二件事卡住',
    )
    const cards = (await queue()).filter((c) => c.kind === 'connect_request')
    expect(cards).toHaveLength(1)
    const card = cards[0] as ApprovalItem<ConnectRequestPayload>
    expect(card.payload.why).toBe('这件事要先连上它才做得下去。')
    expect(card.payload.needs).toEqual([
      { kind: 'im:wecom', service: 'im:wecom', name: '企业微信', required: true },
    ])
    for (const m of [a.matter.id, b.matter.id]) {
      const tl = await timeline(m)
      expect(tl.find((e) => e.blocked !== undefined)?.blocked).toMatchObject({ card_id: card.id })
      expect(tl.some((e) => e.kind === 'agent_message' && /下面这张卡/.test(e.text))).toBe(true)
      expect(tl.filter((e) => e.kind === 'card' && e.approval_item_id === card.id)).toHaveLength(1)
    }

    // ② 卡上的本机表单（同消息渠道页那一张）：BotID + Secret 直接打 /v1/im/wecom
    expect((await call('PUT', '/v1/im/wecom', { bot_id: 'BOT1', secret: SECRET })).status).toBe(200)
    await waitFor(() => sockets.length > 0, '长连接')
    sockets[0]?.emit('open', undefined)
    sockets[0]?.emit('message', JSON.stringify({ cmd: 'aibot_subscribe', errcode: 0 }))
    // 连上 → 服务端复查 → 卡自己收起、两件事都按原话接着做
    for (const m of [a.matter.id, b.matter.id])
      await waitFor(
        async () =>
          (await timeline(m)).some(
            (e) => e.kind === 'agent_message' && /企业微信已经连上了/.test(e.text),
          ),
        `接着做：${m}`,
      )
    expect((await s.txn.approvals.get(card.id))?.state).toBe('withdrawn')
    for (const m of [a.matter.id, b.matter.id]) {
      const runs = (await timeline(m)).filter((e) => e.kind === 'run')
      expect(runs.map((e) => e.text)).toContain('连好了，接着做')
      // 只接着做一次
      expect(runs.filter((e) => e.text === '连好了，接着做')).toHaveLength(1)
    }
    expect((await queue()).filter((c) => c.kind === 'connect_request')).toHaveLength(0)

    // ③ 口令永不进 AI 上下文：事件日志、时间线、卡里都没有，落盘档里也没有明文
    const events = JSON.stringify(
      s.kernel.eventLog.readSync({ workspace_id: s.bootstrap.workspace.id }),
    )
    expect(events).not.toContain(SECRET)
    for (const m of [a.matter.id, b.matter.id])
      expect(JSON.stringify(await timeline(m))).not.toContain(SECRET)
    expect(JSON.stringify(await s.txn.approvals.get(card.id))).not.toContain(SECRET)
    expect(filesContaining(dbDir, SECRET)).toEqual([])
  })
})
