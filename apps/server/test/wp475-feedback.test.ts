/**
 * WP475（决策 1591、1592）：左下角「反馈」本机那一半——先存本机、发云、离线补发、问进度进铃铛；
 * 诊断信息白名单 + 出门前脱敏（钉住：不含邮件正文 / 草稿 / 客户名 / 密钥）。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  FeedbackStatusList,
  FeedbackSubmitRequest,
  NotificationInput,
} from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_STAND_IN_BASE_URL, cloudStandIn } from '../src/cloud-stand-in.js'
import {
  clientErrorRingLine,
  createErrorRing,
  createFeedbackService,
  type FeedbackFetch,
  scrubDiagnosticLine,
  scrubRoute,
  tapStderr,
} from '../src/feedback.js'
import { createServer, type Server } from '../src/index.js'

const ACTOR = { workspace_id: 'ws_1' as never, person_id: 'p_1' as never }

/** 种进日志里的「业务内容」与密钥——哪一样都不许出现在发给云的东西里。 */
const EMAIL_BODY = '您好王总，附件是三季度报价单，请查收并回复确认'
const DRAFT = '亲爱的客户，我们的新品下周上架，限时八折'
const CUSTOMER = '星海贸易有限公司'
const CUSTOMER_EMAIL = 'buyer@xinghai-trading.example'
const SECRET = 'sk-live9f8e7d6c5b4a3f2e1d0c9b8a7'
const TOKEN = 'abcdEFGH1234ijklMNOP5678qrstUVWX9012yzab'
const PLANTED = [
  `[mail] 发信失败：「${EMAIL_BODY}」 to ${CUSTOMER_EMAIL}`,
  `[draft] 草稿没存上 "${DRAFT}"`,
  `[crm] 客户“${CUSTOMER}”同步失败`,
  `[llm] 401 Authorization: Bearer ${TOKEN} key=${SECRET}`,
  '[net] GET https://api.example.com/v1/orders?token=topsecretvalue&shop=demo 500',
  '[pay] card 4111 1111 1111 1111 declined',
  `[client] error /inbox TypeError: cannot read 'subject' of undefined | at render (/assets/index.js:12:5)`,
]
const FORBIDDEN = [
  EMAIL_BODY,
  DRAFT,
  CUSTOMER,
  CUSTOMER_EMAIL,
  SECRET,
  TOKEN,
  'topsecretvalue',
  '4111 1111 1111 1111',
  'subject',
]

function clock(start = '2026-10-22T08:00:00.000Z') {
  let ms = Date.parse(start)
  return {
    now: () => new Date(ms).toISOString(),
    advance: (d: number) => {
      ms += d
    },
  }
}

interface Seen {
  url: string
  body: unknown
}

/** 替身云：可切「断网」、可回指定状态码、可加回复。 */
function fakeCloud() {
  const seen: Seen[] = []
  let offline = false
  let nextStatus: number | undefined
  const store = new Map<string, { id: string; ticket: string; message: string; kind: string }>()
  const replies = new Map<string, { at: string; text: string }[]>()
  const status = new Map<string, string>()
  let n = 0
  const fetch: FeedbackFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    seen.push({ url, body })
    if (offline) throw new Error('ECONNREFUSED')
    if (nextStatus !== undefined) {
      const s = nextStatus
      nextStatus = undefined
      return { ok: false, status: s, text: async () => JSON.stringify({ code: 'x', message: 'x' }) }
    }
    if (url.endsWith('/v1/feedback')) {
      const req = body as unknown as FeedbackSubmitRequest
      const key = `${req.device_id}:${req.client_id}`
      let got = store.get(key)
      if (got === undefined) {
        n += 1
        got = { id: `fb_${n}`, ticket: `fbt_${n}`, message: req.message, kind: req.kind }
        store.set(key, got)
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: { id: got.id, ticket: got.ticket, status: 'new', created_at: 't' },
          }),
      }
    }
    if (url.endsWith('/v1/feedback/status')) {
      const tickets = new Set(body.tickets as string[])
      const items: FeedbackStatusList['items'] = [...store.values()]
        .filter((f) => tickets.has(f.ticket))
        .map((f) => ({
          id: f.id,
          kind: f.kind as 'bug',
          status: (status.get(f.id) ?? 'new') as 'new',
          message: f.message,
          created_at: 't',
          updated_at: 't',
          replies: replies.get(f.id) ?? [],
        }))
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { items } }) }
    }
    return { ok: false, status: 404, text: async () => '{}' }
  }
  return {
    fetch,
    seen,
    setOffline: (v: boolean) => {
      offline = v
    },
    failNext: (s: number) => {
      nextStatus = s
    },
    reply: (id: string, text: string) => {
      replies.set(id, [...(replies.get(id) ?? []), { at: '2026-10-22T09:00:00.000Z', text }])
    },
    setStatus: (id: string, s: string) => {
      status.set(id, s)
    },
    submits: () => seen.filter((s) => s.url.endsWith('/v1/feedback')),
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wp475-feedback-'))
  dirs.push(d)
  return d
}

