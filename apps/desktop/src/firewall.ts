/**
 * WP422：Windows 防火墙的「允许」随更新带过去。
 *
 * 为什么要有：WP327 起一版一个目录（`<根>\app-<版本>\`），防火墙按**解开联接后的真实路径**记「允许」——
 * 用户对 `app-0.2.0-beta.6\resources\node\node.exe` 点过允许，换到 beta.9 又是一个新路径，又弹一次。
 * （只有开了「让同事在局域网里找到我」才会弹：局域网发现要在网卡上绑 UDP 5353；开关关着服务进程不碰网络。）
 *
 * 做法（装完 / 摆好新版之后跑一次）：
 * 1. 读出程序路径在安装根目录下的防火墙规则；
 * 2. 有指向旧版 Node 的**入站允许**规则（= 用户点过允许）→ 给新版的 Node 加一条同样的允许规则，
 *    名字统一叫 {@link FIREWALL_RULE_NAME}，范围（专用 / 公用 / 域）照旧规则的并集；
 *    **从没点过允许的不加**（不擅自开防火墙）；
 * 3. 指向的程序已经不在了的规则（旧版本目录已删）→ 删掉；
 * 4. 改规则要管理员权限：拿不到就跳过、记一句，**不弹 UAC**。
 *
 * WP427（决策 1273 ②）起服务进程跑在 `<根>\node\node.exe`（不随版本变），一次允许一直有效，这一套
 * 退成兜底：给了 `target` 就把以前对版本目录里 Node 点过的允许带到那份身上（要管理员，按机器装的安装程序
 * 那一次做得到）；不随版本变的那份没备好时照旧带给新版本目录里那份。
 *
 * 两个入口用同一份：安装程序（`build/installer.nsh` 用新版自带的 Node 跑 `firewall-cli.js`），
 * 应用内快速更新（`main.ts` 摆好新版之后、清完旧版本目录之后）。读写走 PowerShell 的 NetSecurity
 * （`netsh` 的输出按系统语言翻译，中文系统上不好认；NetSecurity 的字段不翻译）。
 * 本文件不 import electron；跑 PowerShell 是注入的，规划在 vitest 里用替身跑。
 */
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

/** 我们加的规则统一叫这个（以后好认好删；卸载时按这个名字删）。 */
export const FIREWALL_RULE_NAME = 'Agents 工坊（局域网发现）'
export const FIREWALL_RULE_DESCRIPTION =
  '更新时由 Agents 工坊带过来：你以前对旧版点过「允许」。删掉它只影响「让同事在局域网里找到我」。'

/** 读出来的一条规则（只要这几样）。 */
export interface FirewallRule {
  /** 规则的唯一名（`Get-NetFirewallRule` 的 `Name`，删的时候用它）。 */
  id: string
  /** 显示名。 */
  name: string
  /** `Allow` / `Block`。 */
  action: string
  /** `Inbound` / `Outbound`。 */
  direction: string
  enabled: boolean
  /** `Any` 或 `Domain, Private, Public` 的组合。 */
  profile: string
  /** 展开过环境变量的程序路径。 */
  program: string
}

export interface FirewallPlan {
  /** 要给新版 Node 加的那一条（没有 = 不加）。 */
  add?: { name: string; description: string; program: string; profiles: string[] }
  /** 要删的（指向的程序已经不在了）。 */
  remove: FirewallRule[]
}

/** 一版目录里的服务进程 Node（与 `bundled-node.ts` 的 Windows 第一候选同一个位置）。 */
export function nodeExeOf(versionDir: string): string {
  return win32.join(versionDir, 'resources', 'node', 'node.exe')
}

const norm = (p: string): string => win32.normalize(p).toLowerCase()

/** `p` 在 `root` 底下（不分大小写）。 */
function under(root: string, p: string): boolean {
  const r = norm(root).replace(/\\+$/, '')
  return norm(p).startsWith(`${r}\\`)
}

const isNodeExe = (p: string): boolean => win32.basename(p).toLowerCase() === 'node.exe'

const isInboundAllow = (r: FirewallRule): boolean =>
  r.enabled && r.action.toLowerCase() === 'allow' && r.direction.toLowerCase() === 'inbound'

