import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertRuntimeHardened,
  createConnectAdapter,
  createRecordingFetch,
  SecretRegistry,
} from '../src/index.js'
import type { FixtureMeta } from './helpers.js'
import { TestClock } from './helpers.js'
import type { ScenarioCtx } from './scenarios.js'
import { driveScenarios } from './scenarios.js'

/**
 * fixture 录制。**只在 `RECORD_FIXTURES=1` 且本机有 docker 时跑**，平时整档跳过。
 *
 * 它起一个真的 `ghcr.io/oomol-lab/open-connector` 容器（端口 / admin token / 加密密钥都是随机的、
 * `OOMOL_CONNECT_BLOCKED_PROXIES=*`），外加一个本地 stub provider 当 Gotify 上游，
 * 然后用**适配器自己**把 `driveScenarios` 跑一遍，把脱敏后的 HTTP 交互写成磁带。
 */
const RECORD = process.env.RECORD_FIXTURES === '1'
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const IMAGE = process.env.OC_IMAGE ?? 'ghcr.io/oomol-lab/open-connector:latest'
const CONTAINER = 'agentsws-wp12-record'
const PORT = Number(process.env.OC_PORT ?? 39_217)
const STUB_PORT = Number(process.env.OC_STUB_PORT ?? 39_218)
const ADMIN_ENV = 'AGENTSWS_TEST_OC_ADMIN_TOKEN'
const CLOCK_START = '2026-09-09T09:00:00.000Z'

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function startStub(): Server {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    const url = new URL(req.url ?? '/', 'http://stub')
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/version') {
      return send(200, { version: '2.4.0', commit: 'stubcommit', buildDate: '2026-01-01' })
    }
    if (url.pathname === '/health') return send(200, { health: 'green', database: 'green' })
    if (url.pathname === '/message') {
      let raw = ''
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8')
      })
      req.on('end', () => {
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(raw || '{}') as Record<string, unknown>
        } catch {
          parsed = {}
        }
        send(200, {
          id: 1,
          appid: 1,
          message: parsed.message ?? '',
          title: parsed.title ?? '',
          date: '2026-01-01T00:00:00Z',
        })
      })
      return
    }
    return send(200, { ok: true, path: url.pathname, hits })
  })
  server.listen(STUB_PORT, '0.0.0.0')
  return server
}

async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`${base}/v1/health`)
      if (res.ok) return
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('OpenConnector runtime 没能在 30s 内变健康')
}

