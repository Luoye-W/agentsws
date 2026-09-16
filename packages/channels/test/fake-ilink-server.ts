/**
 * 假 iLink 服务器（WP85 测试用）。
 *
 * 真的起一个 `node:http` 在 `127.0.0.1` 上——**不出网**（35 §2 / CI 纪律），
 * 但走的是真 fetch、真 JSON、真 header，所以 `transport.ts` 里那些
 * 「请求头有没有带对、长轮询超时算不算正常出口」的事在这里是真的被测到了，
 * 而不是被一个 mock 假装过去。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeILinkOptions {
  /** 二维码状态的脚本：一次 GET 吐一个。用完之后一直吐最后一个。 */
  statuses?: unknown[]
  /** `getupdates` 的脚本：一次 POST 吐一个。用完之后吐空（模拟长轮询无消息）。 */
  updates?: unknown[]
  /** `sendmessage` 的脚本。用完之后吐 `{ret:0,message_id:'m'}`。 */
  sends?: unknown[]
}

export interface FakeILinkServer {
  url: string
  /** 收到的请求：路径 + 请求头 + 请求体（测试要断言 header 带对了没）。 */
  readonly calls: { path: string; headers: Record<string, string>; body: string }[]
  close(): Promise<void>
}

export async function startFakeILink(options: FakeILinkOptions = {}): Promise<FakeILinkServer> {
  const calls: { path: string; headers: Record<string, string>; body: string }[] = []
  const statuses = [...(options.statuses ?? [])]
  const updates = [...(options.updates ?? [])]
  const sends = [...(options.sends ?? [])]
  let lastStatus: unknown = { status: 'wait' }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = req.url ?? ''
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === 'string') headers[k.toLowerCase()] = v
      calls.push({ path, headers, body: Buffer.concat(chunks).toString('utf8') })

      /**
       * 脚本里给字符串就**原样吐**：uint64 的 id 一旦经过 `JSON.stringify`
       * 就已经掉精度了，那样的夹具证不了「无损解析」这件事。
       */
      const json = (value: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(typeof value === 'string' ? value : JSON.stringify(value))
      }

      if (path.startsWith('/ilink/bot/get_bot_qrcode')) {
        json({ qrcode: 'QR-1', qrcode_img_content: 'https://weixin.example/qr/1' })
        return
      }
      if (path.startsWith('/ilink/bot/get_qrcode_status')) {
        const next = statuses.shift()
        if (next !== undefined) lastStatus = next
        json(lastStatus)
        return
      }
      if (path.startsWith('/ilink/bot/getupdates')) {
        json(updates.shift() ?? { ret: 0, msgs: [], get_updates_buf: '' })
        return
      }
      if (path.startsWith('/ilink/bot/sendmessage')) {
        json(sends.shift() ?? { ret: 0, message_id: 'm_sent' })
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}
