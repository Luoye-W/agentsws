/**
 * WP284（决策 275 / 294）——真服务进程。
 *
 * 275「以后都这样」真落库：
 * 1. ① 卡上指导选「以后都这样」→ 策略卡 → 点了「按提议改」→ 这条职责的规矩里多一句（定的人、来源卡）；
 *    下一次运行的提示词里带着它（替身模型收到的 messages 里也有）；改了 / 删了，再下一次就跟着变；
 * 2. 选「维持现状」/ 稍后 → 什么都不落；
 * 3. ② 同事也能改，做这条职责的人收「知道了 / 撤回」，撤回就落回原句；
 * 4. ③ 卡发给老板（与改职责规矩同一条路），普通成员自己点 403，老板批了才落；改 / 删只有老板与管理员；
 * 5'. 删一句时工具箱里那条「规矩」一起退役，② 撤回时一起回来。
 *
 * 294 ③ 里没岗位的同事（只有「工作区成员」那条）：
 * 5. 能点发给他本人的「知道了 / 我要退出」；点不了发给他的审批类卡、也点不了别人的卡。
 */
import type { ApprovalItem, Assignment, RoleRuleView, RunRequest } from '@agentsws/contracts'
import { assemblePrompt } from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-09T02:00:00.000Z'
const RULE = '退款超过 50 美元先问我，别直接答应'

function seeded(seed = 284): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let now = Date.parse(T0)
let support: Assignment
const requests: RunRequest[] = []

const ws = (): string => server.bootstrap.workspace.id
const owner = (): string => server.bootstrap.person.id

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; token?: string; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${options.token ?? server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? support.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}

const post = (path: string, body: unknown) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

async function colleague(email: string, name: string): Promise<{ token: string; id: string }> {
  const invitation = await data<{ url: string }>(
    await call('POST', `/v1/workspaces/${ws()}/invitations`, {
      body: { email, name },
      assignment: server.bootstrap.ownerAssignment.id,
    }),
  )
  const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
  const accepted = await data<{ person_id: string }>(
    await post(`/v1/invitations/${token}/accept`, {}),
  )
  const login = await data<{ token: string }>(await post('/v1/auth/magic-link', { email }))
  const session = await data<{ session_token: string }>(
    await post('/v1/auth/verify', { token: login.token }),
  )
  return { token: session.session_token, id: accepted.person_id }
}

const assignmentOf = (person_id: string, role_id: string): string => {
  const a = server.roles.assignments
    .listByPerson(person_id, { workspace_id: ws() })
    .find((x) => x.role_id === role_id && x.revoked_at === undefined)
  if (a === undefined) throw new Error(`${person_id} 没有 ${role_id}`)
  return a.id
}

let seq = 0
/** 一封待审的回信（客服职责的），发给 `to`。 */
async function draft(to = owner()): Promise<ApprovalItem> {
  seq += 1
  return server.txn.approvals.create({
    workspace_id: ws(),
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: 'dtc.support',
    subject: { object: { type: 'thread', id: `thr_${seq}` } },
    dedupe_key: `${ws()}:outbound_draft:thr_${seq}`,
    title: `回复 Anna 的退款 ${seq}`,
    summary: '退货请求',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_1' },
      body: { subject: 'Refund', text: 'We will refund $80 right away.' },
    },
    evidence: {
      run_id: `run_${seq}`,
      source_events: [],
      provenance: {
        seen: [
          { type: 'customer', id: 'cus_1' },
          { type: 'thread', id: `thr_${seq}` },
        ],
      },
      precheck: {},
    },
    proposer: { kind: 'agent', id: 'agent', assignment_id: support.id },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: to, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    context: { thread_participants: ['cus_1'], verified_contacts: ['cus_1'] },
  })
}

/** 在一张卡上指导「以后都这样」→ 回那张策略卡的 id。 */
async function teach(
  item: ApprovalItem,
  text = RULE,
  as: { token?: string; assignment?: string } = {},
): Promise<string> {
  const out = await data<{ instruction_proposal?: { kind: string; approval_item_id: string } }>(
    await call('POST', `/v1/approvals/${item.id}/decide`, {
      ...as,
      body: { action: 'instruct', instruction: { scope: 'global_rule', text } },
    }),
  )
  expect(out.instruction_proposal?.kind).toBe('policy_change')
  return out.instruction_proposal?.approval_item_id ?? ''
}

