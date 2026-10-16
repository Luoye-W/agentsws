/**
 * 决策 945：NAS 版开给局域网后，本机登录页等于没有门槛（WP358 报告第五节）。
 *
 * 钉住四件事：
 * 1. 服务只听本机（桌面版）时**一点不变**：一按就拿到一次性 token、bootstrap 给主人邮箱；
 * 2. 听 0.0.0.0（Docker 镜像默认）或显式 `AGENTSWS_LOGIN_MODE=shared`：token 不进响应、
 *    bootstrap 不给主人邮箱；
 * 3. 主人用日志里的一次性设置码进门：用一次就废、下一个印在日志里、连错 5 次换码；
 * 4. 同事只能走邀请链接：接受完直接拿登录 token。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createOwnerSetupCode, loginModeOf, SETUP_CODE_MAX_FAILURES } from '../src/setup-code.js'

const OWNER = 'boss@nordvolt.example'
let server: Server | undefined
let staticDir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (staticDir !== undefined) rmSync(staticDir, { recursive: true, force: true })
  staticDir = undefined
})

async function boot(env: Record<string, string>, log?: string[]): Promise<Server> {
  staticDir = mkdtempSync(join(tmpdir(), 'agentsws-wp945-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>t</title>', 'utf8')
  server = await createServer({
    env: { AGENTSWS_OWNER_EMAIL: OWNER, ...env },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    staticDir,
    ...(log === undefined ? {} : { setupCodeLog: (line: string) => log.push(line) }),
  })
  return server
}

const post = async (s: Server, path: string, body: unknown): Promise<Response> =>
  s.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const bootstrapOf = async (s: Server): Promise<Record<string, unknown>> =>
  (await s.gateway.fetch(new Request('http://127.0.0.1/app/bootstrap.json'))).json() as Promise<
    Record<string, unknown>
  >

const codeIn = (line: string | undefined): string => {
  const m = /主人设置码：([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(line ?? '')
  if (m?.[1] === undefined) throw new Error(`日志里没有设置码：${line}`)
  return m[1]
}

describe('loginModeOf：只给本机才是本机档', () => {
  it('回环口 = local；0.0.0.0 / :: = shared', () => {
    expect(loginModeOf({}, '127.0.0.1')).toBe('local')
    expect(loginModeOf({}, '::1')).toBe('local')
    expect(loginModeOf({}, '0.0.0.0')).toBe('shared')
    expect(loginModeOf({}, '::')).toBe('shared')
  })

  it('AGENTSWS_LOGIN_MODE=shared 能收紧（本机前面挂了反向代理时用）；auto / 空 = 自动', () => {
    expect(loginModeOf({ AGENTSWS_LOGIN_MODE: 'shared' }, '127.0.0.1')).toBe('shared')
    expect(loginModeOf({ AGENTSWS_LOGIN_MODE: 'SHARED' }, '127.0.0.1')).toBe('shared')
    expect(loginModeOf({ AGENTSWS_LOGIN_MODE: 'auto' }, '127.0.0.1')).toBe('local')
    expect(loginModeOf({ AGENTSWS_LOGIN_MODE: '' }, '0.0.0.0')).toBe('shared')
  })

  it('没有往宽里放的开关：local 或乱写一律起不来', () => {
    expect(() => loginModeOf({ AGENTSWS_LOGIN_MODE: 'local' }, '0.0.0.0')).toThrow(/只接受/)
    expect(() => loginModeOf({ AGENTSWS_LOGIN_MODE: 'open' }, '127.0.0.1')).toThrow(/只接受/)
  })
})

describe('一次性设置码', () => {
  const make = (log: string[]) =>
    createOwnerSetupCode({ ownerEmail: async () => OWNER, log: (l) => log.push(l) })

  it('announce 只印一次；码对上返回主人邮箱，用一次就废，下一个印出来', async () => {
    const log: string[] = []
    const codes = make(log)
    expect(await codes.redeem('ABCD-EFGH')).toBeUndefined() // 还没印码之前谁也进不来
    codes.announce()
    codes.announce()
    expect(log).toHaveLength(1)
    const first = codeIn(log[0])
    // 抄的时候带小写 / 空格 / 不带横杠都认
    expect(await codes.redeem(` ${first.toLowerCase().replace('-', '')} `)).toBe(OWNER)
    expect(await codes.redeem(first)).toBeUndefined()
    expect(log).toHaveLength(2)
    const second = codeIn(log[1])
    expect(second).not.toBe(first)
    expect(await codes.redeem(second)).toBe(OWNER)
  })

  it(`连错 ${SETUP_CODE_MAX_FAILURES} 次旧码作废、印新码`, async () => {
    const log: string[] = []
    const codes = make(log)
    codes.announce()
    const first = codeIn(log[0])
    for (let i = 0; i < SETUP_CODE_MAX_FAILURES; i++)
      expect(await codes.redeem('ZZZZ-ZZZZ')).toBeUndefined()
    expect(log).toHaveLength(2)
    expect(await codes.redeem(first)).toBeUndefined()
    expect(await codes.redeem(codeIn(log[1]))).toBe(OWNER)
  })

  it('码里没有形近字（0 / O / 1 / I / L / U）', () => {
    const log: string[] = []
    for (let i = 0; i < 30; i++) make(log).announce()
    for (const line of log) expect(codeIn(line)).not.toMatch(/[01OILU]/)
  })
})

describe('本机档（桌面版）：一点不变', () => {
  it('一按就拿到一次性 token；bootstrap 给主人邮箱；设置码那条不开', async () => {
    const log: string[] = []
    const s = await boot({}, log)
    expect(s.loginMode).toBe('local')
    const issued = await dataOf<{ token?: string }>(
      await post(s, '/v1/auth/magic-link', { email: OWNER }),
    )
    expect(issued.token).toBeTruthy()
    expect((await bootstrapOf(s)).owner_email).toBe(OWNER)
    expect((await post(s, '/v1/auth/setup-code', { code: 'ABCD-EFGH' })).status).toBe(501)
    expect(log).toEqual([])
  })
})

describe('局域网档（NAS / Docker）', () => {
  it('听 0.0.0.0 就是局域网档：填主人邮箱拿不到 token，bootstrap 不给主人邮箱', async () => {
    const s = await boot({ AGENTSWS_BIND_HOST: '0.0.0.0' }, [])
    expect(s.loginMode).toBe('shared')
    const issued = await dataOf<{ token?: string }>(
      await post(s, '/v1/auth/magic-link', { email: OWNER }),
    )
    expect(issued.token).toBeUndefined()
    const boot_ = await bootstrapOf(s)
    expect(boot_.owner_email).toBeUndefined()
    expect(boot_.login).toBe('shared')
    expect(JSON.stringify(boot_)).not.toContain(OWNER)
  })

  it('主人：日志里的设置码换成主人会话；同一个码第二次不行；新码接着能用', async () => {
    const log: string[] = []
    // 显式收紧 + 只听回环，测试里不往局域网开端口
    const s = await boot({ AGENTSWS_LOGIN_MODE: 'shared' }, log)
    expect(log).toEqual([]) // listen 之前不印
    await s.listen(0)
    expect(log).toHaveLength(1)
    const code = codeIn(log[0])

    const issued = await post(s, '/v1/auth/setup-code', { code })
    expect(issued.status).toBe(200)
    const { token } = await dataOf<{ token: string }>(issued)
    const session = await dataOf<{ person: { id: string; email: string } }>(
      await post(s, '/v1/auth/verify', { token }),
    )
    expect(session.person.id).toBe(s.bootstrap.person.id)
    expect(session.person.email).toBe(OWNER)

    expect((await post(s, '/v1/auth/setup-code', { code })).status).toBe(401)
    expect((await post(s, '/v1/auth/setup-code', { code: codeIn(log[1]) })).status).toBe(200)
  })

  it('同事：邀请接受完直接带一次性登录 token，换成的是同事自己', async () => {
    const s = await boot({ AGENTSWS_BIND_HOST: '0.0.0.0' }, [])
    const invited = await dataOf<{ url: string }>(
      await s.gateway.fetch(
        new Request(`http://127.0.0.1/v1/workspaces/${s.bootstrap.workspace.id}/invitations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${s.bootstrap.internalToken}`,
            'x-assignment': s.bootstrap.ownerAssignment.id,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: 'chen@nordvolt.example' }),
        }),
      ),
    )
    const invite = invited.url.slice(invited.url.lastIndexOf('/') + 1)
    const accepted = await dataOf<{ person_id: string; login_token?: string }>(
      await post(s, `/v1/invitations/${invite}/accept`, {}),
    )
    expect(accepted.login_token).toBeTruthy()
    const session = await dataOf<{ person: { id: string } }>(
      await post(s, '/v1/auth/verify', { token: accepted.login_token }),
    )
    expect(session.person.id).toBe(accepted.person_id)
    expect(session.person.id).not.toBe(s.bootstrap.person.id)
  })
})
