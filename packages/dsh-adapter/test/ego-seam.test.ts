/**
 * WP463（docs/111 §3）：**用户自己装的 ego 浏览器**——三个工具、工作说明、门禁只留痕。
 *
 * | 层 | 用什么 | 测什么 |
 * |---|---|---|
 * | 子进程 | **假 `ego-browser`**（一个 Node 脚本：`skill` 打一份说明，`nodejs` 把 stdin 原样回显） | 走 stdin、不经 shell、超时生效、退出码透传、首行判版本 |
 * | 装配 | 真 harness | 三个工具进这个 Agent 的 scope；说明原文进 persona 段；跑不起来就明明白白失败 |
 * | 门禁 | 真门禁 | 任意网址的脚本两档都放行（不过白名单、不按读写拦）+ `progress{step:'ego_run'}`；不给 ego 就拿不到这三个工具 |
 *
 * CI 里不装 ego、不出网：真 ego 只在手工真机那一步跑（报告里有截图）。
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent, RuntimeAdapter } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { describe, expect, it, vi } from 'vitest'
import {
  createDshRuntime,
  createHarness,
  EGO_TOOLS,
  egoRunNote,
  egoRunTimeoutMs,
  isEgoTool,
  parseEgoSkillHeader,
  readEgoSkill,
  spawnEgo,
} from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const DIR = mkdtempSync(join(tmpdir(), 'agentsws-ego-test-'))

/**
 * 假 `ego-browser`：
 * - `skill` → 打一份「使用说明」（首行由参数定，用来造「首行不对」那种）、按参数退出；
 * - `nodejs` → 把 argv 打到 stderr、stdin **原样**回显到 stdout；脚本里有 `__EXIT_3__` 就退 3，
 *   有 `__SLEEP__` 就睡 30 秒（等着被超时停掉）。
 */
