/**
 * WP236 ④⑤：**提供给模型的工具都能调**；Shopify Dev MCP 只有建站类职责才碰。
 *
 * 10-06 Windows 真机：社媒 Reddit 的工具面里摆着 `list_community_threads`，一调就是「这个进程没接」；
 * Shopify 品牌跑 Reddit 研究触发了 `shopify.devmcp_started`（后台去下官方工具包）。
 *
 * 一致性：所有内置职责逐条跑一次（真 `createRuntime` + 真记录源 + 服务端同样接上的那几样执行器，
 * direct 档、替身模型）——模型把工具面里每个工具都调一遍，没有一个回「没接」。
 */
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
  ToolDef,
} from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { loadBundledRoles, type RoleStore } from '@agentsws/roles'
import { DRAFT_REPLY_TOOL, STAGE_REFUND_TOOL, type ToolExecutor } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import type { ConnectLike } from '../src/connections.js'
import { createConnectRecordSource, type RecordSocialThread } from '../src/records.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

const clock: Clock = { now: () => '2026-10-06T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const BUILTIN = new Set([DRAFT_REPLY_TOOL, STAGE_REFUND_TOOL])

const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
  text,
  ...(tool_calls === undefined ? {} : { tool_calls }),
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
  model: { provider: 'stub', model: 'stub-v1' },
  static_prefix_hash: 'p',
})

/** 每次运行最多调这么多个（职责运行的 `max_tool_calls` 缺省 12，留点余量）。 */
const CHUNK = 10

/** 第一跳把工具面里第 `from` 个起的 {@link CHUNK} 个工具各调一次，第二跳收尾。 */
function callEverything(from: number) {
  const offered: string[][] = []
  let n = 0
  return {
    offered,
    async complete(req: { messages: ChatMessage[]; tools?: ToolDef[] }) {
      n += 1
      if (n === 1) {
        const names = (req.tools ?? []).map((t) => t.name).filter((t) => !BUILTIN.has(t))
        offered.push(names)
        return done(
          '',
          names
            .slice(from, from + CHUNK)
            .map((name, i) => ({ id: `call_${from + i}`, name, input: {} })),
        )
      }
      return done('好了。')
    },
    async embed() {
      return []
    },
    usage() {
      return {}
    },
    budget() {
      return {}
    },
  } as unknown as ModelGatewayApi & { offered: string[][] }
}

const THREAD: RecordSocialThread = {
  id: 'thr_1',
  account_id: 'acc_1',
  channel: 'reddit',
  surface: 'thread',
  author_handle: 'u/someone',
  text: 'Is the INMO Air3 worth it?',
  created_at: '2026-10-05T10:00:00.000Z',
  status: 'open',
}

function recordSource(withThreads: boolean) {
  return createConnectRecordSource({
    connections: { liveConnections: () => [] },
    connect: {} as ConnectLike,
    clock,
    workspace_id: 'ws_1',
    appendEvent: () => undefined,
    social: () => ({
      account: () => undefined,
      thread: (id) => (id === THREAD.id ? THREAD : undefined),
      ...(withThreads
        ? { threads: (f?: { channel?: string }) => (f?.channel === 'discord' ? [] : [THREAD]) }
        : {}),
    }),
  })
}

const ok: ToolExecutor = async () => ({ status: 'ok', data: {} })

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '随便看看',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-06T09:00:00.000Z',
  updated_at: '2026-10-06T09:00:00.000Z',
} as unknown as Matter