/** 几条规则的范围并集；有一条是 Any 就是 Any。 */
function unionProfiles(rules: readonly FirewallRule[]): string[] {
  const order = ['Domain', 'Private', 'Public']
  const seen = new Set<string>()
  for (const r of rules) {
    for (const part of r.profile.split(/[,\s]+/)) {
      const p = part.trim()
      if (p === '') continue
      if (p.toLowerCase() === 'any') return ['Any']
      const known = order.find((o) => o.toLowerCase() === p.toLowerCase())
      if (known !== undefined) seen.add(known)
    }
  }
  const out = order.filter((o) => seen.has(o))
  return out.length === 0 ? ['Any'] : out
}

/**
 * 该做什么（纯函数）：
 * - 加：根目录下别的 Node 有**启用的入站允许**规则，而新版的 Node 还没有 → 加一条；
 * - 删：程序在根目录下、文件已经不在了的规则（不论允许还是阻止——指向不存在的程序，留着只是垃圾）。
 */
export function planFirewall(input: {
  root: string
  /** 新版（或当前）版本目录。 */
  dir: string
  /**
   * WP427：服务进程真正跑的那份 Node。给了（`<根>\node\node.exe`，不随版本变）就把允许落在它身上——
   * 以前对某一版 Node 点过的允许也算数，带到它身上；之后再换版本它不变，就不用再带了。
   * 不给 = 新版版本目录里那份（WP422 原样，留作兜底：不随版本变的那份没备好时）。
   */
  target?: string
  rules: readonly FirewallRule[]
  exists: (path: string) => boolean
}): FirewallPlan {
  const target = input.target ?? nodeExeOf(input.dir)
  const ours = input.rules.filter((r) => under(input.root, r.program))
  const evidence = ours.filter(
    (r) => isInboundAllow(r) && isNodeExe(r.program) && norm(r.program) !== norm(target),
  )
  const already = ours.some((r) => isInboundAllow(r) && norm(r.program) === norm(target))
  const remove = ours.filter((r) => norm(r.program) !== norm(target) && !input.exists(r.program))
  return {
    ...(evidence.length > 0 && !already
      ? {
          add: {
            name: FIREWALL_RULE_NAME,
            description: FIREWALL_RULE_DESCRIPTION,
            program: target,
            profiles: unionProfiles(evidence),
          },
        }
      : {}),
    remove,
  }
}

// ── PowerShell ────────────────────────────────────────────────────────────

/** 读：当前是不是管理员 + 程序在根目录下的规则（JSON，UTF-8）。根目录经环境变量给，免得拼引号。 */
export const READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = ($env:AGENTSWS_FW_ROOT.TrimEnd('\\') + '\\').ToLowerInvariant()
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$admin = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$rules = New-Object System.Collections.ArrayList
foreach ($f in @(Get-NetFirewallApplicationFilter -All)) {
  $p = [Environment]::ExpandEnvironmentVariables([string]$f.Program)
  if (-not $p.ToLowerInvariant().StartsWith($root)) { continue }
  foreach ($r in @($f | Get-NetFirewallRule)) {
    [void]$rules.Add([pscustomobject]@{
      id = [string]$r.Name; name = [string]$r.DisplayName; action = [string]$r.Action
      direction = [string]$r.Direction; enabled = ([string]$r.Enabled -eq 'True')
      profile = [string]$r.Profile; program = $p
    })
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ admin = $admin; rules = @($rules.ToArray()) })
`

/** 写：按计划加 / 删（计划经环境变量给）。一条失败不挡别的。 */
export const WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$plan = $env:AGENTSWS_FW_PLAN | ConvertFrom-Json
$added = 0; $removed = 0; $failed = New-Object System.Collections.ArrayList
if ($null -ne $plan.add) {
  try {
    New-NetFirewallRule -DisplayName $plan.add.name -Description $plan.add.description -Direction Inbound -Action Allow -Program $plan.add.program -Profile @($plan.add.profiles) | Out-Null
    $added = 1
  } catch { [void]$failed.Add('add: ' + $_.Exception.Message) }
}
foreach ($id in @($plan.remove)) {
  try { Remove-NetFirewallRule -Name $id; $removed++ } catch { [void]$failed.Add('remove ' + $id + ': ' + $_.Exception.Message) }
}
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ added = $added; removed = $removed; failed = @($failed.ToArray()) })
`