/** 工具箱里「规矩」那几条的 id。 */
const toolboxRules = async (): Promise<string[]> =>
  (await data<{ id: string }[]>(await call('GET', '/v1/catalog?kind=rule'))).map((e) => e.id)

const rules = async (as: { token?: string; assignment?: string } = {}) =>
  data<RoleRuleView[]>(await call('GET', '/v1/roles/dtc.support/rules', as))

/** 用客服那条分配真跑一次（替身运行时），回适配器收到的那份请求。 */
async function runOnce(): Promise<RunRequest> {
  const runtime = server.runtime
  if (runtime === undefined) throw new Error('这个进程该有运行时')
  const before = requests.length
  const matter = server.work.createMatter({ kind: 'conversation', title: '一次出活' })
  await runtime.startRun({
    matter,
    brief: '回一下 Anna 的退款',
    actor: { person_id: owner(), assignment_id: support.id },
  })
  const req = requests[before]
  if (req === undefined) throw new Error('这次运行没到适配器')
  return req
}

const ruleSection = (req: RunRequest): string | undefined =>
  req.persona.sections.find((s) => s.id === 'role_rules')?.text

beforeEach(async () => {
  now = Date.parse(T0)
  seq = 0
  requests.length = 0
  server = await createServer({
    clock: { now: () => new Date(now++).toISOString() },
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'wang@example.com' },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  const runtime = server.runtime
  if (runtime !== undefined) {
    const real = runtime.adapter.run.bind(runtime.adapter)
    runtime.adapter.run = (req, sink, signal) => {
      requests.push(req)
      return real(req, sink, signal)
    }
  }
  support = server.roles.assignments.create({
    person_id: owner(),
    workspace_id: ws(),
    role_id: 'dtc.support',
    granted_by: owner(),
    ranges: [{ kind: 'store', id: 'store_main' }],
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP284 「以后都这样」批了真落库（决策 275）', () => {
  it('① 批了 → 规矩里多一句（留名字与来源卡）→ 下一次运行的提示词带上它；改了、删了跟着变', async () => {
    expect(await server.organizations.modeOf(ws())).toBe('solo')
    const card = await draft()
    const policy = await teach(card)
    // 还没批：规矩里没有，运行里也没有
    expect(await rules()).toEqual([])
    expect(ruleSection(await runOnce())).toBeUndefined()

    const approved = await call('POST', `/v1/approvals/${policy}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    expect(approved.status).toBe(200)
    const [rule, ...rest] = await rules()
    expect(rest).toEqual([])
    expect(rule).toMatchObject({
      text: RULE,
      role_id: 'dtc.support',
      by: owner(),
      proposed_by: owner(),
      source_card_id: policy,
      source_title: card.title,
      can_edit: true,
    })
    expect(rule?.by_name).toBeTruthy()
    const types = server.kernel.eventLog.readSync({ workspace_id: ws() }).map((e) => e.type)
    expect(types).toContain('role_rule.added')
    // 事件里不记原文
    const added = server.kernel.eventLog
      .readSync({ workspace_id: ws(), types: ['role_rule.added'] })
      .at(-1)
    expect(JSON.stringify(added?.payload)).not.toContain('50 美元')

    // 下一次运行：角色定位后面多一节「这条职责的规矩」，替身模型收到的 messages 里也有
    const next = await runOnce()
    expect(ruleSection(next)).toContain(RULE)
    const order = next.persona.sections.find((s) => s.id === 'role_rules')?.order
    expect(order).toBe(21)
    expect(assemblePrompt(next).messages.some((m) => m.content.includes(RULE))).toBe(true)

    // 改一句：下一次就是新的那一句
    const edited = await data<RoleRuleView>(
      await call('PUT', `/v1/roles/dtc.support/rules/${rule?.id}`, {
        body: { text: '退款超过 30 美元先问我' },
      }),
    )
    expect(edited).toMatchObject({ text: '退款超过 30 美元先问我', updated_by: owner() })
    const afterEdit = ruleSection(await runOnce())
    expect(afterEdit).toContain('30 美元')
    expect(afterEdit).not.toContain('50 美元')

    // 删掉：下一次整节不出；工具箱里那条「规矩」一起退役
    expect(await toolboxRules()).toContain(`rule:${policy}`)
    const removed = await call('DELETE', `/v1/roles/dtc.support/rules/${rule?.id}`)
    expect(removed.status).toBe(200)
    expect(await rules()).toEqual([])
    expect(await toolboxRules()).not.toContain(`rule:${policy}`)
    expect(ruleSection(await runOnce())).toBeUndefined()
    // 不存在的那句：404
    expect((await call('DELETE', `/v1/roles/dtc.support/rules/${rule?.id}`)).status).toBe(404)
  })

  it('选「维持现状」或稍后都不落；空话 / 太长改不进去', async () => {
    const kept = await teach(await draft(), '一律包邮')
    expect(
      (
        await call('POST', `/v1/approvals/${kept}/decide`, {
          body: { action: 'approve', selected_option_id: 'before' },
        })
      ).status,
    ).toBe(200)
    // 策略卡没有「驳回」：不要这条就是「维持现状」；稍后再说也不落
    const later = await teach(await draft(), '一律不退')
    expect(
      (await call('POST', `/v1/approvals/${later}/decide`, { body: { action: 'snooze' } })).status,
    ).toBe(200)
    expect(await rules()).toEqual([])
    // 工具箱：选了「不用」的那条一起退役；稍后再说的还在（还没定）
    const box = await toolboxRules()
    expect(box).not.toContain(`rule:${kept}`)
    expect(box).toContain(`rule:${later}`)

    const policy = await teach(await draft())
    await call('POST', `/v1/approvals/${policy}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    const [rule] = await rules()
    for (const text of ['   ', 'x'.repeat(301)])
      expect(
        (await call('PUT', `/v1/roles/dtc.support/rules/${rule?.id}`, { body: { text } })).status,
      ).toBe(400)
    // 别的职责路径下找不到这一句
    expect((await call('DELETE', `/v1/roles/b2b.sales/rules/${rule?.id}`)).status).toBe(404)
  })

  it('② 同事也能改；做这条职责的人收「知道了 / 撤回」，撤回就落回原句', async () => {
    const lin = await colleague('lin@example.com', '林峰')
    expect(await server.organizations.modeOf(ws())).toBe('peers')
    const linSupport = server.roles.assignments.create({
      person_id: lin.id,
      workspace_id: ws(),
      role_id: 'dtc.support',
      granted_by: owner(),
      ranges: [{ kind: 'store', id: 'store_main' }],
    }).id
    const policy = await teach(await draft())
    await call('POST', `/v1/approvals/${policy}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    const as = { token: lin.token, assignment: linSupport }
    const [rule] = await rules(as)
    expect(rule?.can_edit).toBe(true)
    const edited = await call('PUT', `/v1/roles/dtc.support/rules/${rule?.id}`, {
      ...as,
      body: { text: '退款一律先问我' },
    })
    expect(edited.status).toBe(200)
    // 王（也做客服）收到一张「林峰改了…（已生效）」，林自己没有
    const queue = async (person_id: string) =>
      (await server.txn.approvals.queue({
        workspace_id: ws(),
        person_id,
        lane: 'mine',
        state: ['pending', 'in_review'],
      })) as ApprovalItem[]
    const notice = (await queue(owner())).find(
      (i) => (i.payload as { form?: string }).form === 'peer_change_notice',
    )
    expect(notice?.title).toContain('林峰改了')
    expect(notice?.title).toContain('规矩')
    expect(
      (await queue(lin.id)).some(
        (i) => (i.payload as { form?: string }).form === 'peer_change_notice',
      ),
    ).toBe(false)
    // 王点「撤回」→ 落回原句
    const undo = await call('POST', `/v1/approvals/${notice?.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'before' },
    })
    expect(undo.status).toBe(200)
    const [back] = await rules()
    expect(back?.text).toBe(RULE)
    expect(ruleSection(await runOnce())).toContain(RULE)
  })

  it('② 同事删了一句：工具箱那条一起退役；有人撤回，规矩与工具箱那条都回来', async () => {
    const lin = await colleague('lin@example.com', '林峰')
    const linSupport = server.roles.assignments.create({
      person_id: lin.id,
      workspace_id: ws(),
      role_id: 'dtc.support',
      granted_by: owner(),
      ranges: [{ kind: 'store', id: 'store_main' }],
    }).id
    const policy = await teach(await draft())
    await call('POST', `/v1/approvals/${policy}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    const as = { token: lin.token, assignment: linSupport }
    const [rule] = await rules(as)
    expect((await call('DELETE', `/v1/roles/dtc.support/rules/${rule?.id}`, as)).status).toBe(200)
    expect(await rules()).toEqual([])
    expect(await toolboxRules()).not.toContain(`rule:${policy}`)
    const notice = (
      (await server.txn.approvals.queue({
        workspace_id: ws(),
        person_id: owner(),
        lane: 'mine',
        state: ['pending', 'in_review'],
      })) as ApprovalItem[]
    ).find((i) => (i.payload as { form?: string }).form === 'peer_change_notice')
    await call('POST', `/v1/approvals/${notice?.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'before' },
    })
    expect((await rules()).map((r) => r.text)).toEqual([RULE])
    expect(await toolboxRules()).toContain(`rule:${policy}`)
  })

  it('③ 普通成员写指导 → 卡发给老板；成员自己点 403；老板批了才落', async () => {
    const he = await colleague('he@example.com', '何佳')
    const heSupport = server.roles.assignments.create({
      person_id: he.id,
      workspace_id: ws(),
      role_id: 'dtc.support',
      granted_by: owner(),
      ranges: [{ kind: 'store', id: 'store_main' }],
    }).id
    const org = server.organizations.organizationOf(ws())
    await call('PUT', `/v1/orgs/${org?.id}/mode`, {
      assignment: server.bootstrap.ownerAssignment.id,
      body: { mode: 'company', legal_name: '深圳诺伏特' },
    })
    expect(await server.organizations.modeOf(ws())).toBe('company')
    const as = { token: he.token, assignment: heSupport }
    const policy = await teach(await draft(he.id), RULE, as)
    const card = (await server.txn.approvals.get(policy)) as ApprovalItem
    // 与改职责规矩同一条路：发给老板（品牌所有者），不是写指导的何佳
    expect(card.routing.recipients.map((r) => r.person)).toEqual([owner()])
    expect(card.proposer).toMatchObject({ kind: 'person', id: he.id })
    // 何佳自己点「记进规矩」：403，规矩里没有
    const self = await call('POST', `/v1/approvals/${policy}/decide`, {
      ...as,
      body: { action: 'approve', selected_option_id: 'after' },
    })
    expect(self.status).toBe(403)
    expect(await rules(as)).toEqual([])
    expect(ruleSection(await runOnce())).toBeUndefined()
    // 老板批了才落：定的人是老板，提的人是何佳
    expect(
      (
        await call('POST', `/v1/approvals/${policy}/decide`, {
          body: { action: 'approve', selected_option_id: 'after' },
        })
      ).status,
    ).toBe(200)
    const [rule] = await rules(as)
    expect(rule).toMatchObject({ text: RULE, by: owner(), proposed_by: he.id, can_edit: false })
    expect(ruleSection(await runOnce())).toContain(RULE)
  })

  it('③ 照现有路由批了才落；改 / 删只有老板与管理员', async () => {
    const he = await colleague('he@example.com', '何佳')
    const heSupport = server.roles.assignments.create({
      person_id: he.id,
      workspace_id: ws(),
      role_id: 'dtc.support',
      granted_by: owner(),
      ranges: [{ kind: 'store', id: 'store_main' }],
    }).id
    const org = server.organizations.organizationOf(ws())
    const opened = await call('PUT', `/v1/orgs/${org?.id}/mode`, {
      assignment: server.bootstrap.ownerAssignment.id,
      body: { mode: 'company', legal_name: '深圳诺伏特' },
    })
    expect(opened.status).toBe(200)
    const policy = await teach(await draft())
    const card = (await server.txn.approvals.get(policy)) as ApprovalItem
    expect(card.routing.recipients.map((r) => r.person)).toEqual([owner()])
    await call('POST', `/v1/approvals/${policy}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    const as = { token: he.token, assignment: heSupport }
    const [rule] = await rules(as)
    expect(rule?.text).toBe(RULE)
    expect(rule?.can_edit).toBe(false)
    expect(
      (await call('PUT', `/v1/roles/dtc.support/rules/${rule?.id}`, { ...as, body: { text: 'x' } }))
        .status,
    ).toBe(403)
    expect((await call('DELETE', `/v1/roles/dtc.support/rules/${rule?.id}`, as)).status).toBe(403)
    // 老板改得了
    expect(
      (
        await call('PUT', `/v1/roles/dtc.support/rules/${rule?.id}`, {
          body: { text: '退款先问我' },
        })
      ).status,
    ).toBe(200)
  })
})

describe('WP284 ③ 没岗位的同事点得了关于自己的卡（决策 294）', () => {
  it('「知道了 / 我要退出」点得了；发给他的审批卡、别人的卡点不了', async () => {
    const zhou = await colleague('zhou@example.com', '周宁')
    const member = assignmentOf(zhou.id, 'common.member')
    // 他只有「工作区成员」那一条
    expect(
      server.roles.assignments
        .listByPerson(zhou.id, { workspace_id: ws() })
        .filter((a) => a.revoked_at === undefined)
        .map((a) => a.role_id),
    ).toEqual(['common.member'])
    const org = server.organizations.organizationOf(ws())
    await call('PUT', `/v1/orgs/${org?.id}/mode`, {
      assignment: server.bootstrap.ownerAssignment.id,
      body: { mode: 'company', legal_name: '深圳诺伏特' },
    })
    expect(await server.organizations.modeOf(ws())).toBe('company')
    const as = { token: zhou.token, assignment: member }

    // 发给他的审批类卡（一封回信）：照旧按职责权限，403
    const approval = await draft(zhou.id)
    const denied = await call('POST', `/v1/approvals/${approval.id}/decide`, {
      ...as,
      body: { action: 'approve' },
    })
    expect(denied.status).toBe(403)
    // 别人的卡：同一句 403（不泄漏有没有这张）
    const theirs = await draft()
    expect(
      (
        await call('POST', `/v1/approvals/${theirs.id}/decide`, {
          ...as,
          body: { action: 'approve' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await call('POST', '/v1/approvals/apr_nope/decide', { ...as, body: { action: 'approve' } }))
        .status,
    ).toBe(403)

    // 关于他自己的那张「知道了 / 我要退出」：点得了
    const notice = (
      (await server.txn.approvals.queue({
        workspace_id: ws(),
        person_id: zhou.id,
        lane: 'mine',
        state: ['pending', 'in_review'],
      })) as ApprovalItem[]
    ).find((i) => (i.payload as { form?: string }).form === 'company_notice')
    expect(notice).toBeDefined()
    const ack = await call('POST', `/v1/approvals/${notice?.id}/decide`, {
      ...as,
      body: { action: 'approve', selected_option_id: 'ack' },
    })
    expect(ack.status).toBe(200)
    expect(((await server.txn.approvals.get(notice?.id ?? '')) as ApprovalItem).state).not.toBe(
      'pending',
    )
  })
})

describe('WP284 规矩簿落盘', () => {
  it('一个 JSON 文件：写了重读还在；文件坏了当成没有', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createFileRoleRuleBackend, roleRulesFileIn } = await import('../src/role-rules.js')
    const dir = mkdtempSync(join(tmpdir(), 'wp284-'))
    try {
      const file = roleRulesFileIn(dir)
      const a = createFileRoleRuleBackend(file)
      a.put({
        id: 'rr_1',
        workspace_id: 'ws_1',
        role_id: 'dtc.support',
        text: '退款先问我',
        by: 'per_1',
        created_at: T0,
      })
      expect(
        createFileRoleRuleBackend(file)
          .all()
          .map((r) => r.text),
      ).toEqual(['退款先问我'])
      a.remove('rr_1')
      expect(createFileRoleRuleBackend(file).all()).toEqual([])
      writeFileSync(file, '{坏了', 'utf8')
      expect(createFileRoleRuleBackend(file).all()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
