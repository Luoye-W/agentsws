/**
 * WP415 守卫（决策 1236–1240）：**枚举全部卡种 × 运行形态**，生产形态下没有真执行器的卡种
 * 不得出「通过」，也不得写成功。
 *
 * 加了真执行器的组（WP416–421）只要在 `execution/registry.ts` 登记一行，这里自动放行，不用改测试；
 * 忘了登记、或者登记了执行链上却没接，这里会红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalItem, ChangeKind, ExecutionMode, StagedChange } from '@agentsws/contracts'
import { executionOutcomeOf } from '@agentsws/contracts'
import { KIND_RISK } from '@agentsws/core'
import { projectCard } from '@agentsws/deck'
import { afterEach, describe, expect, it } from 'vitest'
import { createExecutionFallback, resolveExecutionMode } from '../src/execution/fallback.js'
import {
  CHANGE_EXECUTORS,
  executorOf,
  inlineApply,
  kindWiring,
  wiringOfItem,
} from '../src/execution/registry.js'
import { createServer, type Server } from '../src/index.js'

const ALL_KINDS = Object.keys(KIND_RISK) as ChangeKind[]
const MODES: ExecutionMode[] = ['live', 'demo', 'memory']
const T0 = '2026-10-19T09:00:00.000Z'

/** 一张最朴素的改动卡（卡上的 payload 与账本条目同形）。 */
const itemOf = (kind: ChangeKind, after: unknown = {}): ApprovalItem =>
  ({
    id: `apr_${kind}`,
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'staged_change',
    revision: 1,
    role_id: 'dtc.store',
    subject: { object: { type: 'thing', id: 'x1' } },
    dedupe_key: `d_${kind}`,
    title: kind,
    summary: '',
    payload: { change_id: `chg_${kind}`, kind, target: { type: 'thing', id: 'x1' }, after },
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'agent', id: 'a' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: false, chain: [], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    state: 'pending',
    deliveries: [],
    links: { children: [] },
    created_at: T0,
    updated_at: T0,
  }) as unknown as ApprovalItem

const changeOf = (kind: ChangeKind, after: unknown = {}): StagedChange =>
  ({
    id: `chg_${kind}`,
    schema_version: 1,
    workspace_id: 'ws_1',
    role_id: 'dtc.store',
    assignment_id: 'asg_1',
    run_id: 'run_1',
    change_set_id: 'cs_1',
    kind,
    risk_class: KIND_RISK[kind],
    target: { type: 'thing', id: 'x1' },
    before: {},
    after,
    guardrail: { verdict: 'allow', hits: [], effective_mandate_hash: 'h', evaluated_at: T0 },
    notes: [],
    created_by: { kind: 'agent', id: 'a' },
    status: 'approved',
    expires_at: T0,
    created_at: T0,
    updated_at: T0,
  }) as unknown as StagedChange

const notWiredKinds = ALL_KINDS.filter((k) => kindWiring(k) === 'not_wired')

