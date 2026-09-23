import { describe, expect, it } from 'vitest'
import { RelayCore } from '../src/core.js'
import { MemoryCounterStore, MemoryOfflineBox } from '../src/index.js'
import { parseClientFrame, type RelayFrame } from '../src/protocol.js'

const NOW = '2026-09-21T10:00:00.000Z'

/**
 * 隐私守卫（docs/72 §6.3 末 + WP124 §E）：**转发器看得到过路内容但不落盘**。
 *
 * 声明需要守卫：把转发器的两个存储口换成「会记下每一个写进来的字符串」的
 * 记录替身，然后跑一整条「访客问 → 对面答 → 打字 → 留言」的过路——
 * 断言存储口上从未出现过对话正文（留言只以**密文**进箱，由 seal 钉住）。
 */
describe('转发路径上不存在任何写对话正文的调用', () => {
  it('计数与留言箱收到的字符串里没有正文', () => {
    const written: string[] = []
    const spy = {
      counters: new MemoryCounterStore(),
      offline: new MemoryOfflineBox(),
    }
    // 包一层记录：MemoryCounterStore / MemoryOfflineBox 的所有写入口
    const counterProxy = new Proxy(spy.counters, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver) as unknown
        if (typeof original === 'function') {
          return (...args: unknown[]) => {
            written.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('|'))
            return (original as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return original
      },
    })
    const offlineProxy = new Proxy(spy.offline, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver) as unknown
        if (typeof original === 'function') {
          return (...args: unknown[]) => {
            written.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('|'))
            return (original as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return original
      },
    })

    const sealed: string[] = []
    const core = new RelayCore({
      clock: () => NOW,
      verifyPairing: () => true,
      counters: counterProxy,
      offline: offlineProxy,
      // 留言封箱：密文进箱（base64，与 node:crypto 那一档同一形态）
      seal: (_ws, plaintext) => {
        const blob = `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`
        sealed.push(blob)
        return blob
      },
      newId: () => 'id1',
    })

    const sent: RelayFrame[] = []
    core.handshake(
      { send: (f) => sent.push(f), close: () => {} },
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk',
          peer: 'server',
        }),
      ) as never,
    )
    const pushed: unknown[] = []
    core.attachVisitor('ws_x', 's1', 'v1', { send: (f) => pushed.push(f), close: () => {} })
    core.visitorMessage({
      workspace: 'ws_x',
      session: 's1',
      visitor: 'v1',
      text: '我的卡号是 4111 1111 1111 1111，能退吗',
      page: { host: 'shop.example.com', path: '/products/x' },
    })
    core.onClientFrame('ws_x', {
      type: 'reply',
      session: 's1',
      turn: (sent.find((f) => f.type === 'visit') as { turn: string }).turn,
      message_id: 'm1',
      text: '可以的，14 天内可退',
    })
    core.visitorTyping('s1', true)
    core.onClientFrame('ws_x', { type: 'typing', session: 's1', active: false })
    core.onClientFrame('ws_x', { type: 'pull_offline' })
    core.leaveOfflineMessage('ws_x', JSON.stringify({ email: 'a@b.c', text: '订单没到' }))

    // 转发路径上没有一条存储写入带正文
    expect(written.join('\n')).not.toContain('4111')
    expect(written.join('\n')).not.toContain('能退吗')
    expect(written.join('\n')).not.toContain('14 天内可退')
    // 留言只以密文进箱：箱里收到的是 seal 的输出
    expect(written.some((w) => sealed.some((s) => w.includes(s)))).toBe(true)
    expect(sealed[0]).not.toContain('订单没到')
  })
})
