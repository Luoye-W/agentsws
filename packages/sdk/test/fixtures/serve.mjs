#!/usr/bin/env node
/**
 * 「被测的那一端」：一个最小的服务进程 + 一张待批的卡。
 *
 * 它由 `third-party.test.ts` 用 `spawn` 起在**另一个进程**里——那条用例的全部意义就是
 * 「测试进程一个 workspace 包都不 import，只靠 openapi.json 与 fetch 把活干完」，
 * 所以装配代码必须在这一侧，不能在测试文件里。
 *
 * 启动后往 stdout 打一行 JSON：`{ url, email, workspace_id, assignment_id, approval_id }`。
 * 端口用 0（系统分配），只听回环口。
 */
import { createServer } from '@agentsws/server'

const T0 = '2026-09-07T09:00:00.000Z'
const t = Date.parse(T0)
const clock = { now: () => new Date(t).toISOString() }

let seed = 20260907 >>> 0
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let x = seed
  x = Math.imul(x ^ (x >>> 15), x | 1)
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

const server = await createServer({
  quiet: true,
  clock,
  random,
  env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
  scheduleIntervalMs: 0,
})

const { person, workspace, ownerAssignment } = server.bootstrap

// 队列里得有点东西可批，否则「批一张卡」无从谈起。
const item = await server.txn.approvals.create({
  workspace_id: workspace.id,
  schema_version: 1,
  // 用 policy_change 而不是 outbound_draft：后者要过 31 §3.3 的收件人门禁
  // （收件人不在 provenance 里就 blocked，不进队列——14 §11 用例 8），
  // 这条用例要验的是「第三方能不能接」，不是门禁本身。
  kind: 'policy_change',
  role_id: ownerAssignment.role_id,
  subject: { object: { type: 'policy', id: 'return_window' } },
  dedupe_key: `${workspace.id}:policy_change:third_party`,
  title: '退货窗口写成 14 天',
  summary: '客服每天解释一遍，写进策略层省一次解释。',
  payload: {
    target: 'workspace_policy',
    before: null,
    after: { return_window_days: 14 },
    affected_assignments: [ownerAssignment.id],
  },
  evidence: {
    source_events: [],
    provenance: { seen: [{ type: 'policy', id: 'return_window' }] },
    precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
  },
  proposer: { kind: 'agent', id: 'agent_secretary', assignment_id: ownerAssignment.id },
  automation: {
    level_at_creation: 'L1',
    auto_approved: false,
    mandate_check: { within: true, caps_hit: [] },
    sampling: { selected: false },
  },
  routing: {
    recipients: [{ person: person.id, via: 'owner' }],
    rule: 'owner',
    escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
    separation_of_duties: false,
  },
  priority: 'queue',
})

const { url } = await server.listen(0)

process.stdout.write(
  `${JSON.stringify({
    url,
    email: person.email,
    workspace_id: workspace.id,
    assignment_id: ownerAssignment.id,
    approval_id: item.id,
  })}\n`,
)

const shutdown = () => {
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('message', (m) => {
  if (m === 'shutdown') shutdown()
})