describe('登记表 × 卡种 × 运行形态（纯函数）', () => {
  it('登记表里的 kind 都是真的 ChangeKind', () => {
    for (const spec of CHANGE_EXECUTORS)
      for (const k of spec.kinds) expect(ALL_KINDS, `${spec.id} → ${k}`).toContain(k)
  })

  it('生产里确实还有一批卡种没接通（这张名单变短 = 有组接上了真执行器）', () => {
    expect(notWiredKinds.length).toBeGreaterThan(0)
    // 几个审计点名的：改出价、换素材、装 App、改邮件模板
    // （退款 WP417 起经店铺授权接上了、定稿入库与新闻稿定稿 WP421 接上了——见下面几条）
    for (const k of [
      'bid_change',
      'creative_swap',
      'app_install',
      'email_template_edit',
    ] as ChangeKind[])
      expect(notWiredKinds, k).toContain(k)
    // WP417：退款 / 补发 / 改地址只接经店铺工具出的那种（别的来路的同类卡照旧标「还没接通」）
    for (const k of ['refund', 'reship', 'address_change'] as ChangeKind[])
      expect(kindWiring(k), k).toBe('partly')
    // WP421：新闻稿只接「定稿」那种（要分发的还没接通）；定稿入库整类接上
    expect(kindWiring('press_release')).toBe('partly')
    expect(kindWiring('asset_publish')).toBe('wired')
  })

  for (const mode of MODES)
    it(`${mode}：没有执行器的卡种出卡时${mode === 'live' ? '标「还没接通」、不出「通过」' : mode === 'demo' ? '标「演示」' : '不标'}`, () => {
      for (const kind of ALL_KINDS) {
        const item = itemOf(kind)
        const wiring = wiringOfItem(item, mode)
        const card = projectCard(item, {
          now: T0,
          position_id: 'pos_1',
          wiring: (i) => wiringOfItem(i, mode),
        })
        const hasExecutor = executorOf({ kind, after: {}, target: { type: 'thing', id: 'x1' } })
        if (hasExecutor !== undefined || mode === 'memory') {
          expect(wiring, kind).toBeUndefined()
          continue
        }
        if (mode === 'demo') {
          expect(wiring?.state, kind).toBe('demo')
          expect(card.available_actions, kind).toContain('approve')
          continue
        }
        expect(wiring?.state, kind).toBe('not_wired')
        expect(card.available_actions, kind).not.toContain('approve')
        expect(card.available_actions, kind).not.toContain('instruct')
        expect(card.action_labels?.reject, kind).toBe('知道了')
      }
    })

  it('兜底：live 一律回「没做 · 还没接通」，demo 回成功但标演示，memory 老行为', () => {
    const backend = {
      apply: () => ({ status: 'ok' as const, execution_id: 'exec_1' }),
      deliver: () => ({ status: 'ok' as const, execution_id: 'dlv_1' }),
    }
    for (const kind of ALL_KINDS) {
      const live = createExecutionFallback('live', backend).apply(changeOf(kind), { attempt: 1 })
      expect(live.status, kind).toBe('failed')
      expect(live.not_wired, kind).toBe(true)
      const demo = createExecutionFallback('demo', backend).apply(changeOf(kind), { attempt: 1 })
      expect(demo.readback, kind).toBe('demo')
      const memory = createExecutionFallback('memory', backend).apply(changeOf(kind), {
        attempt: 1,
      })
      expect(memory, kind).toEqual({ status: 'ok', execution_id: 'exec_1' })
    }
    const sent = createExecutionFallback('live', backend).deliver(itemOf('refund'), { attempt: 1 })
    expect(sent.status).toBe('failed')
    expect(sent.error?.message).toContain('没发出去')
  })

  it('运行形态：显式给的优先；接了模拟世界 = 演示；否则 = 老行为', () => {
    expect(resolveExecutionMode({ execution: 'live', mounted: true })).toBe('live')
    expect(resolveExecutionMode({ mounted: true })).toBe('demo')
    expect(resolveExecutionMode({ mounted: false })).toBe('memory')
  })

  it('生产入口 index.ts 显式给 live（去掉这一行，生产就回到内存空桩）', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
    expect(src).toMatch(/execution: 'live'/)
  })

  it('inline 那几类（出卡时已办完 / 交给排期）回 ok，别的不碰', () => {
    expect(inlineApply({ id: 'c1', kind: 'design_request' })?.readback).toBe('verified')
    expect(inlineApply({ id: 'c2', kind: 'social_post' })?.readback).toBe('unverified')
    expect(inlineApply({ id: 'c3', kind: 'refund' })).toBeUndefined()
  })
})

describe('真服务 · 生产形态：整条执行链对每一种卡都不写假成功', () => {
  let server: Server | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  for (const mode of ['live', 'demo'] as const)
    it(`${mode}：逐个卡种跑一遍执行链`, async () => {
      server = await createServer({ quiet: true, execution: mode })
      const apply = server.txn.runtime.opts.backendApply
      if (apply === undefined) throw new Error('backendApply 没装')
      const ws = server.bootstrap.workspace.id
      for (const kind of ALL_KINDS) {
        const change = { ...changeOf(kind), workspace_id: ws }
        const res = await apply(change, { idempotencyKey: change.id, attempt: 1, fencing_token: 1 })
        const spec = executorOf(change)
        if (spec === undefined) {
          if (mode === 'live') {
            expect(res.status, kind).toBe('failed')
            expect(res.not_wired, kind).toBe(true)
          } else {
            expect(res.status, kind).toBe('ok')
            expect(res.readback, kind).toBe('demo')
          }
          continue
        }
        // 有执行器的：可以失败（连接没连、插件没开、库里没有这条），但回 ok 必须带回读结论
        if (res.status === 'ok') expect(res.readback, kind).toBeDefined()
      }
    })
})

