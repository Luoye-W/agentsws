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
 *
 * WP132（dsh 0.1.7-rc.1）再加三行，同一个形状：base 的 patch 新 insert 了
 * `config-editor`（把表单保存写回**这份 patch 文件**并立即生效）、`settings`（写回走前者，
 * 还会导入并改名 `$DSH_HOME/settings.yaml`）、`deepseek-account`（没有 `disabled` 表达式、
 * 任何组合默认就挂的 DeepSeek 账号登录 / 余额查询，出网）。理由写在 patch 文件里那一段。
 *
 * WP133：上面那道「patch 里写死 disabled」只看**我们自己的文件**，看不见上游那一头——
 * 这些行都是按服务 id 字符串对上的，上游哪天把 `hmr` 改名成 `dsh-hmr`，我们那行就静默指向
 * 一个不存在的 id：dsh 只打一行 warning（`patch: entry "hmr" not found`）然后跳过，什么都没关。
 * 所以现在对照 dsh 0.1.7 新加的 `dsh --dump-config-schema`（按当前装的 dsh 把组合树里每个插件的
 * 配置 schema 导成 JSON Schema，不挂插件、不求值 `!!js`）逐行校验：
 *
 * 1. `cordis.patch.yml` 里的每一行都登记在 `LOCKDOWN` 表里（这份文件只放锁定），表里每一行也都在文件里；
 * 2. 每个 id 在当前 dsh 的组合里**真的存在**，而且指向的还是我们以为的那个插件；
 * 3. 改配置的那一行（`session-log-deepseek.enabled`），字段名在该插件的配置 schema 里还在；
 * 4. dsh 自己组合出来的树（`--dump-config`）里，这几行最终确实是关的；
 * 5. 反向哨兵：往 patch 里塞一个不存在的 id，同一套检查必须报出它——证明上面几条不是假绿。
 *
 * 导出 schema 会 import 组合树里的插件模块（上游说明：「run it only against a profile whose plugins
 * you already trust」）——这里的插件全是锁定版本、已装在本仓 node_modules 里的官方包，不联网。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { defaultChildEntry, subprocessAvailable } from '../src/index.js'

/**
 * 这些包一旦出现在两档的模块图里，就说明运行时里真有一条装任意代码 / 热替换模块 /
 * 改写 profile patch / 默认出网登录的路。前两个是 WP93，后两个是 WP132（0.1.7-rc.1）。
 */
const FORBIDDEN = [
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-hmr',
  '@deepseek-ai/dsh-config-editor',
  '@deepseek-ai/dsh-deepseek-account-platform',
] as const

/** 反向哨兵：录到的图里必须有这两个，否则说明钩子没生效、测试是假绿。 */
const EXPECTED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent-loop'] as const

/**
 * profile 的 patch 层（`profiles/agentsws/cordis.patch.yml`）里的全部锁定，一行一条。
 * `name` 是这个 id 在当前 dsh 组合里**应当**指向的插件——id 还在、但换了一个插件，也算红。
 * WP70 一行（改配置）、WP93 三行、WP132 三行（关掉）。
 */
