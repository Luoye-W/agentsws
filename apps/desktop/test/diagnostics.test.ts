/**
 * WP111 诊断包：**包里没有凭据、没有正文**。
 *
 * 这一份测试的重点不是"收全了没有"，是那条边界。所以先造一个**脏得离谱**的现场——
 * 日志里有 API key、有 bearer、有邮件正文、有事实卡内容、有 64 位十六进制密钥——
 * 再断言那些东西一个字都进不了包。
 */
import { describe, expect, it } from 'vitest'
import {
  collectDiagnostics,
  DIAGNOSTIC_ITEMS,
  type DiagnosticsInput,
  diagnosticsFileName,
  diagnosticsListing,
  humanBytes,
  LOG_TAIL_LINES,
  scrubSecrets,
  tailLines,
} from '../src/diagnostics.js'
import { buildTrayMenu, type TrayModelInput } from '../src/menu.js'
import { createRedactor } from '../src/redact.js'

const SECRET_KEY = 'a3f1'.repeat(16) // 64 位十六进制，就是我们那几把密钥的形状
const MAIL_BODY = '亲爱的客服，我上周买的台灯寄错了，我的手机号是 13800001111，请退款。'
const FACT_CARD = '事实卡：客户偏好深色包装，2026-08 由李默录入'

function input(patch: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: '0.1.0-beta.2',
    platform: 'win32',
    arch: 'x64',
    serverExec:
      'C:\\Users\\小雨 的电脑\\AppData\\Local\\Programs\\agentsws\\resources\\node\\node.exe',
    updateMode: 'auto',
    updateReason: 'Windows：未签名也能应用内更新',
    mode: 'local',
    serverUrl: 'http://127.0.0.1:4317',
    at: '2026-09-18T10:00:00.000Z',
    health: '{"data":{"status":"ok","version":"0.1.0-beta.2","modules":[]}}',
    schemaState: '{"release":"0.1.0-beta.2","versions":{"work.sqlite":1}}',
    upgradeFailure: undefined,
    connectors: [{ service: 'imap_smtp', label: '任意邮箱', status: 'active' }],
    modules: ['kernel', 'roles'],
    desktopLog: '2026-09-18 INFO [desktop] 桌面壳启动\n',
    serverLog: '2026-09-18 INFO [server] listening\n',
    ...patch,
  }
}

const textOf = (bundle: { entries: { name: string; content: string }[] }): string =>
  bundle.entries.map((e) => e.content).join('\n')

describe('白名单', () => {
  it('包里只会有登记在册的那几样，一样不多', () => {
    const bundle = collectDiagnostics(input())
    expect(bundle.entries.map((e) => e.name)).toEqual(DIAGNOSTIC_ITEMS.map((i) => i.name))
  })

  it('每一项都一定出现，哪怕内容是"这次没有" —— 缺一个文件会让人以为收集本身坏了', () => {
    const bundle = collectDiagnostics(
      input({
        health: undefined,
        connectors: undefined,
        modules: undefined,
        desktopLog: undefined,
        serverLog: undefined,
        schemaState: undefined,
      }),
    )
    expect(bundle.entries).toHaveLength(DIAGNOSTIC_ITEMS.length)
    for (const entry of bundle.entries) expect(entry.content.length).toBeGreaterThan(0)
    expect(bundle.entries.find((e) => e.name === 'connectors.txt')?.content).toContain('问不到')
    expect(bundle.entries.find((e) => e.name === 'health.json')?.content).toContain('打不通')
  })

  it('**数据目录里的库一个都不在包里**（白名单里根本没有它们）', () => {
    const names = DIAGNOSTIC_ITEMS.map((i) => i.name).join(' ')
    expect(names).not.toMatch(/\.(db|sqlite)/)
    expect(names).not.toContain('secrets')
  })
})

describe('包里没有凭据', () => {
  const dirty = collectDiagnostics(
    input({
      desktopLog: [
        `2026-09-18 INFO [desktop] internal token: ${SECRET_KEY}`,
        'DEEPSEEK_API_KEY=sk-abcdefghijklmnop1234',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        'shopify token shpat_0123456789abcdef0123',
        '"password": "她的邮箱授权码"',
        `OOMOL_CONNECT_ADMIN_TOKEN: ${SECRET_KEY}`,
        'cookie=agentsws_session=abcdef123456',
      ].join('\n'),
      health: `{"data":{"status":"ok","secret":"${SECRET_KEY}"}}`,
      redactor: createRedactor([SECRET_KEY]),
    }),
  )
  const all = textOf(dirty)

  it('那把 64 位十六进制的密钥一次都没出现', () => {
    expect(all).not.toContain(SECRET_KEY)
  })

  it('前缀式密钥（sk- / shpat_）被截掉了尾巴', () => {
    expect(all).not.toContain('sk-abcdefghijklmnop1234')
    expect(all).not.toContain('shpat_0123456789abcdef0123')
    expect(all).toContain('[redacted]')
  })

  it('bearer / password / cookie 这类键值对被遮掉', () => {
    expect(all).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig')
    expect(all).not.toContain('她的邮箱授权码')
    expect(all).not.toContain('agentsws_session=abcdef123456')
  })
})