describe('真服务 · 生产形态：一张没接通的退款卡从出卡到「知道了」', () => {
  let server: Server | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const setup = async (): Promise<{ server: Server; url: string; item: ApprovalItem }> => {
    const s = await createServer({
      quiet: true,
      execution: 'live',
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    })
    server = s
    const { url } = await s.listen(0)
    const person = s.bootstrap.person.id
    const ORDER = { type: 'order', id: 'ord_1042' }
    const CUSTOMER = { type: 'customer', id: 'cus_7' }
    const support = s.roles.assignments.create({
      person_id: person,
      workspace_id: s.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: person,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const record = { total: 89, refunded: 0, financial_status: 'paid', delivered_at: T0 }
    s.backend.setRecord(ORDER, { record_version: 'v1', record })
    const staged = await s.txn.ledger.stage({
      workspace_id: s.bootstrap.workspace.id,
      role_id: 'dtc.support',
      assignment_id: support.id,
      run_id: 'run_1',
      change_set_id: 'cs_1',
      kind: 'refund',
      target: ORDER,
      before: record,
      after: { refund_amount: 42 },
      record_version: 'v1',
      money: {
        amount: 42,
        currency: 'USD',
        amount_base: 42,
        base_currency: 'USD',
        fx_rate: 1,
        fx_at: T0,
      },
      created_by: { kind: 'agent', id: 'agent_support' },
      mandate: {
        caps: { max_auto_refund_amount: 50, return_window_days: 14 },
        window: { max_count: 20, per: 'day' },
      },
      level: 'L1',
      provenance: {
        run_id: 'run_1',
        seen: { order: [ORDER.id], customer: [CUSTOMER.id] },
        read_full: [],
        recorded_at: T0,
      },
      requester: { channel: 'email', external_id: 'anna@example.com', resolved: CUSTOMER },
      target_owner: CUSTOMER,
      approval: {
        title: '退款 $42 给 Anna',
        summary: '在退货窗口内',
        recipients: [{ person, via: 'role_holder' }],
        proposer: { kind: 'agent', id: 'agent_support', assignment_id: support.id },
        separation_of_duties: false,
      },
    } as never)
    if (!staged.ok) throw new Error(`stage 没成：${staged.message}`)
    const item = staged.approval
    expect(item.state).toBe('pending')
    return { server: s, url, item }
  }

  const call = (s: Server, url: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': s.bootstrap.ownerAssignment.id,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('点「通过」被拒；「知道了」不用写理由，一下就收起', async () => {
    const { server: s, url, item } = await setup()
    const approve = await call(s, url, `/v1/approvals/${item.id}/decide`, { action: 'approve' })
    expect(approve.status).toBeGreaterThanOrEqual(400)
    expect((await s.txn.approvals.get(item.id))?.state).toBe('pending')
    const ack = await call(s, url, `/v1/approvals/${item.id}/decide`, { action: 'reject' })
    expect(ack.status).toBe(200)
    const after = await s.txn.approvals.get(item.id)
    expect(after?.state).toBe('rejected')
    expect(after?.decision?.reason).toBe('还没接通，我自己去做')
  })

  it('从别的口子批了（IM 卡、批量）：执行照实回「没做 · 还没接通」，卡上不写办好了、发出记录不记', async () => {
    let now = Date.parse(T0)
    const s = await createServer({
      quiet: true,
      execution: 'live',
      clock: { now: () => new Date(now).toISOString() },
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    })
    server = s
    const ws = s.bootstrap.workspace.id
    const person = s.bootstrap.person.id
    const item = await s.txn.approvals.create({
      workspace_id: ws,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: 'dtc.support',
      subject: { object: { type: 'thread', id: 'thr_1' } },
      dedupe_key: 'wp415_reply',
      title: '回 Anna',
      summary: '',
      payload: { to: { type: 'customer', id: 'cus_7' }, channel: 'email', body: '你好' },
      evidence: {
        source_events: [],
        provenance: {
          seen: [
            { type: 'thread', id: 'thr_1' },
            { type: 'customer', id: 'cus_7' },
          ],
        },
        precheck: {},
      },
      context: { thread_participants: ['cus_7'] },
      proposer: { kind: 'agent', id: 'agent_support' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 24, business_hours: false, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    } as never)
    const fresh = await s.txn.approvals.get(item.id)
    const token = fresh?.deliveries.find((d) => d.to === person)?.decision_token ?? ''
    await s.txn.approvals.decide(item.id, person, {
      decision_token: token,
      action: 'approve',
      via: 'im_card',
    })
    now += 10 * 60_000
    const out = await s.txn.executor.applyApproval(item.id)
    // 邮箱没连：以前掉进内存空桩回 ok（「卡消失、已发送里没有这封」），现在照实说没发出去
    expect(out.state).toBe('apply_failed')
    const view = executionOutcomeOf(out)
    expect(view?.outcome).toBe('not_done')
    expect(view?.not_wired).toBe(true)
    expect(view?.reason).toContain('没发出去')
    expect(s.outbound.list(ws)).toHaveLength(0)
  })

  it('绕过卡片动词（直接 approve_edited）也批不了', async () => {
    const { server: s, url, item } = await setup()
    const res = await call(s, url, `/v1/approvals/${item.id}/decide`, {
      action: 'approve_edited',
      edited_payload: {},
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await s.txn.approvals.get(item.id))?.state).toBe('pending')
  })
})

describe('统一执行结果（卡、时间线、发出记录同一份口径）', () => {
  const base = { attempts: [] as NonNullable<ApprovalItem['apply']>['attempts'] }
  it('已执行且已回读 / 已执行未能回读 / 没做 + 原因 / 演示', () => {
    expect(
      executionOutcomeOf({ state: 'applied', apply: { ...base, readback: 'verified' } }),
    ).toEqual({ outcome: 'verified' })
    expect(executionOutcomeOf({ state: 'applied', apply: base })).toEqual({ outcome: 'unverified' })
    expect(executionOutcomeOf({ state: 'applied', apply: { ...base, readback: 'demo' } })).toEqual({
      outcome: 'demo',
    })
    const failed = executionOutcomeOf({
      state: 'apply_failed',
      apply: {
        attempts: [
          {
            at: T0,
            by_executor: 'txn',
            idempotency_key: 'k',
            result: 'failed',
            error: 'not_wired：这一步还没接通',
          },
        ],
        not_wired: true,
      },
    })
    expect(failed).toEqual({ outcome: 'not_done', reason: '这一步还没接通', not_wired: true })
    expect(executionOutcomeOf({ state: 'pending' })).toBeUndefined()
  })
})

describe('连接目录：要开发者应用 / 令牌的都标出来（决策 1239）', () => {
  it('要用户抄令牌 / 客户端密钥的连接一律 developer_setup', async () => {
    const { CONNECTION_DIRECTORY } = await import('@agentsws/contracts')
    const DEV_FIELDS = ['access_token', 'bot_token', 'client_secret', 'developer_token']
    for (const e of CONNECTION_DIRECTORY) {
      if (e.status !== 'available') continue
      const needsDev = e.fields.some((f) => DEV_FIELDS.includes(f.name))
      if (needsDev) expect(e.developer_setup, e.kind).toBe(true)
    }
  })
})

describe('「能查什么」：grounding 里写的工具有没有执行器（决策 1230）', () => {
  it('真有执行器的认得出，审计点名没有执行器的标没接通', async () => {
    const { toolWired, toolWiringView } = await import('../src/execution/tools.js')
    for (const name of [
      'get_order',
      'search_policies',
      'list_community_threads',
      'list_mentions',
      'search_creators',
      // WP419 / WP421 接上了
      'list_social_posts',
      'list_design_requests',
      'get_brand_system',
      'list_press_releases',
    ])
      expect(toolWired(name), name).toBe(true)
    // 职责模板里写了、宿主里没有执行器的工具名照旧标没接通
    expect(toolWired('no_such_tool_for_guard')).toBe(false)
    expect(toolWiringView('get_order')).toEqual({
      name: 'get_order',
      label: '订单查询',
      wired: true,
    })
  })
})