const LOCKDOWN: readonly LockdownRow[] = [
  {
    id: 'session-log-deepseek',
    name: '@deepseek-ai/dsh-session-log-deepseek',
    config: { enabled: false },
  },
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: true },
  { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
  { id: 'hmr', name: '@deepseek-ai/dsh-hmr', disabled: true },
  { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor', disabled: true },
  { id: 'settings', name: '@deepseek-ai/dsh-settings', disabled: true },
  { id: 'deepseek-account', name: '@deepseek-ai/dsh-deepseek-account-platform', disabled: true },
]

interface LockdownRow {
  id: string
  name: string
  disabled?: true
  config?: Record<string, unknown>
}

const PROFILE_DIR = fileURLToPath(new URL('../../../profiles/agentsws/', import.meta.url))
const PATCH = join(PROFILE_DIR, 'cordis.patch.yml')

interface PatchRow {
  id?: string
  name?: string
  disabled?: unknown
  config?: unknown
  insert?: unknown
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

  it('profile 的 patch 层把这几行显式写死（不靠"碰巧没装"），而且文件里只有锁定', () => {
    const rows = parse(readFileSync(PATCH, 'utf8')) as PatchRow[]
    expect(Array.isArray(rows)).toBe(true)
    for (const want of LOCKDOWN) {
      const row = rows.find((r) => r?.id === want.id)
      expect(row, `profiles/agentsws/cordis.patch.yml 里必须有 ${want.id} 这一行`).toBeDefined()
      if (want.disabled === true) {
        expect(row?.disabled, `${want.id} 必须写死 disabled: true`).toBe(true)
      }
      if (want.config !== undefined) expect(row?.config, want.id).toEqual(want.config)
    }
    // 反过来：文件里的每一行都得在 LOCKDOWN 表里（加锁定要两边一起加，才会被下面的 schema 校验覆盖）
    for (const row of rows) {
      expect(
        LOCKDOWN.map((l) => l.id),
        `cordis.patch.yml 里的 ${String(row?.id)} 没登记在 LOCKDOWN 表里`,
      ).toContain(row?.id)
      expect(row?.insert, `${String(row?.id)}：锁定行只关东西，不 insert`).toBeUndefined()
      expect(row?.name, `${String(row?.id)}：锁定行只按 id 找，不改插件`).toBeUndefined()
    }
  })
})

// ── WP133：对照 dsh 自己导出的配置 schema 校验每一行锁定 ─────────────────────────

const require = createRequire(import.meta.url)

/** `dsh --dump-config-schema` 的输出里我们要读的那几块（形状见 `@deepseek-ai/dsh-app-boot` 的 `ConfigSchemaDump`）。 */
interface SchemaDump {
  $defs: Record<string, unknown>
  'x-cordis': {
    complete: boolean
    entries: { id?: string; name?: string; status: string; configRef?: string }[]
    diagnostics: { level: string; path?: string; message: string }[]
  }
}

/** 当前装的 dsh 命令（`@deepseek-ai/dsh` 的 `bin.dsh`），不走 PATH、不走全局安装。 */
function dshBin(): string {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { dsh: string } }
  return join(dirname(manifest), pkg.bin.dsh)
}

/**
 * 把 profile 拷进一个一次性的 `DSH_HOME`（dsh 会往 profile 目录里补一份 `cordis.yml` 根文件，
 * 不能让它写进仓库）。`extraPatch` 追加在 patch 文件末尾，给反向哨兵用。
 */
function stageProfile(extraPatch = ''): string {
  const home = mkdtempSync(join(tmpdir(), 'agentsws-dsh-home-'))
  const dir = join(home, 'profiles', 'agentsws')
  mkdirSync(dir, { recursive: true })
  cpSync(join(PROFILE_DIR, 'package.json'), join(dir, 'package.json'))
  writeFileSync(join(dir, 'cordis.patch.yml'), readFileSync(PATCH, 'utf8') + extraPatch, 'utf8')
  return home
}

