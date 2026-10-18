/**
 * WP422：防火墙的「允许」随更新带过去（`src/firewall.ts`）+ 安装器里的那两处写法。
 * PowerShell 只在 Windows 真机上跑；这里规划用纯函数、执行用替身。
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 这里比对的是 NSIS 源码里的 ${…} 写法，不是 JS 模板
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  carryFirewall,
  describeOutcome,
  FIREWALL_RULE_NAME,
  type FirewallRule,
  nodeExeOf,
  type PowerShellRunner,
  planFirewall,
  READ_SCRIPT,
  WRITE_SCRIPT,
} from '../src/firewall.js'

const ROOT = 'C:\\Users\\某人\\AppData\\Local\\Programs\\agentsws'
const app = (v: string): string => `${ROOT}\\app-${v}`
const NEW = app('0.2.1-beta.2')
const OLD = app('0.2.1-beta.1')

let seq = 0
function rule(program: string, over: Partial<FirewallRule> = {}): FirewallRule {
  seq += 1
  return {
    id: `{rule-${seq}}`,
    name: 'Node.js JavaScript Runtime',
    action: 'Allow',
    direction: 'Inbound',
    enabled: true,
    profile: 'Private',
    program,
    ...over,
  }
}

/** 版本目录还在的：OLD 与 NEW；更早的都删了。 */
const exists = (p: string): boolean =>
  [nodeExeOf(OLD), nodeExeOf(NEW)].some((x) => x.toLowerCase() === p.toLowerCase())

describe('planFirewall', () => {
  it('从没点过允许（没有任何规则）→ 什么都不做', () => {
    expect(planFirewall({ root: ROOT, dir: NEW, rules: [], exists })).toEqual({ remove: [] })
  })

  it('只有「阻止」规则（用户点过取消）→ 不替他加允许', () => {
    const plan = planFirewall({
      root: ROOT,
      dir: NEW,
      rules: [rule(nodeExeOf(OLD), { action: 'Block' })],
      exists,
    })
    expect(plan.add).toBeUndefined()
  })

  it('对旧版点过允许 → 给新版的 Node 加一条，名字统一、范围照旧（TCP / UDP 两条合并成并集）', () => {
    const plan = planFirewall({
      root: ROOT,
      dir: NEW,
      rules: [
        rule(nodeExeOf(OLD), { profile: 'Private' }),
        rule(nodeExeOf(OLD), { profile: 'Private, Public' }),
      ],
      exists,
    })
    expect(plan.add).toEqual({
      name: FIREWALL_RULE_NAME,
      description: expect.any(String),
      program: nodeExeOf(NEW),
      profiles: ['Private', 'Public'],
    })
    expect(plan.remove).toEqual([])
  })

  it('旧规则是 Any → 新规则也是 Any', () => {
    const plan = planFirewall({
      root: ROOT,
      dir: NEW,
      rules: [rule(nodeExeOf(OLD), { profile: 'Any' })],
      exists,
    })
    expect(plan.add?.profiles).toEqual(['Any'])
  })

  it('新版已经有允许规则了 → 不重复加（再跑一次是幂等的）', () => {
    const plan = planFirewall({
      root: ROOT,
      dir: NEW,
      rules: [rule(nodeExeOf(OLD)), rule(nodeExeOf(NEW), { name: FIREWALL_RULE_NAME })],
      exists,
    })
    expect(plan.add).toBeUndefined()
  })

  it('停用的允许规则不算点过允许', () => {
    const plan = planFirewall({
      root: ROOT,
      dir: NEW,
      rules: [rule(nodeExeOf(OLD), { enabled: false })],
      exists,
    })
    expect(plan.add).toBeUndefined()
  })

  it('指向已经删掉的旧版本目录的规则（允许 / 阻止都算）→ 删；还在的上一版留着（回滚要用）', () => {
    const gone1 = rule(nodeExeOf(app('0.2.0-beta.6')))
    const gone2 = rule(nodeExeOf(app('0.2.0-beta.9')), { action: 'Block' })
    const keep = rule(nodeExeOf(OLD))
    const plan = planFirewall({ root: ROOT, dir: NEW, rules: [gone1, gone2, keep], exists })
    expect(plan.remove).toEqual([gone1, gone2])
    // 删掉的那些也算「点过允许」的证据：带过来
    expect(plan.add?.program).toBe(nodeExeOf(NEW))
  })

  it('只认安装根目录底下的；路径不分大小写', () => {
    const elsewhere = rule('C:\\Program Files\\nodejs\\node.exe')
    const upper = rule(nodeExeOf(OLD).toUpperCase())
    const plan = planFirewall({ root: ROOT, dir: NEW, rules: [elsewhere, upper], exists })
    expect(plan.remove).toEqual([])
    expect(plan.add?.program).toBe(nodeExeOf(NEW))
  })

  it('平铺布局时代（迁移前）点过的允许也算，平铺那份已经挪走 → 删', () => {
    const flat = rule(`${ROOT}\\resources\\node\\node.exe`)
    const plan = planFirewall({ root: ROOT, dir: NEW, rules: [flat], exists })
    expect(plan.add?.program).toBe(nodeExeOf(NEW))
    expect(plan.remove).toEqual([flat])
  })
})

/** 替身 PowerShell：第一次回读到的规则，第二次记下计划。 */
function fakeShell(read: { admin: boolean; rules: FirewallRule[] } | { fail: true }) {
  const calls: { script: string; env: Record<string, string> }[] = []
  const run: PowerShellRunner = async (script, env) => {
    calls.push({ script, env })
    if (script === READ_SCRIPT) {
      if ('fail' in read)
        return { code: 1, stdout: '', stderr: 'Get-NetFirewallApplicationFilter 不认' }
      return { code: 0, stdout: `\uFEFF${JSON.stringify(read)}\r\n`, stderr: '' }
    }
    const plan = JSON.parse(env.AGENTSWS_FW_PLAN ?? '{}') as { add?: unknown; remove: string[] }
    return {
      code: 0,
      stdout: JSON.stringify({
        added: plan.add === undefined ? 0 : 1,
        removed: plan.remove.length,
        failed: [],
      }),
      stderr: '',
    }
  }
  return { calls, run }
}

