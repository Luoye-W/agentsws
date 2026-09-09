/**
 * WP33 B 的工作台一侧：**收到 `approval.decided` 摘要 → deck 刷新**（不靠轮询）。
 *
 * 两层各测一遍：
 * - `connectRealtime` 本身（假 socket）：订阅、失效映射、重连带 since、退回轮询；
 * - 装到界面上（真 QueryClient + DeckSection）：一帧摘要进来，卡片列表就重取一次。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { CardsData } from '@/lib/api'
import { AppProvider } from '@/lib/app-context'
import { connectRealtime, keysFor, type RealtimeSocket } from '@/lib/realtime'
import { draftCard } from './fixtures'

/** 手动驱动的假 socket：测试自己决定什么时候 open、什么时候来帧、什么时候断。 */
class FakeSocket implements RealtimeSocket {
  static readonly opened: FakeSocket[] = []
  readonly sent: string[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.opened.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.({})
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop(): void {
    this.onclose?.({})
  }
}

function connect(client: QueryClient, token?: string) {
  FakeSocket.opened.length = 0
  const timers: (() => void)[] = []
  const handle = connectRealtime({
    client,
    assignment: 'asg_1',
    token,
    socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    setTimeoutFn: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimeoutFn: () => undefined,
  })
  const socket = (): FakeSocket => {
    const s = FakeSocket.opened[FakeSocket.opened.length - 1]
    if (s === undefined) throw new Error('还没有连接')
    return s
  }
  return { handle, socket, timers }
}

describe('事件类型 → 要失效的查询', () => {
  it('审批类刷卡片与首页；定时类刷定时；无关的什么都不刷', () => {
    expect(keysFor('approval.decided')).toEqual(
      expect.arrayContaining([['deck'], ['home'], ['matter']]),
    )
    expect(keysFor('schedule.fired')).toEqual(expect.arrayContaining([['schedules']]))
    expect(keysFor('model.usage')).toEqual([])
    // 运行中的每一帧都刷会把首页刷爆：只认 run.completed / run.failed
    expect(keysFor('text.delta')).toEqual([])
    expect(keysFor('run.completed')).toEqual(expect.arrayContaining([['deck'], ['home']]))
  })
})

describe('connectRealtime', () => {
  it('连上就发 subscribe，带当前岗位（31 §3.1）', () => {
    const client = new QueryClient()
    const { socket } = connect(client)
    socket().open()
    expect(JSON.parse(socket().sent[0] ?? '{}')).toEqual({
      op: 'subscribe',
      assignment_id: 'asg_1',
    })
  })

  it('有 bearer 就放子协议头，没有就只报子协议（靠 cookie）——token 不进 URL', () => {
    const client = new QueryClient()
    const withToken = connect(client, 'sess_abc')
    expect(withToken.socket().protocols).toEqual(['agentsws.v1', 'agentsws.bearer.sess_abc'])
    expect(withToken.socket().url).not.toContain('sess_abc')
    withToken.handle.stop()

    const cookieOnly = connect(client)
    expect(cookieOnly.socket().protocols).toEqual(['agentsws.v1'])
  })

  it('收到摘要 → 对应的查询被失效', () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    const { socket } = connect(client)
    socket().open()
    socket().emit({
      type: 'STATE',
      id: 'evt_1',
      name: 'approval.decided',
      at: '2026-09-07T09:00:00.000Z',
      subject: { type: 'approval_item', id: 'ap_1' },
    })
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(['deck']))
    expect(keys).toContain(JSON.stringify(['home']))
  })

  it('重连带 since（断线期间的那些补拉回来）', () => {
    const client = new QueryClient()
    const { socket, timers } = connect(client)
    socket().open()
    socket().emit({ type: 'STATE', id: 'evt_9', name: 'approval.claimed', at: 'x' })
    socket().drop()
    // 退避之后重连
    expect(timers).toHaveLength(1)
    timers[0]?.()
    socket().open()
    expect(JSON.parse(socket().sent[0] ?? '{}')).toEqual({
      op: 'subscribe',
      assignment_id: 'asg_1',
      since: 'evt_9',
    })
  })

  it('服务端说丢了帧 → 整体重取一次（视图可能不全）', () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    const { socket } = connect(client)
    socket().open()
    socket().emit({ type: 'CONTROL', name: 'dropped', at: 'x', detail: { count: 3 } })
    expect(invalidate).toHaveBeenCalledWith()
  })

  it('浏览器没有 / 拦了 WebSocket → offline，退回原来的失效重取，不抛错', () => {
    const client = new QueryClient()
    const handle = connectRealtime({
      client,
      assignment: 'asg_1',
      socketFactory: () => {
        throw new Error('被拦了')
      },
    })
    expect(handle.status()).toBe('offline')
    handle.stop()
  })
})

describe('装到界面上', () => {
  it('收到 approval.decided 摘要 → deck 重新取一次卡片', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    let calls = 0
    const cards = (): CardsData => ({
      position: {
        position_id: 'asg_1',
        role_id: 'dtc.aftersales',
        role_name: '独立站售后客服',
        ranges: [],
        ready: true,
        missing_connectors: [],
        tile_ids: [],
        range: 'yesterday',
        show_tiles: true,
      },
      cards: [draftCard({ title: calls === 0 ? '第一次取到的' : '刷新之后的' })],
      filters: {},
      counts: { total: 1, customer_waiting: 0, nobody_waiting: 0, matched: 1 },
      pinned_p0: [],
    })
    vi.doMock('@/lib/api', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
      return {
        ...actual,
        getPositionCards: async () => {
          const out = cards()
          calls += 1
          return out
        },
      }
    })
    const { DeckSection } = await import('@/components/deck')

    const wrap = (ui: ReactNode): ReactNode => (
      <QueryClientProvider client={client}>
        <AppProvider initialTheme="light" initialLang="zh" initialPosition="asg_1">
          <MemoryRouter>{ui}</MemoryRouter>
        </AppProvider>
      </QueryClientProvider>
    )
    render(wrap(<DeckSection positionId="asg_1" onOpen={() => undefined} />))
    await screen.findByText('第一次取到的')
    // 只取过一次：接下来那次一定是推送引起的，不是 React 自己多渲染了一遍
    expect(calls).toBe(1)

    const { socket } = connect(client)
    socket().open()
    socket().emit({
      type: 'STATE',
      id: 'evt_1',
      name: 'approval.decided',
      at: '2026-09-07T09:00:00.000Z',
      subject: { type: 'approval_item', id: 'ap_1' },
    })
    await waitFor(() => {
      expect(screen.getByText('刷新之后的')).toBeTruthy()
    })
    vi.doUnmock('@/lib/api')
  })
})