describe('包里没有正文 / 事件负载 / 知识内容', () => {
  it('这些东西根本不在任何一项的来源里 —— 不是"收了再删"', () => {
    // 造一个极端现场：正文与事实卡**真的**在日志里（正常不会，但假设有）
    const bundle = collectDiagnostics(
      input({ desktopLog: `正常一行\n${MAIL_BODY}\n${FACT_CARD}\n`.repeat(1) }),
    )
    const nonLog = bundle.entries
      .filter((e) => !e.name.endsWith('.log'))
      .map((e) => e.content)
      .join('\n')
    // 除了日志那两份，别的项一个字都不会碰到正文与知识内容
    expect(nonLog).not.toContain(MAIL_BODY)
    expect(nonLog).not.toContain(FACT_CARD)
  })

  it('连接器那一项**只有名字与状态**：没有 alias、没有身份展示名', () => {
    const bundle = collectDiagnostics(
      input({ connectors: [{ service: 'imap_smtp', label: '任意邮箱', status: 'active' }] }),
    )
    const text = bundle.entries.find((e) => e.name === 'connectors.txt')?.content as string
    expect(text).toContain('imap_smtp')
    expect(text).toContain('active')
    // `ConnectorSummary` 的类型里压根没有 alias 这一格：能不进内存就不进内存
    expect(text).not.toContain('@')
  })

  it('一条都没连也说清楚（"问不到"与"还没连"是两件事）', () => {
    const none = collectDiagnostics(input({ connectors: [] }))
    expect(none.entries.find((e) => e.name === 'connectors.txt')?.content).toContain('一条都还没连')
  })
})

describe('scrubSecrets', () => {
  it('干净的文本原样放过（别把日志改得看不懂）', () => {
    const clean = '2026-09-18 INFO [server] listening on http://127.0.0.1:4317'
    expect(scrubSecrets(clean)).toBe(clean)
  })

  it('短的十六进制不动（trace_id 之类的还得看）', () => {
    expect(scrubSecrets('trace_id=30e36e54f95cd53c')).toBe('trace_id=30e36e54f95cd53c')
  })
})

describe('tailLines', () => {
  it(`只带最后 ${LOG_TAIL_LINES} 行`, () => {
    const many = Array.from({ length: LOG_TAIL_LINES + 500 }, (_, i) => `line ${i}`).join('\n')
    const tail = tailLines(many)
    expect(tail.trimEnd().split('\n')).toHaveLength(LOG_TAIL_LINES)
    expect(tail).toContain(`line ${LOG_TAIL_LINES + 499}`)
    expect(tail).not.toContain('line 0\n')
  })

  it('没有日志就说没有，不给一个空文件', () => {
    expect(tailLines(undefined)).toContain('没有这份日志')
    expect(tailLines('')).toContain('没有这份日志')
  })

  it('末尾那个空行不算一行', () => {
    expect(tailLines('a\nb\n', 2).trimEnd().split('\n')).toEqual(['a', 'b'])
  })
})

describe('给用户看的那张单子', () => {
  it('一行一样东西 + 多大；末尾明写不收什么', () => {
    const listing = diagnosticsListing(collectDiagnostics(input()), 'zh-CN')
    expect(listing.split('\n').filter((l) => l.startsWith('· '))).toHaveLength(
      DIAGNOSTIC_ITEMS.length,
    )
    expect(listing).toContain('没有：任何密码或密钥')
    expect(listing).toContain('邮件正文')
  })

  it('英文那份也有', () => {
    const listing = diagnosticsListing(collectDiagnostics(input()), 'en-US')
    expect(listing).toContain('Not included')
    expect(listing).toContain('email bodies')
  })

  it('大小是人看的单位', () => {
    expect(humanBytes(512)).toBe('512 B')
    expect(humanBytes(2048)).toBe('2.0 KB')
    expect(humanBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('diagnosticsFileName', () => {
  it('名字里带版本与时间（她发过来的那个文件我们要认得出是哪一版）', () => {
    expect(diagnosticsFileName('0.1.0-beta.2', '2026-09-18T10:00:00.000Z')).toBe(
      'agentsws-诊断-0.1.0-beta.2-20260918T100000Z.zip',
    )
  })
})

describe('托盘：导出诊断包', () => {
  const base: TrayModelInput = {
    language: 'zh-CN',
    serverUrl: 'http://127.0.0.1:4317',
    version: '0.1.0-beta.2',
    server: { state: 'failed' } as never,
    health: undefined,
    paused: false,
    connect: undefined,
    launchAtLogin: false,
  }

  it('**服务起不来的时候也点得动** —— 那正是最需要它的一刻', () => {
    const item = buildTrayMenu(base).find((i) => i.id === 'export-diagnostics')
    expect(item?.enabled).toBe(true)
    expect(item?.label).toBe('导出诊断包…')
  })

  it('连公司服务器那一档也有（日志与版本仍在这台电脑上）', () => {
    expect(buildTrayMenu({ ...base, mode: 'remote' }).map((i) => i.id)).toContain(
      'export-diagnostics',
    )
  })
})
