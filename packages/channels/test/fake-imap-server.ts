import net from 'node:net'

/**
 * 最小 IMAP4rev1 协议桩：只实现 imapflow 走完一轮增量拉取需要的命令
 * （CAPABILITY / LOGIN / LIST / SELECT / UID FETCH / NOOP / CLOSE / LOGOUT）。
 * 目的是让真实的 imapflow 客户端在测试里跑完整条链路而不联网。
 */
export interface FakeImapMessage {
  uid: number
  source: string
  internal_date?: Date
}

export interface FakeImapServer {
  port: number
  close(): Promise<void>
  /** 服务端收到的命令（去掉 tag），用于断言增量拉取的 range */
  commands: string[]
  add(message: FakeImapMessage): void
}

export interface FakeImapOptions {
  messages?: FakeImapMessage[]
  user?: string
  pass?: string
  mailbox?: string
}

export async function startFakeImapServer(opts: FakeImapOptions = {}): Promise<FakeImapServer> {
  const messages = [...(opts.messages ?? [])]
  const user = opts.user ?? 'agent@example.com'
  const pass = opts.pass ?? 'app-specific-password'
  const commands: string[] = []

  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    let buffer = ''
    const write = (line: string) => socket.write(`${line}\r\n`)
    write('* OK [CAPABILITY IMAP4rev1] fake imap ready')

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const idx = buffer.indexOf('\r\n')
        if (idx === -1) break
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        handle(line)
      }
    })

    function handle(line: string): void {
      const space = line.indexOf(' ')
      const tag = space === -1 ? line : line.slice(0, space)
      const rest = space === -1 ? '' : line.slice(space + 1)
      commands.push(rest)
      const [cmdRaw, ...args] = rest.split(' ')
      const cmd = (cmdRaw ?? '').toUpperCase()

      switch (cmd) {
        case 'CAPABILITY':
          write('* CAPABILITY IMAP4rev1')
          write(`${tag} OK CAPABILITY completed`)
          return
        case 'LOGIN': {
          const givenUser = unquote(args[0] ?? '')
          const givenPass = unquote(args[1] ?? '')
          if (givenUser === user && givenPass === pass) write(`${tag} OK LOGIN completed`)
          else write(`${tag} NO [AUTHENTICATIONFAILED] bad credentials`)
          return
        }
        case 'ID':
          write('* ID NIL')
          write(`${tag} OK ID completed`)
          return
        case 'NAMESPACE':
          write('* NAMESPACE (("" "/")) NIL NIL')
          write(`${tag} OK NAMESPACE completed`)
          return
        case 'LIST':
        case 'LSUB': {
          const pattern = unquote(args[1] ?? '')
          if (pattern === '') write(`* ${cmd} (\\Noselect) "/" ""`)
          else write(`* ${cmd} (\\HasNoChildren) "/" "INBOX"`)
          write(`${tag} OK ${cmd} completed`)
          return
        }
        case 'STATUS':
          write(`* STATUS "INBOX" (MESSAGES ${messages.length} UIDNEXT ${nextUid(messages)})`)
          write(`${tag} OK STATUS completed`)
          return
        case 'SELECT':
        case 'EXAMINE':
          write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)')
          write(`* ${messages.length} EXISTS`)
          write('* 0 RECENT')
          write('* OK [UIDVALIDITY 1] UIDs valid')
          write(`* OK [UIDNEXT ${nextUid(messages)}] Predicted next UID`)
          write(`${tag} OK [READ-WRITE] ${cmd} completed`)
          return
        case 'UID': {
          const sub = (args[0] ?? '').toUpperCase()
          if (sub === 'FETCH') {
            fetchUid(args[1] ?? '1:*')
            write(`${tag} OK UID FETCH completed`)
            return
          }
          if (sub === 'SEARCH') {
            write(`* SEARCH ${messages.map((m) => m.uid).join(' ')}`)
            write(`${tag} OK UID SEARCH completed`)
            return
          }
          write(`${tag} OK ${sub} completed`)
          return
        }
        case 'NOOP':
        case 'CHECK':
        case 'CLOSE':
        case 'UNSELECT':
          write(`${tag} OK ${cmd} completed`)
          return
        case 'LOGOUT':
          write('* BYE logging out')
          write(`${tag} OK LOGOUT completed`)
          socket.end()
          return
        default:
          write(`${tag} BAD unsupported command ${cmd}`)
      }
    }

    function fetchUid(range: string): void {
      const [loRaw, hiRaw] = range.split(':')
      const lo = Number.parseInt(loRaw ?? '1', 10)
      const hi = hiRaw === '*' || hiRaw === undefined ? Number.POSITIVE_INFINITY : Number(hiRaw)
      const selected = messages.filter((m) => m.uid >= lo && m.uid <= hi)
      // IMAP 规定 `n:*` 至少回最后一条
      if (selected.length === 0 && messages.length > 0 && hiRaw === '*') {
        const last = messages[messages.length - 1]
        if (last !== undefined) selected.push(last)
      }
      for (const msg of selected) {
        const seq = messages.indexOf(msg) + 1
        const body = Buffer.from(msg.source, 'utf8')
        const date = formatInternalDate(msg.internal_date ?? new Date('2026-09-09T08:00:00Z'))
        socket.write(
          `* ${seq} FETCH (UID ${msg.uid} INTERNALDATE "${date}" BODY[] {${body.length}}\r\n`,
        )
        socket.write(body)
        socket.write(')\r\n')
      }
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return {
    port,
    commands,
    add: (m) => messages.push(m),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.close(() => resolve())
      }),
  }
}

function unquote(s: string): string {
  return s.replace(/^"|"$/g, '')
}

function nextUid(messages: readonly FakeImapMessage[]): number {
  return messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatInternalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
}
