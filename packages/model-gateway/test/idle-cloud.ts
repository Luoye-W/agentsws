/**
 * WP243：一个**真 HTTP** 的云模型口替身，前面挡着一跳「空闲就掐线」的代理。
 *
 * 真机（Windows + Clash Verge TUN + 火绒）上的样子：非流式请求要等模型想完、写完才回第一个字节，
 * 几十秒里连接上一个字节都没有，中间某一跳把它当空闲连接掐了——客户端看到
 * `fetch failed (UND_ERR_SOCKET other side closed)`。这里按比例缩小：真机约 45 秒不回字节就掐，
 * 替身默认 `idleMs` 毫秒；模型一次回答要 `answerMs` 毫秒（比 `idleMs` 长）。
 *
 * - 非流式：答案在 `answerMs` 之后一次性写出——中间没有字节，到 `idleMs` 就被掐；
 * - 流式：`firstByteMs` 后先来一块，之后每 `chunkEveryMs` 一块——字一直在来，不被掐。
 * - `breakAt(n)`：第 n 次请求（从 1 数）流到一半出事：`reset` = 掐断连接，`close` = 干净地关了但没说完。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface IdleCloudOptions {
  idleMs?: number
  answerMs?: number
  firstByteMs?: number
  chunkEveryMs?: number
  /** 回答正文（第 n 次请求可以不一样，好认出重发后拿的是哪一次）。 */
  text?: (n: number) => string
  breakAt?: (n: number) => 'reset' | 'close' | undefined
}

export interface IdleCloud {
  base: string
  /** 每次请求的请求体（JSON 解出来的）。 */
  bodies: Record<string, unknown>[]
  /** 被「空闲掐线」掐掉的次数。 */
  killed: number
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function idleCloud(options: IdleCloudOptions = {}): Promise<IdleCloud> {
  const idleMs = options.idleMs ?? 300
  const answerMs = options.answerMs ?? 900
  const firstByteMs = options.firstByteMs ?? 30
  const chunkEveryMs = options.chunkEveryMs ?? 60
  const textOf = options.text ?? (() => '{"roles":[{"role_id":"site.shopify-build"}]}')
  const state: IdleCloud = {
    base: '',
    bodies: [],
    killed: 0,
    close: async () => undefined,
  }
  let n = 0

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
      string,
      unknown
    >
    state.bodies.push(body)
    n += 1
    const nth = n
    const socket = req.socket
    // 中间那一跳：多久没往下游写过字节就掐
    let last = Date.now()
    let gone = false
    const watch = setInterval(() => {
      if (Date.now() - last > idleMs) {
        clearInterval(watch)
        gone = true
        state.killed += 1
        socket.destroy()
      }
    }, 10)
    const write = (s: string): boolean => {
      if (gone) return false
      last = Date.now()
      res.write(s)
      return true
    }
    try {
      const text = textOf(nth)
      const usage = { prompt_tokens: 3126, completion_tokens: Math.ceil(text.length / 2) }
      if (body.stream !== true) {
        await sleep(answerMs)
        if (gone) return
        last = Date.now()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ index: 0, finish_reason: 'stop', message: { content: text } }],
            usage,
          }),
        )
        return
      }
      await sleep(firstByteMs)
      if (gone) return
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`,
      )
      const pieces = text.match(/[\s\S]{1,8}/g) ?? []
      const steps = Math.max(pieces.length, Math.ceil(answerMs / chunkEveryMs))
      const broken = options.breakAt?.(nth)
      for (let i = 0; i < steps; i++) {
        await sleep(chunkEveryMs)
        if (gone) return
        if (broken !== undefined && i === Math.floor(pieces.length / 2)) {
          if (broken === 'reset') socket.destroy()
          else res.end()
          return
        }
        const piece = pieces[i]
        // 没字可吐的那几拍：照真上游那样回一行注释心跳（还是字节）
        write(
          piece === undefined
            ? ': keep-alive\n\n'
            : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`,
        )
      }
      write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
      if (!gone) res.end('data: [DONE]\n\n')
    } finally {
      clearInterval(watch)
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      req.socket.destroy()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  state.base = `http://127.0.0.1:${port}/v1/ai`
  state.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections()
      server.close(() => r())
    })
  return state
}
