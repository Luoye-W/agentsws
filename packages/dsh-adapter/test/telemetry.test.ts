/**
 * WP70：dsh 0.1.6-alpha.1 把「会话日志随请求上报官方 DeepSeek API」的默认值翻成了开。
 *
 * 上游 `@deepseek-ai/dsh-session-log-deepseek` 的 `Config.enabled`：
 * 0.1.5-rc.1 是 `z.boolean().default(false)`，0.1.6-alpha.1 是 `z.boolean().default(true)`
 * （出处：上游仓库 `packages/session/session-log-deepseek/src/index.ts`；README
 * 「Configuration」表同步从 "Enable it only when…" 改成 "Disable it only when…"）。
 * 打开时它把整条 canonical Session 事件日志作为 `dsh_session_log` 字段随每次官方 API
 * 请求增量上传——里面是客户原文、订单、政策与工具入参。
 *
 * 这与 31 §3 / docs/39「数据留本地」冲突，所以钉两道：
 *
 * 1. **组合里没有它**：两档 headless 的真实模块图里根本没有这个包，也没有它依赖的
 *    `dsh-deepseek-llm-api-extensions`，更没有 `dsh-llm-deepseek`（我们的模型调用走
 *    `src/llm.ts` 覆写的 `LlmAdapter`，不经官方 provider）。用 Node 的 ESM loader
 *    钩子录下真实解析，不靠推断。
 * 2. **就算哪天真起了完整 profile 也关着**：`profiles/agentsws/cordis.patch.yml`
 *    显式写死 `enabled: false`。
 *
 * 自检条目：docs/39 §3.3 (d)。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { defaultChildEntry, subprocessAvailable } from '../src/index.js'

/** 这三个包一旦出现在两档 headless 的模块图里，就说明会话内容有一条通往官方 API 的路。 */
const FORBIDDEN = [
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  '@deepseek-ai/dsh-llm-deepseek',
] as const

/** 反向哨兵：录到的图里必须有这几个，否则说明钩子没生效、测试是假绿。 */
const EXPECTED = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-user-approval',
] as const

const PATCH = fileURLToPath(new URL('../../../profiles/agentsws/cordis.patch.yml', import.meta.url))

interface PatchRow {
  id?: string
  config?: Record<string, unknown>
}

/**
 * 在一个挂了 ESM resolve 钩子的子进程里 import 给定入口，返回它解析过的全部模块 URL。
 * 钩子只记录，不改写解析结果。
 */
function resolvedModules(entry: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-modgraph-'))
  try {
    const out = join(dir, 'resolved.txt')
    const hooks = join(dir, 'hooks.mjs')
    const register = join(dir, 'register.mjs')
    writeFileSync(
      hooks,
      [
        "import { appendFileSync } from 'node:fs'",
        `const OUT = ${JSON.stringify(out)}`,
        'export async function resolve(specifier, context, next) {',
        '  const r = await next(specifier, context)',
        '  appendFileSync(OUT, `${r.url}\\n`)',
        '  return r',
        '}',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      register,
      ["import { register } from 'node:module'", `register('./hooks.mjs', import.meta.url)`].join(
        '\n',
      ),
      'utf8',
    )
    writeFileSync(out, '', 'utf8')
    // 子进程只 import 入口、等一拍再退：入口的静态图在 import 时就全解析完了。
    const code = `import(${JSON.stringify(entry)}).then(() => setTimeout(() => process.exit(0), 1000))`
    const res = spawnSync(process.execPath, ['--import', register, '-e', code], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(res.status, res.stderr).toBe(0)
    return readFileSync(out, 'utf8').split('\n').filter(Boolean)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 一个模块 URL 属于哪个 `@deepseek-ai/*` 包（`node_modules/@deepseek-ai/<名>/…`）。 */
function dshPackagesOf(urls: string[]): Set<string> {
  const out = new Set<string>()
  for (const url of urls) {
    const m = /node_modules\/(@deepseek-ai\/[^/]+)\//.exec(url)
    if (m?.[1] !== undefined) out.add(m[1])
  }
  return out
}

describe('WP70 会话日志不上报官方 API（31 §3 / docs/39 §3.3 d）', () => {
  it('子进程档的真实模块图里没有官方上报那条路', () => {
    expect(subprocessAvailable()).toBe(true)
    const packages = dshPackagesOf(resolvedModules(defaultChildEntry()))
    // 哨兵先立：钩子确实录到东西了
    for (const name of EXPECTED) expect([...packages], name).toContain(name)
    for (const name of FORBIDDEN) expect([...packages], name).not.toContain(name)
  })

  it('同进程档（`src/index.ts` 这棵树）也一样', () => {
    const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
    const packages = dshPackagesOf(resolvedModules(entry))
    for (const name of FORBIDDEN) expect([...packages], name).not.toContain(name)
  })

  it('profile 的 patch 层把 session-log-deepseek 显式关掉（不靠"碰巧没装"）', () => {
    // WP144：patch 里多了一行 `!!js`（驱动路径），原样留成 `{ js }`，不求值、不报 warning
    const rows = parse(readFileSync(PATCH, 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (src: string) => ({ js: src }) }],
    }) as PatchRow[]
    expect(Array.isArray(rows)).toBe(true)
    const row = rows.find((r) => r?.id === 'session-log-deepseek')
    expect(
      row,
      'profiles/agentsws/cordis.patch.yml 里必须有 session-log-deepseek 这一行',
    ).toBeDefined()
    expect(row?.config?.enabled).toBe(false)
  })
})
