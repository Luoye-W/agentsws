/**
 * WP33 B 的**传输层**端到端：真的起进程、真的用 WebSocket 连上去。
 *
 * 协议逻辑（订阅 / 过滤 / 限速 / 急停）在 `packages/api/test/ws.test.ts` 里测过了；
 * 这里只验那几件只有真 socket 才能验的事：同一个端口的 upgrade、cookie 与子协议两条鉴权路、
 * token 不进 URL、决定一张卡之后订阅方真能收到 `approval.decided`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-07T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Frame {
  type: string
  name: string
  id?: string
  subject?: { type: string; id: string }
  detail?: Record<string, unknown>
}

let server: Server
let url: string

beforeEach(async () => {
  const clock = makeClock()
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
    // 巡检快一点，测试不用等一秒
    scheduleIntervalMs: 0,
  })
  const started = await server.listen(0)
  url = started.url
})

afterEach(async () => {
  await server.close()
})

const wsUrl = (): string => `${url.replace('http://', 'ws://')}/v1/ws`

/** 连上并收帧，直到 `until` 说够了（或超时）。 */
async function collect(
  socket: WebSocket,
  until: (frames: Frame[]) => boolean,
  timeoutMs = 4000,
): Promise<Frame[]> {
  const frames: Frame[] = []
  return await new Promise<Frame[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`超时，只收到 ${JSON.stringify(frames)}`))
    }, timeoutMs)
    socket.on('message', (raw) => {
      frames.push(JSON.parse(String(raw)) as Frame)
      if (until(frames)) {
        clearTimeout(timer)
        resolve(frames)
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(frames)
    })
  })
}

describe('28 §2 WebSocket 事件流（真 socket）', () => {
  it('子协议带 bearer 连上 → ready；token 不在 URL 里', async () => {
    const socket = new WebSocket(wsUrl(), [
      'agentsws.v1',
      `agentsws.bearer.${server.bootstrap.internalToken}`,
    ])
    await new Promise((r) => socket.once('open', r))
    expect(socket.protocol).toBe('agentsws.v1')
    // 连接地址里没有凭据（20 §3 / 21 §5）
    expect(socket.url).not.toContain(server.bootstrap.internalToken)
    socket.send(
      JSON.stringify({
        op: 'subscribe',
        assignment_id: server.bootstrap.ownerAssignment.id,
      }),
    )
    const frames = await collect(socket, (f) => f.some((x) => x.name === 'ready'))
    const ready = frames.find((f) => f.name === 'ready')
    expect(ready?.type).toBe('CONTROL')
    expect(ready?.detail?.assignment_id).toBe(server.bootstrap.ownerAssignment.id)
    socket.close()
  })

  it('没凭据 → 握手就被拒（401），连不上', async () => {
    const socket = new WebSocket(wsUrl())
    const err = await new Promise<Error>((resolve) => {
      socket.once('error', resolve)
    })
    expect(err.message).toMatch(/401|Unexpected server response/)
  })

  it('会话 cookie 也能连（浏览器那条路）', async () => {
    const socket = new WebSocket(wsUrl(), ['agentsws.v1'], {
      headers: { Cookie: `agentsws_session=${server.bootstrap.internalToken}` },
    })
    await new Promise((r) => socket.once('open', r))
    socket.send(
      JSON.stringify({ op: 'subscribe', assignment_id: server.bootstrap.ownerAssignment.id }),
    )
    const frames = await collect(socket, (f) => f.some((x) => x.name === 'ready'))
    expect(frames.some((f) => f.name === 'ready')).toBe(true)
    socket.close()
  })

  it('新事件进日志 → 订阅方收到摘要（且不含正文）', async () => {
    const socket = new WebSocket(wsUrl(), [
      'agentsws.v1',
      `agentsws.bearer.${server.bootstrap.internalToken}`,
    ])
    await new Promise((r) => socket.once('open', r))
    socket.send(
      JSON.stringify({ op: 'subscribe', assignment_id: server.bootstrap.ownerAssignment.id }),
    )
    const pending = collect(socket, (f) => f.some((x) => x.name === 'approval.decided'))
    // 等 ready 之后再写事件，免得被当成「连接前的历史」
    await new Promise((r) => setTimeout(r, 50))
    await server.kernel.eventLog.append({
      schema_version: 1,
      workspace_id: server.bootstrap.workspace.id,
      type: 'approval.decided',
      actor: { kind: 'person', id: server.bootstrap.person.id },
      subject: { type: 'approval_item', id: 'ap_ws_1' },
      correlation: { trace_id: 'tr_ws' },
      payload: { body: '这段正文不该出现在推送里' },
    })
    const frames = await pending
    const frame = frames.find((f) => f.name === 'approval.decided')
    expect(frame?.type).toBe('STATE')
    expect(frame?.subject).toEqual({ type: 'approval_item', id: 'ap_ws_1' })
    expect(JSON.stringify(frames)).not.toContain('这段正文不该出现在推送里')
    socket.close()
  })

  it('普通 HTTP 打 /v1/ws → 426，并把怎么连说清楚', async () => {
    const res = await fetch(`${url}/v1/ws`)
    expect(res.status).toBe(426)
    const body = (await res.json()) as { data: { protocol: string } }
    expect(body.data.protocol).toBe('agentsws.v1')
  })
})