const PNG_B64 = Buffer.from('\x89PNG\r\n\x1a\nfake-image-bytes').toString('base64')

function service(opts: { dir?: string; cloud?: ReturnType<typeof fakeCloud>; lines?: string[] }) {
  const c = clock()
  const cloud = opts.cloud ?? fakeCloud()
  const ring = createErrorRing()
  for (const l of opts.lines ?? PLANTED) ring.push(l)
  const notes: NotificationInput[] = []
  const svc = createFeedbackService({
    clock: c,
    ...(opts.dir === undefined ? {} : { dir: opts.dir }),
    cloudBase: () => 'https://cloud.example/',
    fetch: cloud.fetch,
    serverVersion: '0.2.1-beta.5',
    contactOf: () => 'me@example.com',
    notify: (n) => notes.push(n),
    errors: ring,
    os: 'darwin arm64 25.6.0',
  })
  return { svc, cloud, clock: c, notes, ring }
}

describe('脱敏：一条错误日志出门前', () => {
  it('密钥、邮箱、网址查询串、卡号、引号里的业务内容一律拿掉，骨架留着', () => {
    const out = PLANTED.map((l) => scrubDiagnosticLine(l)).join('\n')
    for (const bad of FORBIDDEN) expect(out).not.toContain(bad)
    expect(out).toContain('[mail] 发信失败')
    expect(out).toContain('[draft] 草稿没存上')
    expect(out).toContain('https://api.example.com/v1/orders')
    expect(out).toContain('at render (/assets/index.js:12:5)')
  })

  it('一条一行、截到 500 字；页面路径只留路径', () => {
    const one = scrubDiagnosticLine(`a\nb\r${'x'.repeat(2000)}`)
    expect(one).not.toContain('\n')
    expect(one.length).toBeLessThanOrEqual(500)
    expect(scrubRoute('/messages/thread/buyer@x.example?token=abc#frag')).toBe(
      '/messages/thread/<email>',
    )
  })

  it('ring 只留最近 50 条；前端报错那一行不带引号', () => {
    const ring = createErrorRing()
    for (let i = 0; i < 80; i += 1) ring.push(`line ${i}`)
    expect(ring.lines()).toHaveLength(50)
    expect(ring.lines()[0]).toBe('line 30')
    expect(
      clientErrorRingLine({ kind: 'boundary', name: 'TypeError', message: 'x', route: '/inbox' }),
    ).toBe('[client] boundary /inbox TypeError: x')
  })

  it('stderr 接进 ring：照写不误、跳过前端报错那一行、能解开', () => {
    const ring = createErrorRing()
    const written: string[] = []
    const stream = {
      write: (chunk: unknown) => {
        written.push(String(chunk))
        return true
      },
    } as unknown as NodeJS.WriteStream
    const untap = tapStderr(ring, stream, (l) => l.startsWith('[client-error]'))
    stream.write('[team] 连不上\n[client-error] x\npart')
    stream.write('ial\n')
    expect(written.join('')).toBe('[team] 连不上\n[client-error] x\npartial\n')
    expect(ring.lines()).toEqual(['[team] 连不上', 'partial'])
    untap()
    stream.write('after\n')
    expect(ring.lines()).toHaveLength(2)
  })
})

