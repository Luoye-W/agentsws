import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startNodeRelayHost } from '../src/node-host.js'
import { openSealed, sealedKeyOf, sealWithKey } from '../src/sealed.js'

const handles: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const h of handles) await h.close()
  handles.length = 0
})

describe('Node 宿主（Docker 档；全本地，不联网）', () => {
  it('首启打印配对密钥一次；同卷重启不重发', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-'))
    const host = startNodeRelayHost({ port: 0, workspace: 'ws_x', dataDir })
    handles.push(host)
    expect(host.pairingToken).toMatch(/^prk_/)
    expect(host.messageKey).toMatch(/^mkk_/)
    const again = startNodeRelayHost({ port: 0, workspace: 'ws_x', dataDir })
    handles.push(again)
    expect(again.pairingToken).toBeUndefined()
  })

  it('HTTP 访客面 + WebSocket 本机连接全流程（真实端口与真实 ws）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-'))
    const host = startNodeRelayHost({ port: 0, workspace: 'ws_x', dataDir })
    handles.push(host)
    const base = `http://localhost:${host.port() as number}`
    const wsBase = `ws://localhost:${host.port() as number}`

    // 商家本机连进来（Node 自带 WebSocket 客户端）
    const socket = new WebSocket(`${wsBase}/relay/ws_x/connect`)
    const sent: string[] = []
    socket.addEventListener('message', (e) => sent.push(String(e.data)))
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('connect failed')))
    })
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        workspace: 'ws_x',
        pairing: host.pairingToken,
        peer: 'server',
        config: {
          enabled: true,
          accent: '#2563eb',
          greeting: '你好',
          allowed_origins: ['https://shop.example.com'],
        },
      }),
    )
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (sent.some((s) => s.includes('hello_ok'))) {
          clearInterval(t)
          resolve()
        }
      }, 10)
    })

    // 访客：开会话 → 发消息 → 本机收到 visit
    const open = await fetch(`${base}/relay/ws_x/v1/chat/public/sessions`, {
      method: 'POST',
      headers: { origin: 'https://shop.example.com' },
    })
    expect(open.status).toBe(200)
    const { data: session } = (await open.json()) as {
      data: { session_id: string; visitor_token: string }
    }
    const msg = await fetch(
      `${base}/relay/ws_x/v1/chat/public/sessions/${session.session_id}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://shop.example.com',
          authorization: `Bearer ${session.visitor_token}`,
        },
        body: JSON.stringify({ text: '这款防水吗' }),
      },
    )
    expect([200, 202]).toContain(msg.status)
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (sent.some((s) => s.includes('"visit"'))) {
          clearInterval(t)
          resolve()
        }
      }, 10)
    })
    const visit = JSON.parse(sent.find((s) => s.includes('"visit"')) as string) as { turn: string }
    expect(visit.turn).toBeTruthy()

    // 留言（本机离线也收）：密文入箱，本机用留言密钥开箱
    const leave = await fetch(`${base}/relay/ws_x/v1/chat/public/offline-messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://shop.example.com' },
      body: JSON.stringify({ email: 'v@example.com', text: '订单没到' }),
    })
    expect(leave.status).toBe(200)
    const sealed = sealWithKey(sealedKeyOf(host.messageKey as string), 'x') // 形状参考
    expect(openSealed(sealedKeyOf('wrong'), sealed)).toBeUndefined()

    // widget.js 能拉到
    const widget = await fetch(`${base}/relay/ws_x/widget.js`)
    expect(widget.status).toBe(200)
    expect(await widget.text()).toContain('agentsws-chat')
    socket.close()
  })
})