/** 在那个 `DSH_HOME` 下跑一次 `dsh --profile agentsws <flag>`；环境里别的 `DSH_*` 一律不带。 */
function runDsh(home: string, flag: '--dump-config' | '--dump-config-schema'): string {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('DSH_')) env[k] = v
  env.DSH_HOME = home
  const res = spawnSync(process.execPath, [dshBin(), '--profile', 'agentsws', flag], {
    cwd: home,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  // `--dump-config-schema` 在"有插件的 schema 只导出了一部分"时退出码是 1（上游 `runDumpConfigSchema`），
  // 那不妨碍按 id 校验；真正坏掉的是没有输出。
  const okCodes = flag === '--dump-config-schema' ? [0, 1] : [0]
  expect(okCodes, `dsh ${flag} 失败：${res.stderr}`).toContain(res.status)
  expect(res.stdout.length, `dsh ${flag} 没有输出：${res.stderr}`).toBeGreaterThan(0)
  return res.stdout
}

/** 一个 `$ref`（`#/$defs/<名>`）指向的配置 schema 里，对象分支声明了哪些字段。 */
function configFields(dump: SchemaDump, ref: string | undefined): Set<string> {
  const out = new Set<string>()
  const name = ref?.startsWith('#/$defs/') === true ? ref.slice('#/$defs/'.length) : undefined
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return
    const n = node as { properties?: Record<string, unknown>; anyOf?: unknown[]; allOf?: unknown[] }
    for (const key of Object.keys(n.properties ?? {})) out.add(key)
    for (const branch of [...(n.anyOf ?? []), ...(n.allOf ?? [])]) visit(branch, depth + 1)
  }
  if (name !== undefined) visit(dump.$defs[name], 0)
  return out
}

/**
 * 按 dsh 导出的 schema 校验一组锁定行，返回全部问题（空数组 = 通过）。
 * `expected` 给出每个 id 应当指向的插件；不在表里的 id 只查"存不存在"。
 */
function lockdownProblems(
  rows: readonly PatchRow[],
  dump: SchemaDump,
  expected: readonly LockdownRow[] = LOCKDOWN,
): string[] {
  const problems: string[] = []
  const { entries, diagnostics } = dump['x-cordis']
  for (const row of rows) {
    const id = row.id
    if (id === undefined) {
      problems.push('有一行锁定没写 id')
      continue
    }
    const hits = entries.filter((e) => e.id === id)
    if (hits.length === 0) {
      problems.push(`${id}：当前 dsh 的组合里没有这个 id（这一行什么都没关）`)
      continue
    }
    const want = expected.find((l) => l.id === id)
    if (want !== undefined && !hits.some((e) => e.name === want.name)) {
      problems.push(`${id}：现在指向 ${hits.map((e) => e.name).join(' / ')}，不是 ${want.name}`)
    }
    if (row.config !== undefined && row.config !== null && typeof row.config === 'object') {
      const hit = hits.find((e) => want === undefined || e.name === want.name) ?? hits[0]
      const fields = configFields(dump, hit?.configRef)
      for (const key of Object.keys(row.config)) {
        if (!fields.has(key)) {
          problems.push(
            `${id}：配置字段 ${key} 不在 ${hit?.name} 的配置 schema 里（${hit?.status}）`,
          )
        }
      }
    }
  }
  // dsh 自己的诊断：patch 指向不存在的 entry 时它只打 warning 然后跳过
  for (const d of diagnostics) {
    for (const row of rows) {
      if (row.id !== undefined && d.message.includes(`"${row.id}"`)) {
        problems.push(`dsh 诊断（${d.level}）：${d.message}`)
      }
    }
  }
  return problems
}

type ComposedRow = PatchRow & { id?: string }

/** `--dump-config` 输出的组合树（`!!js` 标量原样留成 `{ js }`，不求值）。 */
function parseComposed(text: string): ComposedRow[] {
  return parse(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (src: string) => ({ js: src }) }],
  }) as ComposedRow[]
}