describe('交一条反馈', () => {
  it('草稿：联系方式默认账号邮箱；诊断信息只有白名单几格且已脱敏', async () => {
    const { svc } = service({})
    const draft = await svc.port.draft(ACTOR, {
      route: '/inbox?token=abc',
      locale: 'zh-CN',
      app_version: '0.2.1-beta.5',
      shell: 'desktop',
    })
    expect(draft.contact).toBe('me@example.com')
    expect(Object.keys(draft.diagnostics).sort()).toEqual(
      ['app_version', 'errors', 'locale', 'os', 'route', 'shell'].sort(),
    )
    expect(draft.diagnostics.route).toBe('/inbox')
    expect(draft.diagnostics.errors).toHaveLength(PLANTED.length)
    const text = JSON.stringify(draft)
    for (const bad of FORBIDDEN) expect(text).not.toContain(bad)
  })

  it('云通：发出去了（匿名 + 设备号、client_id），发给云的整条请求里没有业务内容与密钥', async () => {
    const { svc, cloud } = service({})
    const out = await svc.port.submit(ACTOR, {
      kind: 'bug',
      message: '收件箱点开是空白',
      contact: 'me@example.com',
      include_diagnostics: true,
      route: '/inbox?id=123',
      locale: 'zh-CN',
      shell: 'browser',
      screenshot: { content_type: 'image/png', data_base64: PNG_B64 },
    })
    expect(out.delivered).toBe(true)
    expect(out.item).toMatchObject({
      state: 'sent',
      id: 'fb_1',
      status: 'new',
      has_screenshot: true,
      has_diagnostics: true,
    })
    expect(JSON.stringify(out.item)).not.toContain('fbt_')
    const [sent] = cloud.submits()
    const req = sent?.body as FeedbackSubmitRequest
    expect(req.device_id).toMatch(/^dev_[0-9a-f]{32}$/)
    expect(req.client_id).toMatch(/^fbc_/)
    expect(req.screenshot?.data_base64).toBe(PNG_B64)
    expect(req.diagnostics?.route).toBe('/inbox')
    const wire = JSON.stringify(req)
    for (const bad of FORBIDDEN) expect(wire).not.toContain(bad)
  })

  it('不勾「附上诊断信息」就一格都不发', async () => {
    const { svc, cloud } = service({})
    await svc.port.submit(ACTOR, {
      kind: 'idea',
      message: '希望能导出',
      include_diagnostics: false,
      route: '/',
      locale: 'zh-CN',
    })
    const req = cloud.submits()[0]?.body as FeedbackSubmitRequest
    expect(req.diagnostics).toBeUndefined()
    expect(req.screenshot).toBeUndefined()
    expect(req.contact).toBeUndefined()
  })

  it('离线：先存本机（截图落盘），联网后自动补发、同一个 client_id；发出去截图就删', async () => {
    const dir = tmp()
    const { svc, cloud, clock: c } = service({ dir })
    cloud.setOffline(true)
    const out = await svc.port.submit(ACTOR, {
      kind: 'bug',
      message: '断网时发的',
      include_diagnostics: true,
      route: '/',
      locale: 'zh-CN',
      screenshot: { content_type: 'image/png', data_base64: PNG_B64 },
    })
    expect(out.delivered).toBe(false)
    expect(out.item.state).toBe('queued')
    expect(readdirSync(join(dir, 'feedback/shots'))).toHaveLength(1)

    // 重启之后队列还在（同一个设备号）
    const again = service({ dir, cloud })
    cloud.setOffline(false)
    await again.svc.tick()
    expect((await again.svc.port.mine(ACTOR, { refresh: false })).items[0]?.state).toBe('queued')
    again.clock.advance(31_000)
    c.advance(31_000)
    await again.svc.tick()
    const mine = await again.svc.port.mine(ACTOR, { refresh: false })
    expect(mine.items[0]).toMatchObject({ state: 'sent', id: 'fb_1' })
    const ids = cloud.submits().map((s) => (s.body as FeedbackSubmitRequest).client_id)
    expect(new Set(ids).size).toBe(1)
    expect(readdirSync(join(dir, 'feedback/shots'))).toHaveLength(0)
    const saved = readFileSync(join(dir, 'feedback/state.json'), 'utf8')
    expect(saved).not.toContain(PNG_B64)
  })

  it('云嫌截图太大（413）→ 不带截图再发一次；云明说不收（400）→ 不再补发', async () => {
    const { svc, cloud } = service({})
    cloud.failNext(413)
    const big = await svc.port.submit(ACTOR, {
      kind: 'bug',
      message: '大截图',
      include_diagnostics: false,
      route: '/',
      locale: 'zh-CN',
      screenshot: { content_type: 'image/png', data_base64: PNG_B64 },
    })
    expect(big.delivered).toBe(true)
    expect(cloud.submits()).toHaveLength(2)
    const second = cloud.submits()[1]?.body as FeedbackSubmitRequest | undefined
    expect(second?.screenshot).toBeUndefined()
    expect(second?.message).toBe('大截图')

    cloud.failNext(400)
    const bad = await svc.port.submit(ACTOR, {
      kind: 'bug',
      message: '云不收',
      include_diagnostics: false,
      route: '/',
      locale: 'zh-CN',
    })
    expect(bad).toMatchObject({ delivered: false, item: { state: 'failed' } })
    await svc.tick({ forcePoll: true })
    expect(cloud.submits()).toHaveLength(3)
  })
})

