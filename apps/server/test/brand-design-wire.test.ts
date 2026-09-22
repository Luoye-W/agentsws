/**
 * WP122b 交付 ① + ②：三个注入口通电与四类岗位只读（71 §9 第 7 / 9 条）。
 *
 * 跑的是**真装配线**（路由 → `assembleBrand` → `createRuntime` → stub 适配器），
 * 与 `vertical.test.ts` 同一个办法：在 `runtime.adapter` 外面套一层壳把请求抄下来。
 *
 - **通电**（71 §9 第 7 条）：这个品牌有一份 `DESIGN.md` 时，建站 / 社媒 / 投放
   三族职责的运行请求里多出一段 `brand-design`，替身模型装配的 messages 里
   真带得上色值与岗位要点——不是"参数摆好了没人递"。设计族不注（出图那一路
   在 `design.ts` 已逐图注入）；没有规范时整段不出。
 */
import type { RunRequest } from '@agentsws/contracts'
import { assemblePrompt } from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-21T09:00:00.000Z'

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

/** 一份最小但合法的 DESIGN.md（走整份替换的口进来，与用户粘贴同一条路）。 */
const DESIGN_MD = `---
version: alpha
name: NordVolt
colors:
  primary: "#0a7d33"
  surface: "#ffffff"
typography:
  h1:
    fontFamily: Inter
    fontSize: 40px
spacing:
  md: 16px
---

## Overview

来自测试夹具。
`

let server: Server | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

/** 起一台真运行时的服务进程，并把每一次的 RunRequest 抄一份。 */
async function boot(): Promise<{
  server: Server
  call: (method: string, path: string, body?: unknown, token?: string) => Promise<Response>
  data: <T>(res: Response) => Promise<T>
  invite: (
    email: string,
    position_id: string,
  ) => Promise<{ token: string; assignment_id: string; role_id: string }>
  run: (assignment_id: string) => Promise<RunRequest>
}> {
  const s = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'wang@nordvolt.cn' },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  server = s
  const runtime = s.runtime
  if (runtime === undefined) throw new Error('这个进程该有运行时')

  const requests: RunRequest[] = []
  const real = runtime.adapter.run.bind(runtime.adapter)
  runtime.adapter.run = (req, sink, signal) => {
    requests.push(req)
    return real(req, sink, signal)
  }

  const ownerAssignment = s.bootstrap.ownerAssignment.id
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${token ?? s.bootstrap.internalToken}`,
      'X-Assignment': ownerAssignment,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const data = async <T>(res: Response): Promise<T> => {
    const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
    if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
    return parsed.data
  }
  const invite = async (
    email: string,
    position_id: string,
  ): Promise<{ token: string; assignment_id: string; role_id: string }> => {
    const invitation = await data<{ url: string }>(
      await call('POST', `/v1/workspaces/${s.bootstrap.workspace.id}/invitations`, { email }),
    )
    const acceptToken = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
    const person_id = (
      await data<{ person_id: string }>(
        await s.gateway.fetch(
          new Request(`http://127.0.0.1/v1/invitations/${acceptToken}/accept`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }),
        ),
      )
    ).person_id
    const login = await data<{ token: string }>(
      await s.gateway.fetch(
        new Request('http://127.0.0.1/v1/auth/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        }),
      ),
    )
    const session = await data<{ session_token: string }>(
      await s.gateway.fetch(
        new Request('http://127.0.0.1/v1/auth/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: login.token }),
        }),
      ),
    )
    const granted = await data<{ assignment_id: string; role_id: string }[]>(
      await call('POST', '/v1/assignments', {
        person_id,
        position_id,
        ranges: [{ kind: 'store', id: 'store_main' }],
      }),
    )
    const first = granted[0]
    if (first === undefined) throw new Error('分配没建成')
    return {
      token: session.session_token,
      assignment_id: first.assignment_id,
      role_id: first.role_id,
    }
  }
  const run = async (assignment_id: string): Promise<RunRequest> => {
    const before = requests.length
    const matter = s.work.createMatter({ kind: 'conversation', title: '一次出活' })
    await runtime.startRun({
      matter,
      brief: '出一条内容',
      actor: { person_id: s.bootstrap.person.id, assignment_id },
    })
    const req = requests[before]
    if (req === undefined) throw new Error('这次运行没到适配器')
    return req
  }
  return { server: s, call, data, invite, run }
}