async function runRole(
  role: ReturnType<typeof loadBundledRoles>[number],
  opts: { withThreads?: boolean; extra?: Partial<RuntimeOptions>; from?: number } = {},
) {
  const gateway = callEverything(opts.from ?? 0)
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const roles = {
    effectiveConfig: () => ({
      role_id: role.id,
      grounding: role.grounding ?? [],
      skills: [],
      browser_scope: [],
    }),
    roles: { get: () => role },
    assignments: { get: () => undefined },
  } as unknown as RoleStore
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: (e) => events.push(e),
    prefer: 'direct',
    modelRef: () => MODEL,
    source: recordSource(opts.withThreads ?? true),
    // 服务端装配里一直接着的那几样执行器（这里用替身）
    kolTools: ok,
    researchTools: ok,
    ownerTools: ok,
    b2bOutboundTools: ok,
    ...opts.extra,
  })
  await runtime.startRun({
    matter,
    brief: '看一眼',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const results = events
    .filter((e) => e.type === 'tool.result')
    .map((e) => e.payload as { status: string; reason?: string })
  return { offered: gateway.offered[0] ?? [], results, events }
}

describe('WP236 ④ 提供的工具都能调', () => {
  it('所有内置职责：工具面里每一个都调得通（没有一个回「没接」）', async () => {
    const roles = loadBundledRoles()
    expect(roles.length).toBeGreaterThan(40)
    for (const role of roles) {
      // 分几次运行把工具面调全（一次运行有调用次数上限）
      let from = 0
      let total = 0
      for (;;) {
        const { offered, results } = await runRole(role, { from })
        expect(results.length, role.id).toBe(Math.min(CHUNK, offered.length - from))
        const unwired = results.filter((r) =>
          /unsupported_tool|no_tool_executor|not_in_allowlist/.test(r.reason ?? ''),
        )
        expect(unwired, `${role.id}: ${JSON.stringify(unwired)}`).toEqual([])
        total = offered.length
        from += CHUNK
        if (from >= total) break
      }
    }
  }, 120_000)

  it('社媒 Reddit：list_community_threads 接上了（读本品牌社媒库），没接的 route_to_community_support 不摆', async () => {
    const reddit = loadBundledRoles().find((r) => r.id === 'social.reddit')
    if (reddit === undefined) throw new Error('social.reddit 不在内置职责里')
    const { offered, results } = await runRole(reddit)
    expect(offered).toContain('list_community_threads')
    expect(offered).toContain('read_reddit')
    expect(offered).not.toContain('route_to_community_support')
    const i = offered.indexOf('list_community_threads')
    expect(results[i]?.status).toBe('ok')
  })

  it('社媒库没给线程那一口：list_community_threads 不出现在工具面里', async () => {
    const reddit = loadBundledRoles().find((r) => r.id === 'social.reddit')
    if (reddit === undefined) throw new Error('social.reddit 不在内置职责里')
    const { offered } = await runRole(reddit, { withThreads: false })
    expect(offered).not.toContain('list_community_threads')
  })
})

describe('WP236 ⑤ Shopify Dev MCP 只有建站类职责才碰', () => {
  const devTools = () => {
    let asked = 0
    return {
      get asked() {
        return asked
      },
      port: {
        toolNames: () => {
          // 服务端那一侧：这一问会在后台起 Dev MCP（首次就去下官方工具包）
          asked += 1
          return ['shopify.docs.search']
        },
        call: async () => ({ text: 'doc' }),
      },
    }
  }

  it('Shopify 品牌跑社媒 Reddit：一次都不问 Dev MCP，工具面里也没有', async () => {
    const reddit = loadBundledRoles().find((r) => r.id === 'social.reddit')
    if (reddit === undefined) throw new Error('social.reddit 不在内置职责里')
    const dev = devTools()
    const { offered } = await runRole(reddit, {
      extra: { devTools: dev.port, storefrontPlatform: () => 'shopify' },
    })
    expect(dev.asked).toBe(0)
    expect(offered.some((t) => t.startsWith('shopify.'))).toBe(false)
  })

  it('Shopify 品牌跑建站（网页模板）：问了、工具面里有、调得通', async () => {
    const theme = loadBundledRoles().find((r) => r.id === 'site.shopify-theme')
    if (theme === undefined) throw new Error('site.shopify-theme 不在内置职责里')
    const dev = devTools()
    const { offered, results } = await runRole(theme, {
      extra: { devTools: dev.port, storefrontPlatform: () => 'shopify' },
    })
    expect(dev.asked).toBeGreaterThan(0)
    expect(offered).toContain('shopify.docs.search')
    expect(results[offered.indexOf('shopify.docs.search')]?.status).toBe('ok')
  })

  it('平台不是 Shopify：建站职责也不碰', async () => {
    const theme = loadBundledRoles().find((r) => r.id === 'site.shopify-theme')
    if (theme === undefined) throw new Error('site.shopify-theme 不在内置职责里')
    const dev = devTools()
    await runRole(theme, {
      extra: { devTools: dev.port, storefrontPlatform: () => 'woocommerce' },
    })
    expect(dev.asked).toBe(0)
  })
})
