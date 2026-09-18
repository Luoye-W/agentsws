/**
 * WP93（dsh 0.1.6-alpha.2）：Plugin Manager 与 HMR 在 profile 里必须是关的。
 *
 * 上游 alpha.2 往 `dsh-base` 的 patch 里 insert 了两个新行（出处：
 * `packages/bundle/base/cordis.patch.yml` 的 diff）——
 *
 *     - id: plugin-manager
 *       name: '@deepseek-ai/dsh-plugin-manager'
 *       disabled: !!js "!ctx.get('profileContext')"
 *
 * 并把 `hmr` 从写死 `disabled: true` 的 `cordis-plugin-hmr` 换成同样按
 * `profileContext` 判的 `@deepseek-ai/dsh-hmr`。`profileContext` 的定义是
 * 「Present only in a profile launched by dsh」（上游
 * `packages/boot/app-boot/src/profile-context.ts`），所以 `dsh --profile agentsws`
 * 一起，这两个服务默认就是**开**的。
 *
 * `plugin-manager` 会以宿主用户身份跑 pnpm 装任意包，装完的 Host 代码在沿进程里、
 * 在工作区沙箱之外执行（上游 README：「installed Host code executes in-process
 * outside the workspace sandbox」），还能替用户放行被 pnpm 挡下的构建脚本
 * （`approvedBuilds`）——那是 `pnpm-workspace.yaml` 的 `allowBuilds` 在守的门。
 * 与 31 §3.5「v1 的公司端执行器不装任何第三方代码」、16 §3 最严解释直接冲突。
 *
 * 所以按 docs/42 红线 7 钉两道：
 *
 * 1. **组合里没有它**：两档运行时的真实模块图里没有这两个包（用 ESM resolve 钩子录，
 *    手法同 `telemetry.test.ts`，不靠推断）。
 * 2. **就算哪天真起了完整 profile 也关着**：`profiles/agentsws/cordis.patch.yml`
 *    显式写死三行 `disabled: true`。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { defaultChildEntry, subprocessAvailable } from '../src/index.js'

/** 这两个包一旦出现在两档的模块图里，就说明运行时里真有一条装任意代码 / 热替换模块的路。 */
const FORBIDDEN = ['@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/dsh-hmr'] as const

/** 反向哨兵：录到的图里必须有这两个，否则说明钩子没生效、测试是假绿。 */
const EXPECTED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'] as const

/** patch 层里必须写死 `disabled: true` 的三行。 */
const MUST_BE_DISABLED = ['plugin-manager', 'tool-plugin-manager', 'hmr'] as const

const PATCH = fileURLToPath(new URL('../../../profiles/agentsws/cordis.patch.yml', import.meta.url))

interface PatchRow {
  id?: string
  disabled?: unknown
}

/**
 * 在一个挂了 ESM resolve 钩子的子进程里 import 给定入口，返回它解析过的全部模块 URL。
 * 钩子只记录，不改写解析结果。手法与 `telemetry.test.ts` 同一套。
 */
function resolvedModules(entry: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-lockdown-'))
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

describe('WP93 Plugin Manager / HMR 不进我们的运行时（16 §3 / 31 §3.5）', () => {
  it('子进程档的真实模块图里没有 plugin-manager / hmr', () => {
    expect(subprocessAvailable()).toBe(true)
    const packages = dshPackagesOf(resolvedModules(defaultChildEntry()))
    for (const name of EXPECTED) expect([...packages], name).toContain(name)
    for (const name of FORBIDDEN) expect([...packages], name).not.toContain(name)
  })

  it('同进程档（`src/index.ts` 这棵树）也一样', () => {
    const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
    const packages = dshPackagesOf(resolvedModules(entry))
    for (const name of FORBIDDEN) expect([...packages], name).not.toContain(name)
  })

  it('profile 的 patch 层把三行显式写死 disabled（不靠"碰巧没装"）', () => {
    const rows = parse(readFileSync(PATCH, 'utf8')) as PatchRow[]
    expect(Array.isArray(rows)).toBe(true)
    for (const id of MUST_BE_DISABLED) {
      const row = rows.find((r) => r?.id === id)
      expect(row, `profiles/agentsws/cordis.patch.yml 里必须有 ${id} 这一行`).toBeDefined()
      expect(row?.disabled, `${id} 必须写死 disabled: true`).toBe(true)
    }
  })
})