function fakeEgo(name: string, header: string, skillExit = 0): string {
  const path = join(DIR, name)
  writeFileSync(
    path,
    `#!${process.execPath}
const mode = process.argv[2]
if (mode === 'skill') {
  process.stdout.write(${JSON.stringify(`${header}\n\n# ego-browser\n\nUse taskSpace(name) and page.goto(url).\n`)})
  process.exit(${skillExit})
}
if (mode === 'nodejs') {
  const chunks = []
  process.stdin.on('data', (c) => chunks.push(c))
  process.stdin.on('end', () => {
    const script = Buffer.concat(chunks).toString('utf8')
    process.stderr.write('ARGV:' + JSON.stringify(process.argv.slice(2)))
    process.stdout.write(script)
    if (script.includes('__EXIT_3__')) process.exit(3)
    if (script.includes('__SLEEP__')) setTimeout(() => process.exit(0), 30000)
    else process.exit(0)
  })
} else {
  process.exit(9)
}
`,
    'utf8',
  )
  chmodSync(path, 0o755)
  return path
}

const GOOD = fakeEgo('ego-browser', '[ego-browser:skill] ego-browser usage guide v2.1.0')
const BAD_HEADER = fakeEgo('ego-browser-bad-header', 'ego-browser help')
const BAD_EXIT = fakeEgo(
  'ego-browser-bad-exit',
  '[ego-browser:skill] ego-browser usage guide v2.1.0',
  2,
)

/** 一段脚本：引号、换行、中文、`$()`、heredoc 结束符都在——经了 shell 就不会原样回来。 */
const NASTY = [
  'const task = await taskSpace("读标题");',
  "await task.page('p1').goto(\"https://example.com/?q=it's\")",
  'console.log(`$(echo hacked) $HOME ; rm -rf / && echo injected`)',
  'EOF',
  '// 中文注释 ✓',
].join('\n')

const EGO = { browser: { mode: 'ego', ego_path: GOOD } as const }

const meta = (req: ReturnType<typeof makeRequest>) => ({
  workspace_id: req.workspace_id,
  assignment_id: req.actor.assignment_id,
  role_id: req.actor.role_id,
  run_id: req.id,
  purpose: 'run' as const,
})

async function harnessOf(req: ReturnType<typeof makeRequest>) {
  const { sink, events } = collect()
  const harness = await createHarness({
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions(),
    buildStageIntent: () => undefined,
    buildDraftPayload: () => undefined,
    model: 'stub-v1',
    meta: meta(req),
  })
  return { harness, events }
}

describe('(a) 探活：`ego-browser skill` 退出码 0、首行对得上才算能用', () => {
  it('首行取版本号；别的样子一律不认', () => {
    expect(parseEgoSkillHeader('[ego-browser:skill] ego-browser usage guide v2.1.0\n\n# x')).toBe(
      '2.1.0',
    )
    expect(
      parseEgoSkillHeader('﻿[ego-browser:skill] ego-browser usage guide v2.2.0-beta.1\r\n'),
    ).toBe('2.2.0-beta.1')
    expect(parseEgoSkillHeader('ego-browser help')).toBeUndefined()
    expect(parseEgoSkillHeader('')).toBeUndefined()
    expect(
      parseEgoSkillHeader('# x\n[ego-browser:skill] ego-browser usage guide v2.1.0'),
    ).toBeUndefined()
  })

  it('能跑：版本 + 原文', async () => {
    const read = await readEgoSkill(GOOD)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.version).toBe('2.1.0')
      expect(read.text).toContain('taskSpace(name)')
    }
  })

  it('退出码非 0 / 首行不对 / 文件不在：都算跑不起来，并说清为什么', async () => {
    const exit = await readEgoSkill(BAD_EXIT)
    expect(exit).toMatchObject({ ok: false })
    if (!exit.ok) expect(exit.detail).toContain('退出码 2')
    const header = await readEgoSkill(BAD_HEADER)
    expect(header).toMatchObject({ ok: false })
    if (!header.ok) expect(header.detail).toContain('首行对不上')
    const missing = await readEgoSkill(join(DIR, 'no-such-ego-browser'))
    expect(missing).toMatchObject({ ok: false })
    if (!missing.ok) expect(missing.detail).toContain('起不来')
  })
})

describe('(b) ego_run：走 stdin、不经 shell、超时生效、退出码透传', () => {
  it('脚本原样到达（引号 / 换行 / 中文 / $() 一个不动），参数只有 nodejs', async () => {
    const res = await spawnEgo({ egoPath: GOOD, args: ['nodejs'], stdin: NASTY, timeoutMs: 20_000 })
    expect(res.exit_code).toBe(0)
    expect(res.timed_out).toBe(false)
    expect(res.stdout).toBe(NASTY)
    // 参数是数组直接给的：没有 `-e`、没有 heredoc、没有 `sh -c`
    expect(res.stderr).toBe('ARGV:["nodejs"]')
    expect(res.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('退出码原样回来（非 0 不当异常）', async () => {
    const res = await spawnEgo({
      egoPath: GOOD,
      args: ['nodejs'],
      stdin: 'throw "__EXIT_3__"',
      timeoutMs: 20_000,
    })
    expect(res.exit_code).toBe(3)
    expect(res.timed_out).toBe(false)
  })

  it('超时：到点停掉我们自己起的那个子进程，标 timed_out', async () => {
    const started = Date.now()
    const res = await spawnEgo({
      egoPath: GOOD,
      args: ['nodejs'],
      stdin: '__SLEEP__',
      timeoutMs: 800,
    })
    expect(res.timed_out).toBe(true)
    expect(res.exit_code).toBeNull()
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(egoRunNote(res)).toContain('超时被停')
  })

  it('运行被取消：同样停掉子进程', async () => {
    const ac = new AbortController()
    const p = spawnEgo({
      egoPath: GOOD,
      args: ['nodejs'],
      stdin: '__SLEEP__',
      timeoutMs: 60_000,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 300)
    const res = await p
    expect(res.exit_code).toBeNull()
    expect(res.timed_out).toBe(false)
  })

  it('超时参数：缺省 120 秒，最多 600 秒', () => {
    expect(egoRunTimeoutMs(undefined)).toBe(120_000)
    expect(egoRunTimeoutMs(300)).toBe(300_000)
    expect(egoRunTimeoutMs(5000)).toBe(600_000)
    expect(egoRunTimeoutMs(0)).toBe(1_000)
    expect(egoRunTimeoutMs('9')).toBe(120_000)
  })

  it('时间线那一行：退出码 · 耗时 · 输出摘要', () => {
    const note = egoRunNote({
      exit_code: 0,
      timed_out: false,
      duration_ms: 1234,
      stdout: 'Example Domain\n',
      stderr: '',
    })
    expect(note).toBe('退出码 0 · 1.2 秒 · Example Domain')
  })
})

describe('(c) 装配：三个工具进这个 Agent 的 scope，说明原文进 persona 段', () => {
  it('RunRequest.browser{mode:ego} → ego_run / ego_guide / ego_status，且不挂官方浏览器那一套', async () => {
    const req = makeRequest({ ...EGO, allowed_hosts: ['example.com'] })
    const { harness } = await harnessOf(req)
    try {
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(names.filter(isEgoTool).sort()).toEqual([...EGO_TOOLS].sort())
      // 职责自己的工具照常在（restrict 只管全局注册的那些）
      expect(names).toContain('get_order')
      expect(names.some((n) => n.startsWith('mcp__playwright-mcp__'))).toBe(false)
      expect(harness.ctx.get('browserUse')).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('persona 段：ego 原文 + 「heredoc 换成 ego_run」「Reddit 只起草」；没有白名单那几句', async () => {
    const req = makeRequest({ ...EGO, allowed_hosts: ['example.com'] })
    const { harness } = await harnessOf(req)
    try {
      const text = await harness.systemText()
      expect(text).toContain('## 浏览器（ego）')
      expect(text).toContain('<ego-browser-skill version="2.1.0">')
      expect(text).toContain('taskSpace(name)')
      expect(text).toContain('一律改成调用 `ego_run`')
      expect(text).toContain('Reddit')
      // WP483（决策 1660）：AI 不在脚本里点发送，出卡；批了工坊自己在 ego 里发
      expect(text).toContain('不要自己在 ego 里点发送')
      expect(text).toContain('工坊会自己在 ego 里填好、发出去')
      // WP483（决策 1661）：红人公开数据记下来（上云备份 + 本机）
      expect(text).toContain('record_creator_observations')
      // 不过白名单（Luoye 10-22）：别的浏览器那段「只能打开这些站」不出现
      expect(text).not.toContain('只能打开这些站')
    } finally {
      await harness.dispose()
    }
  })

  it('经真工具流水线跑一段脚本：原样到达、结果回来、时间线多一行 progress{ego_run}', async () => {
    const req = makeRequest({ ...EGO, allowed_hosts: ['example.com'] })
    const { harness, events } = await harnessOf(req)
    try {
      const res = await harness.gate.execute('c_1', 'ego_run', { script: NASTY })
      expect(res.isError).toBe(false)
      const value = (res as { value: { exit_code: number; stdout: string } }).value
      expect(value.exit_code).toBe(0)
      expect(value.stdout).toContain('$(echo hacked)')
      const guide = await harness.gate.execute('c_2', 'ego_guide', {})
      expect(JSON.stringify((guide as { value: unknown }).value)).toContain('taskSpace(name)')
      const status = await harness.gate.execute('c_3', 'ego_status', {})
      expect((status as { value: unknown }).value).toMatchObject({ ok: true, version: '2.1.0' })
      const progress = events.filter((e: RunEvent) => e.type === 'progress' && e.step === 'ego_run')
      expect(progress).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('ego 跑不起来（首行不对）→ 这次运行明明白白地失败，而不是悄悄没有浏览器', async () => {
    const req = makeRequest({ browser: { mode: 'ego', ego_path: BAD_HEADER } })
    await expect(harnessOf(req)).rejects.toThrow(/ego 跑不起来/u)
  })

  it('不给 RunRequest.browser → 三个工具一个都不存在', async () => {
    const { harness } = await harnessOf(makeRequest())
    try {
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(names.filter(isEgoTool)).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})

describe('(d) 门禁：原样放行 + 留痕', () => {
  it('带任意网址的脚本：白名单外、公司口径的 executor 策略下照样放行，并记 progress{ego_run}', async () => {
    for (const policy of ['personal', 'executor'] as const) {
      // allowed_hosts 只有 example.com，脚本去的是别的站——ego 不过白名单
      const req = makeRequest({
        ...EGO,
        allowed_hosts: ['example.com'],
        side_effect_policy: policy,
      })
      const { harness, events } = await harnessOf(req)
      try {
        const res = await harness.gate.execute('c_1', 'ego_run', {
          script: 'await (await taskSpace("x")).page("p1").goto("https://www.amazon.com/")',
        })
        expect(res.isError, policy).toBe(false)
        expect(harness.gate.records.get('c_1')?.status, policy).toBe('ok')
        expect(
          events.some((e: RunEvent) => e.type === 'progress' && e.step === 'ego_run'),
          policy,
        ).toBe(true)
        // 只留痕不拦：没有任何浏览器那套的拒绝 / 写操作记号
        expect(
          events.some((e: RunEvent) => e.type === 'progress' && e.step === 'browser_write'),
        ).toBe(false)
      } finally {
        await harness.dispose()
      }
    }
  })

  it('公司档拿不到：请求里没有 ego（服务端 forRun 只在个人档给）→ 三个名字都不在 allowlist', async () => {
    const req = makeRequest({ side_effect_policy: 'executor' })
    const { harness } = await harnessOf(req)
    try {
      for (const [i, name] of EGO_TOOLS.entries()) {
        const res = await harness.gate.execute(`c_${i}`, name, { script: '1' })
        expect(res.isError, name).toBe(true)
        expect(harness.gate.records.get(`c_${i}`)?.reason).toBe(`not_in_allowlist: ${name}`)
      }
    } finally {
      await harness.dispose()
    }
  })

  it('选的是别的浏览器（官方 provider）时也拿不到 ego 的三个工具', async () => {
    const req = makeRequest({
      browser: { mode: 'attach', endpoint: 'http://127.0.0.1:1' },
      allowed_hosts: ['example.com'],
    })
    const { harness } = await harnessOf(req)
    try {
      const res = await harness.gate.execute('c_1', 'ego_run', { script: '1' })
      expect(res.isError).toBe(true)
      expect(harness.gate.records.get('c_1')?.reason).toBe('not_in_allowlist: ego_run')
    } finally {
      await harness.dispose()
    }
  })
})

describe('(e) 整次运行：挂着 ego 跑完（假 ego-browser，不出网）', () => {
  it('in-process', async () => {
    const runtime: RuntimeAdapter = createDshRuntime({ ...baseOptions(), mode: 'in-process' })
    const { sink, events } = collect()
    const req = makeRequest({
      ...EGO,
      allowed_hosts: ['example.com'],
      side_effect_policy: 'personal',
    })
    const result = await runtime.run(req, sink, new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})
