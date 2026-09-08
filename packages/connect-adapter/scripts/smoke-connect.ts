/**
 * 08 §5 风险 1 / 35 WP12：对关键 provider 的关键 Action 做冒烟。
 *
 *   node --experimental-strip-types packages/connect-adapter/scripts/smoke-connect.ts
 *
 * 需要一个**真的**本地 OpenConnector runtime，且里面已经连好了对应账号
 * （凭据由不经模型的安全表单写进 runtime，本脚本永远不碰凭据值）。
 * 缺连接、缺入参、runtime 没起来时**跳过并打印原因**，不算失败。
 *
 * 环境变量：
 *   AGENTSWS_CONNECT_BASE_URL        默认 http://127.0.0.1:3000
 *   AGENTSWS_CONNECT_ADMIN_TOKEN_ENV 默认 OOMOL_CONNECT_ADMIN_TOKEN（**变量名**，不是值）
 *   AGENTSWS_SMOKE_SHOPIFY_ORDER_ID  shopify_admin.get_order 的订单 id（gid 或数字 id）
 *   AGENTSWS_SMOKE_GMAIL_QUERY       gmail.list_threads 的查询，默认 `newer_than:7d`
 *   AGENTSWS_SMOKE_WORKSPACE         默认 ws_local
 */

import type { Clock, Iso8601 } from '@agentsws/contracts'
import { assertRuntimeHardened, createConnectAdapter } from '../dist/index.js'

const systemClock: Clock = { now: (): Iso8601 => new Date().toISOString() }

const BASE_URL = process.env.AGENTSWS_CONNECT_BASE_URL ?? 'http://127.0.0.1:3000'
const ADMIN_TOKEN_ENV = process.env.AGENTSWS_CONNECT_ADMIN_TOKEN_ENV ?? 'OOMOL_CONNECT_ADMIN_TOKEN'
const WORKSPACE = process.env.AGENTSWS_SMOKE_WORKSPACE ?? 'ws_local'

interface Target {
  service: string
  action: string
  /** 缺必需入参时返回跳过原因。 */
  input(): { ok: true; value: Record<string, unknown> } | { ok: false; why: string }
}

const TARGETS: Target[] = [
  {
    service: 'shopify_admin',
    action: 'shopify_admin.get_order',
    input: () => {
      const id = process.env.AGENTSWS_SMOKE_SHOPIFY_ORDER_ID
      return id === undefined || id.length === 0
        ? { ok: false, why: '没有 AGENTSWS_SMOKE_SHOPIFY_ORDER_ID' }
        : { ok: true, value: { orderId: id } }
    },
  },
  {
    service: 'gmail',
    action: 'gmail.list_threads',
    input: () => ({
      ok: true,
      value: { query: process.env.AGENTSWS_SMOKE_GMAIL_QUERY ?? 'newer_than:7d', maxResults: 1 },
    }),
  },
]

function line(status: 'PASS' | 'SKIP' | 'FAIL', target: string, detail: string): void {
  process.stdout.write(`${status.padEnd(4)} ${target.padEnd(28)} ${detail}\n`)
}

async function main(): Promise<number> {
  process.stdout.write(`OpenConnector 冒烟 · ${BASE_URL}\n`)

  const hardened = await assertRuntimeHardened(BASE_URL, { adminTokenEnv: ADMIN_TOKEN_ENV })
  if (hardened.reasons.includes('runtime_unreachable')) {
    line('SKIP', '(全部)', `runtime 不可达：${BASE_URL}`)
    return 0
  }
  if (!hardened.ok) {
    // 冒烟不是安装器，不拦；但必须把没加固的点喊出来
    process.stdout.write(`WARN 加固未通过：${hardened.reasons.join(', ')}\n`)
    for (const c of hardened.checks.filter((x) => !x.ok)) {
      process.stdout.write(`     - ${c.name}: ${c.detail}\n`)
    }
  }
  if (process.env[ADMIN_TOKEN_ENV] === undefined) {
    line('SKIP', '(全部)', `环境变量 ${ADMIN_TOKEN_ENV} 没设，读不到 admin 面`)
    return 0
  }

  const connect = createConnectAdapter({
    baseUrl: BASE_URL,
    adminTokenEnv: ADMIN_TOKEN_ENV,
    clock: systemClock,
    workspaceId: WORKSPACE,
    services: TARGETS.map((t) => t.service),
  })

  const connections = await connect.connections(WORKSPACE)
  let failed = 0
  for (const target of TARGETS) {
    const label = target.action
    const conn = connections.find((c) => c.service === target.service && c.status === 'active')
    if (conn === undefined) {
      line('SKIP', label, `runtime 里没有已连接的 ${target.service}（需要真凭据）`)
      continue
    }
    const input = target.input()
    if (!input.ok) {
      line('SKIP', label, input.why)
      continue
    }
    const assignment_id = `asg_smoke_${target.service}`
    try {
      const token = await connect.issueToken({
        assignment_id,
        kind: 'role-read',
        allowed_actions: [target.action],
        allowed_connections: [conn.id],
        expires_in_seconds: 120,
      })
      const started = Date.now()
      const res = await connect.execute(target.action, input.value, {
        token: token.token,
        connection: conn.id,
      })
      // 不打印业务数据本身（可能含客户 PII），只打印形状
      const keys = typeof res.data === 'object' && res.data !== null ? Object.keys(res.data) : []
      line(
        'PASS',
        label,
        `${Date.now() - started}ms execution_id=${res.execution_id} keys=[${keys.join(',')}]`,
      )
    } catch (e) {
      failed += 1
      const err = e as { code?: string; message?: string }
      line('FAIL', label, `${err.code ?? 'error'}: ${err.message ?? String(e)}`)
    } finally {
      await connect.revokeTokens(assignment_id)
    }
  }
  return failed === 0 ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    process.stderr.write(`冒烟脚本崩了：${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  },
)