describe.skipIf(!RECORD)('录制真 runtime 的 HTTP fixture', () => {
  it('起容器 → 跑全部场景 → 写磁带', async () => {
    const admin = `oc_admin_${randomBytes(12).toString('hex')}`
    const encryption = randomBytes(32).toString('hex')
    const base = `http://127.0.0.1:${PORT}`
    const stub = startStub()
    try {
      docker('rm', '-f', CONTAINER)
    } catch {
      // 没有残留容器
    }
    docker(
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-p',
      `${PORT}:3000`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-e',
      `OOMOL_CONNECT_ENCRYPTION_KEY=${encryption}`,
      '-e',
      `OOMOL_CONNECT_ADMIN_TOKEN=${admin}`,
      '-e',
      'OOMOL_CONNECT_BLOCKED_PROXIES=*',
      '-e',
      'OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true',
      IMAGE,
    )
    try {
      await waitHealthy(base)

      // ---- 装配（用裸 fetch，不进磁带）：两条 gotify 连接 + 一条别的 service 的连接
      const upstream = `http://host.docker.internal:${STUB_PORT}`
      const adminHeaders = {
        authorization: `Bearer ${admin}`,
        'content-type': 'application/json',
      }
      const put = async (path: string, body: unknown): Promise<unknown> => {
        const res = await fetch(`${base}${path}`, {
          method: 'PUT',
          headers: adminHeaders,
          body: JSON.stringify(body),
        })
        return res.json()
      }
      await put('/api/connections/gotify', {
        authType: 'api_key',
        values: { apiKey: 'stub-gotify-token', baseUrl: upstream },
      })
      await put('/api/connections/gotify', {
        authType: 'api_key',
        connectionName: 'eu',
        values: { apiKey: 'stub-gotify-token-eu', baseUrl: upstream },
      })
      // postmark 的凭据校验器不打上游，正好当"另一个 service 的连接"
      await put('/api/connections/postmark', {
        authType: 'api_key',
        values: { apiKey: 'stub-postmark-token' },
      })
      // 一个假的 gmail OAuth 应用：够 runtime 生成真的授权 URL（不会真去 Google）
      await put('/api/oauth/configs/gmail', {
        clientId: 'fake-client-id.apps.googleusercontent.com',
        clientSecret: 'fake-oauth-client-secret',
      })
      const listed = (await (
        await fetch(`${base}/api/connections`, { headers: adminHeaders })
      ).json()) as { id: string; service: string; connectionName: string }[]
      const idOf = (service: string, name: string): string => {
        const hit = listed.find((c) => c.service === service && c.connectionName === name)
        if (hit === undefined) throw new Error(`装配失败：找不到 ${service}/${name}`)
        return hit.id
      }

      const ctx: ScenarioCtx = {
        workspace_id: 'ws_local',
        assignment_id: 'asg_conformance',
        service: 'gotify',
        read_action: 'gotify.get_version',
        read_input: {},
        write_action: 'gotify.send_message',
        write_input: { message: 'conformance' },
        unknown_action: 'gotify.__no_such_action__',
        connection_id: idOf('gotify', 'default'),
        other_connection_id: idOf('gotify', 'eu'),
        other_service_connection_id: idOf('postmark', 'default'),
        api_key_service: 'gotify',
        oauth_service: 'gmail',
      }

      // ---- 录制
      process.env[ADMIN_ENV] = admin
      const secrets = new SecretRegistry()
      const adminPlaceholder = secrets.register(admin, 'admin')
      secrets.register(encryption, 'enc')
      const clock = new TestClock(CLOCK_START)
      const recorder = createRecordingFetch({
        base: (url, init) => fetch(url, init),
        secrets,
        now: () => clock.now(),
      })
      const connect = createConnectAdapter({
        baseUrl: base,
        adminTokenEnv: ADMIN_ENV,
        clock,
        fetchImpl: recorder.fetch,
        workspaceId: ctx.workspace_id,
        services: ['gotify'],
      })
      await driveScenarios(connect, ctx)
      // 加固探针（此时 runtime 已经有 token，/v1 必须 401）
      const report = await assertRuntimeHardened(base, {
        fetchImpl: recorder.fetch,
        adminTokenEnv: ADMIN_ENV,
        env: {
          [ADMIN_ENV]: admin,
          OOMOL_CONNECT_ENCRYPTION_KEY: encryption,
          OOMOL_CONNECT_BLOCKED_PROXIES: '*',
        },
      })
      expect(report.checks.filter((c) => !c.ok)).toEqual([])
      expect(report.ok).toBe(true)

      const cassette = recorder.cassette()
      const meta: FixtureMeta = {
        base_url: base,
        admin_token_env: ADMIN_ENV,
        admin_token_placeholder: adminPlaceholder,
        workspace_id: ctx.workspace_id,
        service: ctx.service,
        read_action: ctx.read_action,
        write_action: ctx.write_action,
        unknown_action: ctx.unknown_action,
        connection_id: ctx.connection_id,
        other_connection_id: ctx.other_connection_id,
        other_service_connection_id: ctx.other_service_connection_id,
        assignment_id: ctx.assignment_id,
        oauth_service: 'gmail',
        clock_start: CLOCK_START,
        runtime_kind: 'docker',
      }
      mkdirSync(FIXTURES, { recursive: true })
      writeFileSync(
        join(FIXTURES, 'runtime.cassette.json'),
        `${JSON.stringify(cassette, null, 2)}\n`,
        'utf8',
      )
      writeFileSync(
        join(FIXTURES, 'runtime.meta.json'),
        `${JSON.stringify(meta, null, 2)}\n`,
        'utf8',
      )
      // 磁带里不许留任何秘密原文
      const text = JSON.stringify(cassette)
      expect(text).not.toContain(admin)
      expect(text).not.toContain(encryption)
      expect(text).not.toContain('stub-gotify-token')
      expect(text).not.toContain('fake-oauth-client-secret')
      expect(cassette.exchanges.length).toBeGreaterThan(10)
    } finally {
      try {
        docker('rm', '-f', CONTAINER)
      } catch {
        // 已经没了
      }
      stub.close()
      delete process.env[ADMIN_ENV]
    }
  }, 180_000)
})
