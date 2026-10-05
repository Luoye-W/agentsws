/**
 * WP225（WP218 决定 ④）：Windows 上 AI「跑命令」走 PowerShell，不要求装 Git Bash。
 *
 * (a) 用哪种壳：Windows → `pwsh`，别处 → `bash`；工具名跟着变。
 * (b) PowerShell 那一档的命令表：同一张白名单，外加 PowerShell 才有的几种「能把别的东西带进来」的写法
 *     （子表达式、脚本块、变量）一律拒；命令名不分大小写、`.cmd` / `.exe` 归一；Windows 路径判越界。
 * (c) 执行器：起 PowerShell 时加 `-ExecutionPolicy Bypass`（npm 的 `.ps1` 壳在 5.1 默认策略下跑不起来）。
 * (d) 真挂一次（在 mac 上用 `shellFlavor: 'pwsh'` 装 Windows 那一套）：模型面前是 `pwsh` 不是 `bash`，
 *     提示词那一段说的是 PowerShell；门禁照样先过命令表（表外的命令子进程一次都不起）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunShell } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { DshHarness } from '../src/index.js'
import {
  BASH_TOOL,
  checkShellCommand,
  commandHead,
  createHarness,
  insideRoot,
  isShellTool,
  PWSH_TOOL,
  shellBrief,
  shellFlavor,
  shellToolName,
  withExecutionPolicyBypass,
} from '../src/index.js'
import { classifySideEffect } from '../src/tools.js'
import { baseOptions, collect, FixedClock, makeRequest, recorder } from './helpers.js'

describe('(a) 用哪种壳', () => {
  it('Windows 是 pwsh，mac / Linux 是 bash；工具名跟着变', () => {
    expect(shellFlavor('win32')).toBe('pwsh')
    expect(shellFlavor('darwin')).toBe('bash')
    expect(shellFlavor('linux')).toBe('bash')
    expect(shellToolName('pwsh')).toBe(PWSH_TOOL)
    expect(shellToolName('bash')).toBe(BASH_TOOL)
    expect(isShellTool('pwsh')).toBe(true)
    expect(isShellTool('bash')).toBe(true)
    expect(isShellTool('web_fetch')).toBe(false)
  })

  it('两种工具名在读写分类里都是「写外部」（真正的分类由门禁按命令表先给）', () => {
    expect(classifySideEffect('pwsh')).toBe('write_external')
    expect(classifySideEffect('bash')).toBe('write_external')
  })
})

describe('(b) PowerShell 那一档的命令表', () => {
  const ROOT = 'C:\\Users\\张三\\AppData\\Roaming\\@agentsws\\desktop\\data\\themes\\ws\\shop'
  const check = (command: string, over: Record<string, unknown> = {}) =>
    checkShellCommand({ command, root: ROOT, flavor: 'pwsh', ...over })

  it('同一张白名单照样放行（命令名不分大小写、.cmd / .exe 归一）', () => {
    for (const cmd of [
      'shopify theme list --json',
      'shopify.cmd theme pull',
      'Git status',
      'git.exe diff',
      'node assets\\build.mjs',
      'npx shopify theme list',
      'npx @shopify/cli theme list',
      'pnpm install',
      'shopify theme push --unpublished --theme "WP225 预览"',
    ]) {
      expect(check(cmd).verdict, cmd).toBe('allow')
    }
    expect(check('SHOPIFY theme publish --theme 7').verdict).toBe('publish')
    expect(commandHead('Shopify.CMD', 'pwsh')).toBe('shopify')
    expect(commandHead('Shopify.CMD', 'bash')).toBe('Shopify.CMD')
    expect(commandHead('x.ps1', 'pwsh')).toBe('x.ps1')
  })

  it('PowerShell 才有的写法一律拒：子表达式、脚本块、变量、调用运算符', () => {
    const denied: [string, string][] = [
      ['shopify theme list $(Get-Process)', 'shell_substitution_forbidden'],
      ['shopify theme list @(1,2)', 'shell_substitution_forbidden'],
      ['git commit -m @{a=1}', 'shell_substitution_forbidden'],
      ['git status; Invoke-Command { whoami }', 'shell_script_block_forbidden'],
      ['node $env:USERPROFILE\\x.js', 'shell_variable_forbidden'],
      ['git add $HOME', 'shell_variable_forbidden'],
      ['& git status', 'shell_background_forbidden'],
      ['git status | Out-File x', 'shell_pipe_forbidden'],
      ['shopify theme list `n whoami', 'shell_substitution_forbidden'],
      ['Remove-Item -Recurse sections', 'shell_destructive_forbidden'],
      ['del sections\\a.liquid', 'shell_destructive_forbidden'],
      ['ri x', 'shell_destructive_forbidden'],
      ['Invoke-Expression "x"', 'shell_command_not_allowed'],
      ['powershell -c whoami', 'shell_command_not_allowed'],
      ['cmd.exe dir', 'shell_command_not_allowed'],
      ['.\\evil.ps1', 'shell_command_not_allowed'],
    ]
    for (const [cmd, code] of denied) {
      const out = check(cmd)
      expect(out.verdict, cmd).toBe('deny')
      expect(out.verdict === 'deny' ? out.reason : '', cmd).toContain(code)
    }
  })

  it('Windows 路径判越界：盘符、UNC、反斜杠的 ..\\、*> 重定向', () => {
    expect(check('node C:\\Windows\\evil.js').verdict).toBe('deny')
    expect(check('node D:/x.js').verdict).toBe('deny')
    expect(check('git add \\\\server\\share\\x').verdict).toBe('deny')
    expect(check('git add ..\\..\\other').verdict).toBe('deny')
    expect(check('git diff *> C:\\Temp\\out.txt').verdict).toBe('deny')
    expect(check('git diff 2> ..\\err.txt').verdict).toBe('deny')
    expect(check('git status', { workdir: 'C:\\Windows' }).verdict).toBe('deny')
    // 副本目录里面的：放行（大小写不同也算在里面）
    expect(check('git diff > diff.txt').verdict).toBe('allow')
    expect(check(`node ${ROOT}\\assets\\a.mjs`).verdict).toBe('allow')
    expect(check('git status', { workdir: 'sections' }).verdict).toBe('allow')
    expect(insideRoot(ROOT, ROOT.toUpperCase())).toBe(true)
    expect(insideRoot(ROOT, 'C:\\Users\\张三\\Desktop')).toBe(false)
  })

  it('bash 那一档不受影响（变量、花括号照旧不额外拦）', () => {
    expect(
      checkShellCommand({ command: 'git commit -m "{x}"', root: '/data/t', flavor: 'bash' })
        .verdict,
    ).toBe('allow')
    expect(checkShellCommand({ command: 'git commit -m "{x}"', root: '/data/t' }).verdict).toBe(
      'allow',
    )
  })
})

describe('(c) 执行器起 PowerShell 的参数', () => {
  it('在 -Command 之前插 -ExecutionPolicy Bypass；已有就不重复；没有 -Command 原样', () => {
    const base = ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'x']
    expect(withExecutionPolicyBypass(base)).toEqual([
      'pwsh.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'x',
    ])
    const already = ['p', '-ExecutionPolicy', 'RemoteSigned', '-Command', 'x']
    expect(withExecutionPolicyBypass(already)).toEqual(already)
    expect(withExecutionPolicyBypass(['p', '-File', 'a.ps1'])).toEqual(['p', '-File', 'a.ps1'])
  })

  it('提示词那一段按壳说话', () => {
    const pwsh = shellBrief({ root: 'C:\\t', mode: 'workspace-write', flavor: 'pwsh' })
    expect(pwsh).toContain('`pwsh` 工具')
    expect(pwsh).toContain('PowerShell')
    expect(pwsh).toContain('Remove-Item')
    const bash = shellBrief({ root: '/t', mode: 'workspace-write' })
    expect(bash).toContain('`bash` 工具')
    expect(bash).not.toContain('PowerShell')
  })
})

// ── (d) 真挂一次 ───────────────────────────────────────────────────────

const open: DshHarness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose()
})

describe('(d) Windows 那一套真挂一次（mac 上用 shellFlavor 模拟）', () => {
  it('模型面前是 pwsh 不是 bash；提示词说 PowerShell；表外的命令在门禁就拦下', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentsws-theme-pwsh-'))
    const shell: RunShell = {
      workspace_root: root,
      mode: 'workspace-write',
      store: 'x.myshopify.com',
    }
    const req = makeRequest({ role_id: 'site.shopify-theme', shell })
    const { sink } = collect()
    const rec = recorder()
    const harness = await createHarness({
      request: req,
      sink,
      provenance: new Provenance(req.id),
      options: baseOptions({
        clock: new FixedClock(),
        stage: rec.stage,
        createDraft: rec.createDraft,
        shellFlavor: 'pwsh',
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
    const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
    expect(names).toContain(PWSH_TOOL)
    expect(names).not.toContain(BASH_TOOL)
    const text = await harness.systemText()
    expect(text).toContain('`pwsh` 工具')
    const res = await harness.gate.execute('c1', PWSH_TOOL, {
      description: 'try',
      command: 'Get-ChildItem $env:USERPROFILE',
    })
    expect(res.isError).toBe(true)
    expect(harness.gate.records.get('c1')?.status).toBe('blocked')
    expect(harness.gate.records.get('c1')?.reason ?? '').toContain('shell_')
  }, 60_000)
})
