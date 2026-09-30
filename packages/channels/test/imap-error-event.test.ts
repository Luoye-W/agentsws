import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { defaultImapClient } from '../src/email/imap.js'

/**
 * WP203：imapflow 连接出错时发的 `error` 事件没人听，会被 Node 当成未处理错误抛到进程顶层，
 * 整个本机服务跟着退出（09-30 实测：客服邮箱口令失效，4317 一启动就崩）。
 * 这里起一个一连上就断开的假服务器：connect() 应当只是 reject，不留下未处理的 `error`。
 */
describe('defaultImapClient 连接出错不拖垮进程', () => {
  it('登录时服务器回 BYE 并断开：connect 被拒，没有未处理的 error 事件', async () => {
    // 照 09-30 那次崩溃的原样：先打招呼、答能力，一到登录就回 BYE（Server logging out）再断开
    const server = createServer((socket) => {
      socket.write('* OK IMAP4rev1 ready\r\n')
      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let at = buf.indexOf('\r\n')
        while (at >= 0) {
          const line = buf.slice(0, at)
          buf = buf.slice(at + 2)
          const [tag, cmd] = line.split(' ')
          const verb = (cmd ?? '').toUpperCase()
          if (verb === 'CAPABILITY') {
            socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`)
          } else if (verb === 'LOGIN' || verb === 'AUTHENTICATE') {
            socket.write('* BYE IMAP4rev1 Server logging out\r\n')
            socket.end()
          } else {
            socket.write(`${tag} OK done\r\n`)
          }
          at = buf.indexOf('\r\n')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const client = defaultImapClient(
      { host: '127.0.0.1', port, secure: false, user: 'nobody@example.com' } as never,
      'wrong-password',
    )
    await expect(client.connect()).rejects.toBeDefined()
    // 给 imapflow 一拍把迟到的 error 事件发出来——没人听的话 vitest 会记成未处理错误而失败
    await new Promise((r) => setTimeout(r, 200))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