describe('我的反馈：进度、回复、铃铛', () => {
  it('问进度拿回状态与回复；新回复进铃铛一条（同键）；看过了未读清零；修好了再说一声', async () => {
    const { svc, cloud, notes, clock: c } = service({})
    await svc.port.submit(ACTOR, {
      kind: 'bug',
      message: '设置页打不开',
      include_diagnostics: false,
      route: '/',
      locale: 'zh-CN',
    })
    cloud.reply('fb_1', '收到，今天修')
    cloud.setStatus('fb_1', 'in_progress')
    c.advance(30_000)
    const mine = await svc.port.mine(ACTOR, { refresh: true })
    expect(mine.stale).toBeUndefined()
    expect(mine.items[0]).toMatchObject({
      status: 'in_progress',
      unread_replies: 1,
      replies: [{ text: '收到，今天修' }],
    })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      category: 'feedback',
      key: 'feedback:fb_1',
      href: '/?feedback=mine',
      workspace_id: 'ws_1',
      person_id: 'p_1',
    })
    await svc.port.seen(ACTOR)
    expect((await svc.port.mine(ACTOR, { refresh: false })).items[0]?.unread_replies).toBe(0)

    // 同一条回复再问一次不再响；修好了响一次
    await svc.tick({ forcePoll: true })
    expect(notes).toHaveLength(1)
    cloud.setStatus('fb_1', 'fixed')
    await svc.tick({ forcePoll: true })
    expect(notes).toHaveLength(2)
    expect(notes[1]?.text).toBe('你反馈的问题修好了')
    await svc.tick({ forcePoll: true })
    expect(notes).toHaveLength(2)
  })

  it('只看得到自己的；云不通时列表照旧、标 stale', async () => {
    const { svc, cloud, clock: c } = service({})
    await svc.port.submit(ACTOR, {
      kind: 'other',
      message: '我的',
      include_diagnostics: false,
      route: '/',
      locale: 'zh-CN',
    })
    await svc.port.submit(
      { workspace_id: 'ws_1' as never, person_id: 'p_2' as never },
      { kind: 'other', message: '别人的', include_diagnostics: false, route: '/', locale: 'en' },
    )
    cloud.setOffline(true)
    c.advance(30_000)
    const mine = await svc.port.mine(ACTOR, { refresh: true })
    expect(mine.stale).toBe(true)
    expect(mine.items.map((i) => i.message)).toEqual(['我的'])
  })
})

