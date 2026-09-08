import type { Connect } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { ScenarioCtx } from './scenarios.js'
import {
  applyTokenInput,
  IDEMPOTENCY_KEY,
  idempotencyTokenInput,
  readTokenInput,
} from './scenarios.js'

/**
 * 18 §1 `Connect` 的**契约一致性套件**：接受任意 `Connect` 实现，
 * 对 stand-ins 的 mock 与真实 connect-adapter（fixture 回放）各跑一遍。
 * 两边行为必须一致——替身与真实现之间的任何漂移都应该在这里露出来。
 */
export interface ConformanceHarness {
  name: string
  ctx: ScenarioCtx
  /** 每个用例一份全新实例（mock 是新对象，适配器是新磁带游标）。 */
  make(): Promise<Connect> | Connect
  /**
   * 这些字符串不允许出现在任何返回值 / 事件里（凭据零泄漏）。
   * 每次 `make` 之后由 harness 收集；返回空数组表示这一档不检查。
   */
  secrets?(connect: Connect): string[]
  /** harness 侧收集到的事件（有就检查凭据泄漏）。 */
  emitted?(connect: Connect): unknown[]
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code })
}

export function runConnectConformance(h: ConformanceHarness): void {
  const ctx = h.ctx

  describe(`Connect 契约一致性 · ${h.name}`, () => {
    it('providers()：至少含目标 service，且每条都有 auth 与 executable', async () => {
      const connect = await h.make()
      const providers = await connect.providers()
      const hit = providers.find((p) => p.service === ctx.service)
      expect(hit).toBeDefined()
      expect(['no_auth', 'api_key', 'oauth2', 'custom_credential']).toContain(hit?.auth)
      expect(typeof hit?.executable).toBe('boolean')
    })

    it('actions(service)：side_effect 由覆盖表决定，读是 read、写是 write', async () => {
      const connect = await h.make()
      const actions = await connect.actions(ctx.service)
      expect(actions.length).toBeGreaterThan(0)
      expect(actions.find((a) => a.id === ctx.read_action)?.side_effect).toBe('read')
      expect(actions.find((a) => a.id === ctx.write_action)?.side_effect).toBe('write')
      for (const a of actions) expect(a.service).toBe(ctx.service)
    })

    it('connections()：按 workspace 过滤，且不含任何凭据字段', async () => {
      const connect = await h.make()
      const conns = await connect.connections(ctx.workspace_id)
      expect(conns.some((c) => c.id === ctx.connection_id)).toBe(true)
      for (const c of conns) expect(c.workspace_id).toBe(ctx.workspace_id)
      // 13 §4.3：连接对象里只允许出现身份，不允许出现凭据字段
      const keys = new Set<string>()
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) {
          for (const item of v) walk(item)
          return
        }
        if (typeof v !== 'object' || v === null) return
        for (const [k, child] of Object.entries(v)) {
          keys.add(k)
          walk(child)
        }
      }
      walk(conns)
      for (const forbidden of [
        'apiKey',
        'api_key',
        'clientSecret',
        'client_secret',
        'accessToken',
        'access_token',
        'refreshToken',
        'refresh_token',
        'credential',
        'credentials',
        'values',
        'secret',
      ]) {
        expect([...keys]).not.toContain(forbidden)
      }
    })

    it('beginConnect()：给出 request_id + 授权 URL 或 secure form；未知 request_id 的 poll 是 expired', async () => {
      const connect = await h.make()
      const started = await connect.beginConnect(ctx.api_key_service, {
        workspace_id: ctx.workspace_id,
        ownership: 'workspace',
        alias: 'conformance_api_key',
        mode: 'own_app',
      })
      expect(started.request_id.length).toBeGreaterThan(0)
      expect(started.authorization_url !== undefined || started.secure_form !== undefined).toBe(
        true,
      )
      if (started.secure_form !== undefined) {
        // 13 §4.3：只描述表单，值永远不经这一层
        expect(started.secure_form.fields.some((f) => f.secret)).toBe(true)
      }
      expect(await connect.pollConnect('creq_definitely_unknown')).toBe('expired')
    })

    it('空 allowed_connections 拒签（上游空列表 = 不限制）', async () => {
      const connect = await h.make()
      await expectCode(
        connect.issueToken({ ...readTokenInput(ctx), allowed_connections: [] }),
        'invalid_input',
      )
    })

    it('空 allowed_actions、未知连接同样拒签', async () => {
      const connect = await h.make()
      await expectCode(
        connect.issueToken({ ...readTokenInput(ctx), allowed_actions: [] }),
        'invalid_input',
      )
      await expectCode(
        connect.issueToken({ ...readTokenInput(ctx), allowed_connections: ['conn_ghost_0000'] }),
        'invalid_input',
      )
    })

    it('role-read 混入写 Action：签发期或执行期至少一处被拒', async () => {
      const connect = await h.make()
      let token: string | undefined
      try {
        const issued = await connect.issueToken({
          ...readTokenInput(ctx),
          allowed_actions: [ctx.write_action],
        })
        token = issued.token
      } catch (e) {
        expect(e).toMatchObject({ code: 'invalid_input' })
      }
      if (token !== undefined) {
        await expectCode(connect.execute(ctx.write_action, ctx.write_input, { token }), 'forbidden')
      }
    })

    it('签发结果回带三个 allowed_*，allowed_proxies 恒空', async () => {
      const connect = await h.make()
      const issued = await connect.issueToken(readTokenInput(ctx))
      expect(issued.kind).toBe('role-read')
      expect(issued.assignment_id).toBe(ctx.assignment_id)
      expect(issued.allowed_actions).toEqual([ctx.read_action])
      expect(issued.allowed_connections).toEqual([ctx.connection_id])
      expect(issued.allowed_proxies).toEqual([])
      expect(Date.parse(issued.expires_at)).toBeGreaterThan(0)
      expect(issued.token.length).toBeGreaterThan(0)
    })

    it('execute()：读 Action 成功，带回 execution_id', async () => {
      const connect = await h.make()
      const token = await connect.issueToken(readTokenInput(ctx))
      const res = await connect.execute(ctx.read_action, ctx.read_input, { token: token.token })
      expect(res.execution_id.length).toBeGreaterThan(0)
      expect(res.data).toBeDefined()
      expect(JSON.stringify(res)).not.toContain(token.token)
    })

    it('execute()：不在 allowed_actions / 未知 Action / 无效 token 一律拒', async () => {
      const connect = await h.make()
      const read = await connect.issueToken(readTokenInput(ctx))
      const apply = await connect.issueToken(applyTokenInput(ctx))
      await expectCode(
        connect.execute(ctx.write_action, ctx.write_input, { token: read.token }),
        'forbidden',
      )
      await expectCode(connect.execute(ctx.unknown_action, {}, { token: apply.token }), 'not_found')
      await expectCode(
        connect.execute(ctx.read_action, ctx.read_input, { token: 'oct_bogus_token' }),
        'forbidden',
      )
    })

    it('execute()：未授权的连接、跨 service 的连接都是 connection_not_allowed', async () => {
      const connect = await h.make()
      const read = await connect.issueToken(readTokenInput(ctx))
      await expectCode(
        connect.execute(ctx.read_action, ctx.read_input, {
          token: read.token,
          connection: ctx.other_connection_id,
        }),
        'connection_not_allowed',
      )
      await expectCode(
        connect.execute(ctx.read_action, ctx.read_input, {
          token: read.token,
          connection: ctx.other_service_connection_id,
        }),
        'connection_not_allowed',
      )
    })

    it('幂等键：同键重放拿到同一个 execution_id，换 Action 是 idempotency_conflict', async () => {
      const connect = await h.make()
      const token = await connect.issueToken(idempotencyTokenInput(ctx))
      const first = await connect.execute(ctx.write_action, ctx.write_input, {
        token: token.token,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      const again = await connect.execute(ctx.write_action, ctx.write_input, {
        token: token.token,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      expect(again.execution_id).toBe(first.execution_id)
      await expectCode(
        connect.execute(ctx.read_action, ctx.read_input, {
          token: token.token,
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
        'idempotency_conflict',
      )
    })

    it('proxy 一律拒（role-read 的 allowed_proxies 为空）', async () => {
      const connect = await h.make()
      const token = await connect.issueToken(readTokenInput(ctx))
      const withProxy = connect as Connect & {
        proxy(service: string, req: unknown, opts: { token: string }): Promise<never>
      }
      await expectCode(
        withProxy.proxy(ctx.service, { endpoint: '/x', method: 'GET' }, { token: token.token }),
        'forbidden',
      )
    })

    it('transferConnection：workspace 类连接可转移，转移后按新 workspace 归属', async () => {
      const connect = await h.make()
      const moved = await connect.transferConnection(ctx.connection_id, 'ws_transfer_target')
      expect(moved.id).toBe(ctx.connection_id)
      const back = await connect.transferConnection(ctx.connection_id, ctx.workspace_id)
      expect(back.workspace_id).toBe(ctx.workspace_id)
    })

    it('revokeTokens：撤销后立即失效', async () => {
      const connect = await h.make()
      const token = await connect.issueToken(readTokenInput(ctx))
      await connect.revokeTokens(ctx.assignment_id)
      await expectCode(
        connect.execute(ctx.read_action, ctx.read_input, { token: token.token }),
        'forbidden',
      )
    })

    it('凭据零泄漏：返回值与事件里都找不到秘密原文', async () => {
      if (h.secrets === undefined) return
      const connect = await h.make()
      const token = await connect.issueToken(readTokenInput(ctx))
      const res = await connect.execute(ctx.read_action, ctx.read_input, { token: token.token })
      const conns = await connect.connections(ctx.workspace_id)
      const secrets = h.secrets(connect)
      const emitted = h.emitted === undefined ? [] : h.emitted(connect)
      const haystacks = [JSON.stringify(res), JSON.stringify(conns), JSON.stringify(emitted)]
      for (const secret of [...secrets, token.token]) {
        if (secret.length === 0) continue
        for (const hay of haystacks) expect(hay).not.toContain(secret)
      }
    })
  })
}