/** 跑一段 PowerShell（脚本、额外的环境变量）→ 退出码与标准输出。 */
export type PowerShellRunner = (
  script: string,
  env: Record<string, string>,
) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** 真的那份：系统目录里的 Windows PowerShell，`-EncodedCommand`（不受执行策略影响、不用拼引号）。 */
export function nodePowerShell(timeoutMs = 60_000): PowerShellRunner {
  return (script, env) =>
    new Promise((resolve) => {
      const exe = win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      execFile(
        exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        {
          env: { ...process.env, ...env },
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          const code =
            err === null ? 0 : typeof err.code === 'number' ? err.code : (null as number | null)
          resolve({ code, stdout: String(stdout), stderr: String(stderr) })
        },
      )
    })
}

export type FirewallOutcome =
  | { kind: 'nothing' }
  | { kind: 'not-admin'; add: boolean; remove: number }
  | { kind: 'done'; added: number; removed: number; failed: string[] }
  | { kind: 'error'; detail: string }

function parseRead(stdout: string): { admin: boolean; rules: FirewallRule[] } | undefined {
  try {
    const raw = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as {
      admin?: unknown
      rules?: unknown
    }
    const list = Array.isArray(raw.rules) ? raw.rules : raw.rules == null ? [] : [raw.rules]
    const rules: FirewallRule[] = []
    for (const r of list as Record<string, unknown>[]) {
      if (typeof r?.id !== 'string' || typeof r.program !== 'string') continue
      rules.push({
        id: r.id,
        name: String(r.name ?? ''),
        action: String(r.action ?? ''),
        direction: String(r.direction ?? ''),
        enabled: r.enabled === true,
        profile: String(r.profile ?? ''),
        program: r.program,
      })
    }
    return { admin: raw.admin === true, rules }
  } catch {
    return undefined
  }
}

/**
 * 一次「带过去 + 清掉」。永远不抛：结果交给调用方记日志。
 * 只在 Windows、版本目录布局下调；`dir` 是新版（或当前）版本目录。
 */
export async function carryFirewall(input: {
  root: string
  dir: string
  /** WP427：服务进程真正跑的那份 Node（见 {@link planFirewall}）。 */
  target?: string
  exists: (path: string) => boolean
  run: PowerShellRunner
}): Promise<FirewallOutcome> {
  try {
    const read = await input.run(READ_SCRIPT, { AGENTSWS_FW_ROOT: input.root })
    const parsed = read.code === 0 ? parseRead(read.stdout) : undefined
    if (parsed === undefined)
      return {
        kind: 'error',
        detail: `读防火墙规则失败（退出码 ${String(read.code)}）：${read.stderr.trim().slice(0, 300)}`,
      }
    const plan = planFirewall({
      root: input.root,
      dir: input.dir,
      ...(input.target === undefined ? {} : { target: input.target }),
      rules: parsed.rules,
      exists: input.exists,
    })
    if (plan.add === undefined && plan.remove.length === 0) return { kind: 'nothing' }
    if (!parsed.admin)
      return { kind: 'not-admin', add: plan.add !== undefined, remove: plan.remove.length }
    const write = await input.run(WRITE_SCRIPT, {
      AGENTSWS_FW_PLAN: JSON.stringify({
        ...(plan.add === undefined ? {} : { add: plan.add }),
        remove: plan.remove.map((r) => r.id),
      }),
    })
    try {
      const raw = JSON.parse(write.stdout.trim().replace(/^\uFEFF/, '')) as {
        added?: unknown
        removed?: unknown
        failed?: unknown
      }
      const failed = Array.isArray(raw.failed)
        ? raw.failed.map(String)
        : raw.failed == null
          ? []
          : [String(raw.failed)]
      return {
        kind: 'done',
        added: Number(raw.added ?? 0),
        removed: Number(raw.removed ?? 0),
        failed,
      }
    } catch {
      return {
        kind: 'error',
        detail: `改防火墙规则失败（退出码 ${String(write.code)}）：${write.stderr.trim().slice(0, 300)}`,
      }
    }
  } catch (err) {
    return { kind: 'error', detail: String(err) }
  }
}

/** 给日志的一句人话。 */
export function describeOutcome(o: FirewallOutcome): string {
  switch (o.kind) {
    case 'nothing':
      return '防火墙：没有要带过去或要清的规则'
    case 'not-admin':
      return `防火墙：没有管理员权限，跳过（本来要${o.add ? '加 1 条允许规则、' : ''}删 ${o.remove} 条旧规则；不弹 UAC）`
    case 'done':
      return `防火墙：加了 ${o.added} 条、删了 ${o.removed} 条${o.failed.length > 0 ? `；没成的：${o.failed.join(' / ')}` : ''}`
    case 'error':
      return `防火墙：${o.detail}`
  }
}