const sectionOf = (req: RunRequest, id = 'brand-design'): string | undefined =>
  req.persona.sections.find((s) => s.id === id)?.text

describe('WP122b ①：三个注入口通电', () => {
  it('社媒职责的运行请求带品牌令牌与岗位要点；替身模型收到的 messages 里也有', async () => {
    const m = await boot()
    const mate = await m.invite('she@nordvolt.cn', 'social-media')
    expect(mate.role_id).toBe('social.meta')
    // 先跑一轮：没有规范时不注
    const before = await m.run(mate.assignment_id)
    expect(sectionOf(before)).toBeUndefined()

    // owner 贴一份 DESIGN.md 进来（与界面上"整份替换"同一条路）
    const put = await m.call('PUT', '/v1/brand-design', { markdown: DESIGN_MD })
    expect(put.status).toBe(200)

    const after = await m.run(mate.assignment_id)
    const text = sectionOf(after)
    expect(text).toBeDefined()
    expect(text).toContain('#0a7d33')
    expect(text).toContain('Inter')
    expect(text).toContain('社媒')

    // 替身模型实际收到的 messages：persona.sections 全量进 system 消息
    const { messages } = assemblePrompt(after)
    expect(messages.some((msg) => msg.content.includes('#0a7d33'))).toBe(true)
  })

  it('建站职责额外带主题变量名（WP89 沙箱吃的那份）；投放职责带投放要点', async () => {
    const m = await boot()
    await m.call('PUT', '/v1/brand-design', { markdown: DESIGN_MD })
    const site = await m.invite('builder@nordvolt.cn', 'site')
    expect(site.role_id).toBe('site.shopify-build')
    const siteReq = await m.run(site.assignment_id)
    const siteText = sectionOf(siteReq)
    expect(siteText).toContain('--color-primary: #0a7d33')
    expect(siteText).toContain('间距与圆角')

    const ads = await m.invite('ads@nordvolt.cn', 'ads')
    const adsReq = await m.run(ads.assignment_id)
    expect(sectionOf(adsReq)).toContain('对比度')
  })

  it('设计族不重复注（出图那一路已注入）；四族之外的职责不注', async () => {
    const m = await boot()
    await m.call('PUT', '/v1/brand-design', { markdown: DESIGN_MD })
    const designer = await m.invite('paint@nordvolt.cn', 'design')
    const designReq = await m.run(designer.assignment_id)
    expect(sectionOf(designReq)).toBeUndefined()

    const support = await m.invite('care@nordvolt.cn', 'customer-care')
    const supportReq = await m.run(support.assignment_id)
    expect(sectionOf(supportReq)).toBeUndefined()
  })
})
describe('WP122b ②：四类岗位只读设计规范', () => {
  it('设计职责能读；客服职责仍 403；owner 能读也能改', async () => {
    const m = await boot()
    await m.call('PUT', '/v1/brand-design', { markdown: DESIGN_MD })
    const designer = await m.invite('paint@nordvolt.cn', 'design')
    const care = await m.invite('care@nordvolt.cn', 'customer-care')

    // 设计：读得到（用她本人的 token + 她自己的 assignment）
    const read = await m.server.gateway.fetch(
      new Request('http://127.0.0.1/v1/brand-design', {
        headers: {
          Authorization: `Bearer ${designer.token}`,
          'X-Assignment': designer.assignment_id,
        },
      }),
    )
    expect(read.status).toBe(200)

    // 客服：仍然拒
    const denied = await m.server.gateway.fetch(
      new Request('http://127.0.0.1/v1/brand-design', {
        headers: {
          Authorization: `Bearer ${care.token}`,
          'X-Assignment': care.assignment_id,
        },
      }),
    )
    expect(denied.status).toBe(403)

    // 写：四类职责也不能改——改一格仍是 owner 一级
    const edit = await m.server.gateway.fetch(
      new Request('http://127.0.0.1/v1/brand-design/tokens/colors.primary', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${designer.token}`,
          'X-Assignment': designer.assignment_id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ value: '#ff0000' }),
      }),
    )
    expect(edit.status).toBe(403)

    const ownerEdit = await m.call('PATCH', '/v1/brand-design/tokens/colors.primary', {
      path: 'colors.primary',
      value: '#ff0000',
    })
    expect(ownerEdit.status).toBe(200)
  })
})
