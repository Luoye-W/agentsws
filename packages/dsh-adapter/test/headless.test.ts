/**
 * headless 子进程档的边角（WP30 A）：模式探测、隔离、崩溃、超时、token。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  createDshRuntime,
  createSubprocessDshRuntime,
  defaultChildEntry,
  ENV_RUN_TOKEN,
  resolveMode,
  subprocessAvailable,
} from '../src/index.js'
import { baseOptions, collect, FixedClock, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const NO_ABORT = (): AbortSignal => new AbortController().signal

describe('装配形态（mode）', () => {
  it('显式 mode 说了算；auto 按能力探测（编译产物在就走子进程）', () => {
    expect(resolveMode({ ...baseOptions(), mode: 'in-process' })).toBe('in-process')
    expect(resolveMode({ ...baseOptions(), mode: 'subprocess' })).toBe('subprocess')
    expect(resolveMode(baseOptions())).toBe(subprocessAvailable() ? 'subprocess' : 'in-process')
  })

  it('探测不到入口时 auto 回退进程内装配（不是报错）', () => {
    const missing = join(tmpdir(), 'agentsws-no-such-child-entry.js')
    expect(subprocessAvailable(missing)).toBe(false)
    expect(resolveMode({ ...baseOptions(), childEntry: missing })).toBe('in-process')
    const runtime = createDshRuntime({ ...baseOptions(), childEntry: missing })
    expect(runtime.name).toBe('dsh')
  })

  it('两档的 capabilities() 是同一份实测值', () => {
    const inProcess = createDshRuntime({ ...baseOptions(), mode: 'in-process' })
    const subprocess = createDshRuntime({ ...baseOptions(), mode: 'subprocess' })
    expect(subprocess.capabilities()).toEqual(inProcess.capabilities())
    expect(subprocess.name).toBe(inProcess.name)
  })

  it('入口默认指向编译产物 child.js', () => {
    expect(defaultChildEntry().endsWith('child.js')).toBe(true)
  })
})

describe('子进程隔离（16 §3 / 31 §3）', () => {
  it('没有 run token 就拒绝启动（子进程自己把门）', async () => {
    const proc = spawn(process.execPath, [defaultChildEntry()], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let err = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (c: string) => {
      err += c
    })
    const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve))
    expect(code).toBe(2)
    expect(err).toContain(ENV_RUN_TOKEN)
  })

  it('宿主的密钥不进子进程：环境变量走白名单', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-env-'))
    const entry = join(dir, 'env.js')
    // 探子：把自己看得见的环境变量名报到 stderr 再退出（宿主会把 stderr 尾巴放进 run.failed）
    writeFileSync(
      entry,
      'process.stderr.write(JSON.stringify(Object.keys(process.env))); process.exit(3)\n',
      'utf8',
    )
    process.env.AGENTSWS_SECRET_PROBE = 'super-secret'
    process.env.DEEPSEEK_API_KEY = 'sk-should-not-leak'
    try {
      const runtime = createSubprocessDshRuntime({
        ...baseOptions(),
        mode: 'subprocess',
        childEntry: entry,
      })
      const { sink, events } = collect()
      await runtime.run(makeRequest(), sink, NO_ABORT())
      const failure = events.find((e) => e.type === 'run.failed')
      const seen = failure?.type === 'run.failed' ? failure.error.message : ''
      expect(seen).toContain(ENV_RUN_TOKEN)
      expect(seen).not.toContain('AGENTSWS_SECRET_PROBE')
      expect(seen).not.toContain('DEEPSEEK_API_KEY')
    } finally {
      delete process.env.AGENTSWS_SECRET_PROBE
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  it('子进程崩溃 → run.failed{retryable}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-crash-'))
    const entry = join(dir, 'crash.js')
    writeFileSync(entry, 'process.stderr.write("boom\\n"); process.exit(7)\n', 'utf8')
    const runtime = createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: entry,
    })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(result.status).toBe('failed')
    const failure = events.find((e) => e.type === 'run.failed')
    expect(failure?.type === 'run.failed' && failure.error.retryable).toBe(true)
    expect(failure?.type === 'run.failed' && failure.error.message).toContain('boom')
  })

  it('子进程不答话 → 超时按中断处理（run.cancelled）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-hang-'))
    const entry = join(dir, 'hang.js')
    // 只答 hello，不答 run：宿主该超时
    writeFileSync(
      entry,
      [
        "let buf = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (c) => {",
        '  buf += c',
        "  let i = buf.indexOf('\\n')",
        '  while (i >= 0) {',
        '    const line = buf.slice(0, i)',
        '    buf = buf.slice(i + 1)',
        '    const msg = JSON.parse(line)',
        "    if (msg.method === 'agentsws/hello') {",
        '      process.stdout.write(',
        `        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocol: ${BRIDGE_PROTOCOL_VERSION}, runtime: 'dsh', capabilities: {} } }) + '\\n',`,
        '      )',
        '    }',
        "    i = buf.indexOf('\\n')",
        '  }',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )
    const runtime = createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: entry,
      subprocessTimeoutMs: 1_000,
    })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(result.status).toBe('cancelled')
    expect(events.map((e) => e.type)).toContain('run.cancelled')
  })

  it('health 报告子进程能不能起来', async () => {
    const ok = await createSubprocessDshRuntime({
      ...baseOptions(),
      clock: new FixedClock(),
      mode: 'subprocess',
    }).health()
    expect(ok.ok).toBe(true)
    expect(ok.detail).toContain('stdio JSON-RPC')

    const bad = await createSubprocessDshRuntime({
      ...baseOptions(),
      mode: 'subprocess',
      childEntry: join(tmpdir(), 'agentsws-no-such-entry.js'),
    }).health()
    expect(bad.ok).toBe(false)
  })
})
