#!/usr/bin/env node
/**
 * WP148：服务端一次运行「走 direct」与「走 dsh（起一棵树）」差多少时间。
 *
 * 用的是服务端真的那一份 `createRuntime`（`apps/server/dist/runtime.js`，先 `tsc -b`），
 * 替身模型第一句就收工（不调工具），所以量到的几乎全是**装配 + 拆除**的开销：
 *
 * - direct：没开浏览器的运行（服务端平时就走这条）
 * - dsh 进程内 / 子进程，不挂浏览器：只有 dsh 那棵树本身
 * - dsh 进程内 / 子进程，挂浏览器：再加官方 Playwright 提供方（起一个 `@playwright/mcp` 进程、
 *   握手、列工具）。attach 一个**没人监听**的端口——`@playwright/mcp` 启动时不碰浏览器，
 *   所以不开真浏览器、不联网（WP82 的办法）。
 *
 * 用法：node scripts/bench-browser-dsh.mjs [每档次数，缺省 7]
 * 输出每档的中位数 / 最小 / 最大（毫秒）。第一次运行的冷启动单独列（模块加载算在里面）。
 */
import { createRuntime } from '../apps/server/dist/runtime.js'

const N = Number(process.argv[2] ?? 7)
const clock = { now: () => new Date().toISOString() }
const MODEL = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const DEAD = { mode: 'attach', endpoint: 'http://127.0.0.1:59321' }

const gateway = {
  async complete() {
    return {
      text: '好的。',
      usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
      model: { provider: 'stub', model: 'stub-v1' },
      static_prefix_hash: 'p',
    }
  },
  async embed() {
    return []
  },
  usage: () => ({}),
  budget: () => ({}),
}

const matter = {
  id: 'mat_bench',
  schema_version: 1,
  workspace_id: 'ws_bench',
  kind: 'task',
  title: '看一眼店铺首页',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-09-24T09:00:00.000Z',
  updated_at: '2026-09-24T09:00:00.000Z',
}

function runtimeFor({ browser, mode }) {
  let runtimeName = ''
  const rt = createRuntime({
    workspace_id: 'ws_bench',
    clock,
    random: Math.random,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) },
    roles: {
      effectiveConfig: () => ({
        role_id: 'ops.web',
        grounding: [],
        skills: [],
        browser_scope: ['example.com'],
      }),
      assignments: { get: () => undefined },
    },
    appendEvent: (e) => {
      if (e.type === 'run.started') runtimeName = e.payload.runtime
      if (e.type === 'run.failed') console.error('run.failed', e.payload)
    },
    prefer: 'direct',
    modelRef: () => MODEL,
    ...(browser ? { browser: () => DEAD } : {}),
    ...(mode === undefined ? {} : { dshMode: mode }),
    // 没开浏览器时也要走 dsh 的那两档：借电脑操控的开关（不给授权 = 不挂驱动，只多一个请求工具）
    ...(mode !== undefined && !browser
      ? {
          computerUse: {
            forRun: () => ({ command: '/nonexistent', args: [], minutes: 10 }),
            remember() {},
            activate() {},
            deactivate() {},
          },
        }
      : {}),
  })
  return {
    async once() {
      const t0 = performance.now()
      await rt.startRun({
        matter,
        brief: '打开首页看看',
        actor: { person_id: 'per_1', assignment_id: 'asg_1' },
      })
      return { ms: performance.now() - t0, runtime: runtimeName }
    },
  }
}

const cases = [
  ['direct（不开浏览器）', { browser: false }],
  ['dsh 进程内，不挂浏览器', { browser: false, mode: 'in-process' }],
  ['dsh 进程内，挂浏览器', { browser: true, mode: 'in-process' }],
  ['dsh 子进程，不挂浏览器', { browser: false, mode: 'subprocess' }],
  ['dsh 子进程，挂浏览器', { browser: true, mode: 'subprocess' }],
]

const fmt = (n) => n.toFixed(0).padStart(6)
console.log(`每档 ${N} 次（第一次单列为冷启动）；单位毫秒`)
console.log('档位'.padEnd(24), '冷启动', '中位数', '  最小', '  最大', ' 运行时')
for (const [label, opts] of cases) {
  const rt = runtimeFor(opts)
  const cold = await rt.once()
  const warm = []
  let name = cold.runtime
  for (let i = 0; i < N; i += 1) {
    const r = await rt.once()
    warm.push(r.ms)
    name = r.runtime
  }
  warm.sort((a, b) => a - b)
  const median = warm[Math.floor(warm.length / 2)] ?? Number.NaN
  console.log(
    label.padEnd(24),
    fmt(cold.ms),
    fmt(median),
    fmt(warm[0] ?? Number.NaN),
    fmt(warm.at(-1) ?? Number.NaN),
    ` ${name}`,
  )
}