describe('carryFirewall', () => {
  it('没有管理员权限 → 只读、不写、回一句「跳过」（不弹 UAC）', async () => {
    const { calls, run } = fakeShell({ admin: false, rules: [rule(nodeExeOf(OLD))] })
    const out = await carryFirewall({ root: ROOT, dir: NEW, exists, run })
    expect(out).toEqual({ kind: 'not-admin', add: true, remove: 0 })
    expect(calls.map((c) => c.script)).toEqual([READ_SCRIPT])
    expect(calls[0]?.env).toEqual({ AGENTSWS_FW_ROOT: ROOT })
    expect(describeOutcome(out)).toContain('不弹 UAC')
  })

  it('管理员 → 按计划写：加新版、删指向已删目录的（按规则唯一名删）', async () => {
    const gone = rule(nodeExeOf(app('0.2.0-beta.6')))
    const { calls, run } = fakeShell({ admin: true, rules: [gone] })
    const out = await carryFirewall({ root: ROOT, dir: NEW, exists, run })
    expect(out).toEqual({ kind: 'done', added: 1, removed: 1, failed: [] })
    expect(calls[1]?.script).toBe(WRITE_SCRIPT)
    const plan = JSON.parse(calls[1]?.env.AGENTSWS_FW_PLAN ?? '') as {
      add: { name: string; program: string }
      remove: string[]
    }
    expect(plan.add.name).toBe(FIREWALL_RULE_NAME)
    expect(plan.add.program).toBe(nodeExeOf(NEW))
    expect(plan.remove).toEqual([gone.id])
  })

  it('用户从没点过允许 → 连写都不跑', async () => {
    const { calls, run } = fakeShell({ admin: true, rules: [] })
    expect(await carryFirewall({ root: ROOT, dir: NEW, exists, run })).toEqual({ kind: 'nothing' })
    expect(calls).toHaveLength(1)
  })

  it('读失败 / 跑不起来 → 回 error，不抛', async () => {
    const { run } = fakeShell({ fail: true })
    const out = await carryFirewall({ root: ROOT, dir: NEW, exists, run })
    expect(out.kind).toBe('error')
    const boom: PowerShellRunner = async () => {
      throw new Error('spawn ENOENT')
    }
    expect((await carryFirewall({ root: ROOT, dir: NEW, exists, run: boom })).kind).toBe('error')
  })

  it('PowerShell 只读一条规则时 rules 可能不是数组 → 照样认', async () => {
    const one = rule(nodeExeOf(OLD))
    const run: PowerShellRunner = async (script) =>
      script === READ_SCRIPT
        ? { code: 0, stdout: JSON.stringify({ admin: false, rules: one }), stderr: '' }
        : { code: 0, stdout: '{}', stderr: '' }
    expect(await carryFirewall({ root: ROOT, dir: NEW, exists, run })).toEqual({
      kind: 'not-admin',
      add: true,
      remove: 0,
    })
  })

  it('脚本不拼路径：根目录与计划都经环境变量进去；改规则用 NetSecurity、不用 runas', () => {
    expect(READ_SCRIPT).toContain('$env:AGENTSWS_FW_ROOT')
    expect(WRITE_SCRIPT).toContain('$env:AGENTSWS_FW_PLAN')
    expect(WRITE_SCRIPT).toContain('New-NetFirewallRule')
    expect(WRITE_SCRIPT).toContain('-Direction Inbound -Action Allow')
    for (const s of [READ_SCRIPT, WRITE_SCRIPT]) expect(s.toLowerCase()).not.toContain('runas')
  })
})

/* ── installer.nsh ──────────────────────────────────────────────────────── */

const text = readFileSync(new URL('../build/installer.nsh', import.meta.url)).toString('utf8')
function macroBody(name: string): string {
  const at = text.search(new RegExp(`!macro ${name}\\r?\\n`))
  expect(at, `找不到宏 ${name}`).toBeGreaterThanOrEqual(0)
  return text.slice(at, text.indexOf('!macroend', at))
}

describe('installer.nsh：防火墙', () => {
  it('建好 current 联接之后用新版自带的 Node 跑 firewall-cli；带超时、不看退出码', () => {
    const install = macroBody('customInstall')
    const cli = install.indexOf('firewall-cli.js" --root "$INSTDIR" --dir "$R8"')
    expect(cli).toBeGreaterThan(install.indexOf('mklink /J'))
    expect(install).toContain(
      'nsExec::ExecToLog /TIMEOUT=90000 \'"$R8\\resources\\node\\node.exe" "$R8\\resources\\app\\dist\\firewall-cli.js"',
    )
    // 在「联接建好了」那一支里（平铺回退那一支不跑）
    expect(cli).toBeGreaterThan(install.indexOf('StrCpy $appExe "$INSTDIR\\current\\'))
    expect(install).not.toMatch(/SetErrorLevel|Abort/)
  })

  it('真卸载按统一的名字删规则；更新前卸旧版那一支不删', () => {
    const remove = macroBody('customRemoveFiles')
    const del = remove.indexOf(`delete rule name="${FIREWALL_RULE_NAME}"`)
    expect(del).toBeGreaterThan(remove.indexOf('${Else}'))
    expect(del).toBeLessThan(remove.indexOf('RMDir /r $INSTDIR'))
  })
})