describe('WP133 锁定的每个 id 都真的存在于当前 dsh 的配置 schema 里（`--dump-config-schema`）', () => {
  let home = ''
  let dump: SchemaDump
  let rows: PatchRow[] = []

  beforeAll(() => {
    rows = parse(readFileSync(PATCH, 'utf8')) as PatchRow[]
    home = stageProfile()
    dump = JSON.parse(runDsh(home, '--dump-config-schema')) as SchemaDump
  }, 180_000)

  afterAll(() => {
    if (home !== '') rmSync(home, { recursive: true, force: true })
  })

  it('schema 的形状是我们以为的那样（id / name / configRef 都在），不是空表', () => {
    const entries = dump['x-cordis'].entries
    // 反向哨兵：base 里一定有的两行；导不出来说明 dump 没真的读到 bundle
    expect(entries.map((e) => e.id)).toContain('session')
    expect(entries.map((e) => e.id)).toContain('authorization')
    expect(entries.length).toBeGreaterThan(20)
  })

  it('每一行锁定：id 存在、指向的还是那个插件、改的配置字段还在', () => {
    expect(lockdownProblems(rows, dump)).toEqual([])
  })

  it('改配置的那一行有真正的配置 schema 可查（不是 unknownConfig）', () => {
    for (const want of LOCKDOWN.filter((l) => l.config !== undefined)) {
      const hit = dump['x-cordis'].entries.find((e) => e.id === want.id)
      expect(hit?.status, want.id).toBe('schema')
    }
  })

  it('dsh 自己组合出来的树里，这几行最终确实是关的（`--dump-config`）', () => {
    const composed = parseComposed(runDsh(home, '--dump-config'))
    for (const want of LOCKDOWN) {
      const row = composed.find((r) => r?.id === want.id)
      expect(row, `组合树里没有 ${want.id}`).toBeDefined()
      expect(row?.name, want.id).toBe(want.name)
      if (want.disabled === true) expect(row?.disabled, `${want.id} 组合后没关`).toBe(true)
      for (const [key, value] of Object.entries(want.config ?? {})) {
        expect(
          (row?.config as Record<string, unknown> | undefined)?.[key],
          `${want.id}.${key}`,
        ).toBe(value)
      }
    }
  }, 120_000)

  it('反向哨兵：塞一行不存在的 id，同一套检查必须报出它', () => {
    const bogus = 'agentsws-no-such-entry'
    const extra = `\n- id: ${bogus}\n  disabled: true\n`
    const bad = stageProfile(extra)
    try {
      const badDump = JSON.parse(runDsh(bad, '--dump-config-schema')) as SchemaDump
      const badRows = [...rows, { id: bogus, disabled: true }]
      const problems = lockdownProblems(badRows, badDump)
      expect(problems.some((p) => p.startsWith(`${bogus}：当前 dsh 的组合里没有这个 id`))).toBe(
        true,
      )
      // dsh 自己也只是打了一行 warning——这正是"静默失效"的样子
      expect(problems.some((p) => p.includes(`entry "${bogus}" not found`))).toBe(true)
    } finally {
      rmSync(bad, { recursive: true, force: true })
    }
  }, 120_000)

  it('反向哨兵：id 还在、但上游把它换成了别的插件，也要报', () => {
    const swapped: SchemaDump = {
      ...dump,
      'x-cordis': {
        ...dump['x-cordis'],
        entries: dump['x-cordis'].entries.map((e) =>
          e.id === 'hmr' ? { ...e, name: '@someone/else-hmr' } : e,
        ),
      },
    }
    expect(lockdownProblems(rows, swapped)).toEqual([
      'hmr：现在指向 @someone/else-hmr，不是 @deepseek-ai/dsh-hmr',
    ])
  })

  it('反向哨兵：上游把 session-log-deepseek 的 enabled 字段改了名，也要报', () => {
    const ref = dump['x-cordis'].entries.find((e) => e.id === 'session-log-deepseek')?.configRef
    const name = ref?.slice('#/$defs/'.length) ?? ''
    const renamed: SchemaDump = {
      ...dump,
      $defs: { ...dump.$defs, [name]: { anyOf: [{ type: 'object', properties: { on: {} } }] } },
    }
    expect(lockdownProblems(rows, renamed)).toEqual([
      'session-log-deepseek：配置字段 enabled 不在 @deepseek-ai/dsh-session-log-deepseek 的配置 schema 里（schema）',
    ])
  })
})
