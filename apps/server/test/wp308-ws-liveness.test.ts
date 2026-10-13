/**
 * WP308（决策 451）：钉钉 / 企业微信长连接判死——用**真 `ws`**（`wsSocketFactory`）对一个本机「不吭声」的
 * 长连接做对照（127.0.0.1 随机端口，一行外网都不出）：收下连接、握手照常，之后 ping 一个都不回
 * （上游断了、本地这头不 close 的样子，与飞书 WP306 那个洞同一类）。
 */
import type { AddressInfo } from 'node:net'
import {
  DingtalkBotAdapter,
  type DingtalkHttp,
  MemoryRawStore,
  WecomBotAdapter,
} from '@agentsws/channels'
import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { wsSocketFactory } from '../src/im-sdk.js'

const clock = { now: () => new Date().toISOString() }

async function silentServer(opts: { wecomSubscribe?: boolean } = {}) {
  // autoPong: false = WebSocket 层的 ping 也不回
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false })
  const box = { accepted: 0 }
  wss.on('connection', (socket) => {
    box.accepted += 1
    socket.on('message', (data) => {
      const f = JSON.parse(String(data)) as { cmd?: string }
      // 企业微信：订阅照常回成功，之后的心跳一个都不回
      if (opts.wecomSubscribe === true && f.cmd === 'aibot_subscribe')
        socket.send(JSON.stringify({ cmd: 'aibot_subscribe', errcode: 0, errmsg: 'ok' }))
    })
  })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  const close = async () => {
    for (const c of wss.clients) c.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
  return { box, port, close }
}

async function watch(states: string[], ms: number): Promise<void> {
  const until = Date.now() + ms
  const back = () => {
    const down = states.indexOf('reconnecting')
    return down >= 0 && states.lastIndexOf('connected') > down
  }
  while (Date.now() < until && !back()) await new Promise((r) => setTimeout(r, 20))
}

async function runDingtalk(keepalive_ms: number, watchMs: number) {
  const srv = await silentServer()
  const http: DingtalkHttp = async () => ({
    status: 200,
    json: async () => ({ endpoint: `ws://127.0.0.1:${srv.port}/connect`, ticket: 'T' }),
  })
  const states: string[] = []
  const adapter = new DingtalkBotAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    workspace_id: 'ws_1',
    credentials: () => ({ client_id: 'c', client_secret: 's' }),
    socket: wsSocketFactory,
    http,
    backoff_ms: [50],
    keepalive_ms,
    on_state: (s) => states.push(s),
    on_error: () => {},
  })
  try {
    await adapter.start(async () => {})
    await watch(states, watchMs)
    return { states, accepted: srv.box.accepted }
  } finally {
    await adapter.stop()
    await srv.close()
  }
}

async function runWecom(heartbeat_ms: number, watchMs: number) {
  const srv = await silentServer({ wecomSubscribe: true })
  const states: string[] = []
  let n = 0
  const adapter = new WecomBotAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    workspace_id: 'ws_1',
    credentials: () => ({ bot_id: 'B', secret: 'S' }),
    socket: wsSocketFactory,
    url: `ws://127.0.0.1:${srv.port}`,
    newId: () => `r${++n}`,
    heartbeat_ms,
    backoff_ms: [50],
    on_state: (s) => states.push(s),
    on_error: () => {},
  })
  try {
    await adapter.start(async () => {})
    await watch(states, watchMs)
    return { states, accepted: srv.box.accepted }
  } finally {
    await adapter.stop()
    await srv.close()
  }
}

describe('WP308：真 ws 对照「不吭声」的长连接', () => {
  it('钉钉 对照：不开判死（keepalive 0）→ 1.5 秒里一直「连上」、只建了 1 条连接', async () => {
    const out = await runDingtalk(0, 1_500)
    expect(out.states).toContain('connected')
    expect(out.states).not.toContain('reconnecting')
    expect(out.accepted).toBe(1)
  }, 20_000)

  it('钉钉：ping 不回 pong → 判死、掐掉重连、再连上（状态如实）', async () => {
    const out = await runDingtalk(150, 5_000)
    const down = out.states.indexOf('reconnecting')
    expect(down).toBeGreaterThan(out.states.indexOf('connected'))
    expect(out.states.lastIndexOf('connected')).toBeGreaterThan(down)
    expect(out.accepted).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it('企业微信：心跳不回 → 判死、掐掉重连、重新订阅连上', async () => {
    const out = await runWecom(150, 5_000)
    const down = out.states.indexOf('reconnecting')
    expect(down).toBeGreaterThan(out.states.indexOf('connected'))
    expect(out.states.lastIndexOf('connected')).toBeGreaterThan(down)
    expect(out.accepted).toBeGreaterThanOrEqual(2)
  }, 20_000)
})