describe('真装配线：/v1/feedback*', () => {
  let server: Server | undefined
  let dbDir: string | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
    if (dbDir !== undefined) rmSync(dbDir, { recursive: true, force: true })
    dbDir = undefined
  })

  const call = async (s: Server, method: string, path: string, body?: unknown) => {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: res.status, data: ((await res.json()) as { data: unknown }).data }
  }

  it('草稿 → 交（云不通 = 已存本机）→ 我的反馈；不带凭据 401；前端报错进诊断且洗过', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'wp475-server-'))
    const ring = createErrorRing()
    server = await createServer({
      dbDir,
      quiet: true,
      startRun: false,
      tokenRefreshIntervalMs: 0,
      feedbackErrors: ring,
      clientErrorLog: () => undefined,
      env: { AGENTSWS_CLOUD_BASE_URL: 'https://cloud.invalid' },
    })
    const s = server
    // 前端报错（经网关洗过）也进 ring
    await s.gateway.fetch(
      new Request('http://127.0.0.1/v1/client-errors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'boundary',
          name: 'TypeError',
          message: `boom for ${CUSTOMER_EMAIL}`,
          route: '/inbox?token=abc',
        }),
      }),
    )
    const draft = await call(s, 'GET', '/v1/feedback/draft?route=/inbox%3Fq%3D1&locale=zh-CN')
    expect(draft.status).toBe(200)
    const diag = (draft.data as { diagnostics: { route: string; errors: string[] } }).diagnostics
    expect(diag.route).toBe('/inbox')
    expect(diag.errors.join('\n')).toContain('[client] boundary /inbox TypeError: boom for <email>')
    expect(diag.errors.join('\n')).not.toContain(CUSTOMER_EMAIL)

    const sent = await call(s, 'POST', '/v1/feedback', {
      kind: 'bug',
      message: '点了没反应',
      include_diagnostics: true,
      route: '/inbox',
      locale: 'zh-CN',
      screenshot: { content_type: 'image/png', data_base64: PNG_B64 },
    })
    expect(sent.status).toBe(200)
    expect(sent.data).toMatchObject({ delivered: false, item: { state: 'queued' } })
    const mine = await call(s, 'GET', '/v1/feedback')
    expect((mine.data as { items: unknown[] }).items).toHaveLength(1)
    expect(existsSync(join(dbDir, 'feedback/state.json'))).toBe(true)

    const bad = await call(s, 'POST', '/v1/feedback', {
      kind: 'nope',
      message: '',
      include_diagnostics: true,
      route: '/',
      locale: 'zh-CN',
    })
    expect(bad.status).toBe(400)
    const anon = await s.gateway.fetch(new Request('http://127.0.0.1/v1/feedback'))
    expect(anon.status).toBe(401)
  }, 60_000)
})

describe('演示里的云替身', () => {
  it('收下反馈、同一条只收一次；扮运营回一句之后，按 ticket 问得到回复与状态', async () => {
    const standIn = cloudStandIn({ autoLinkAfterMs: 0 })
    const c = clock()
    const notes: NotificationInput[] = []
    const svc = createFeedbackService({
      clock: c,
      cloudBase: () => CLOUD_STAND_IN_BASE_URL,
      fetch: standIn.fetch as unknown as FeedbackFetch,
      serverVersion: '0.2.1',
      errors: createErrorRing(),
      notify: (n) => notes.push(n),
      os: 'linux x64',
    })
    const out = await svc.port.submit(ACTOR, {
      kind: 'bug',
      message: '演示里的反馈',
      include_diagnostics: true,
      route: '/',
      locale: 'zh-CN',
    })
    expect(out.delivered).toBe(true)
    const [only] = standIn.feedback.list()
    expect(only?.message).toBe('演示里的反馈')
    expect(standIn.feedback.reply(only?.id ?? '', '收到，在看了', 'in_progress')).toBe(true)
    expect(standIn.feedback.reply('fb_nope', 'x')).toBe(false)
    c.advance(30_000)
    const mine = await svc.port.mine(ACTOR, { refresh: true })
    expect(mine.items[0]).toMatchObject({
      status: 'in_progress',
      replies: [{ text: '收到，在看了' }],
      unread_replies: 1,
    })
    expect(notes).toHaveLength(1)
  })
})
