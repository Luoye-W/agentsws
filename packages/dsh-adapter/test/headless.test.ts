/**
 * headless 子进程档的边角（WP30 A）：模式探测、隔离、崩溃、超时、token。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { provenanceOf } from '../src/headless/subprocess.js'
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

  /**
   * WP87：超时之前子进程已经干完的事不能扔。
   *
   * 出处：realistic 档（真模型，dsh-subprocess）里 `amazon/buyer-message-guardrail`
   * 与 `ops/model-outage` 两条的 provenance_respected 红了——子进程超时前明明
   * `get_order` 读过那张单、`stage_refund` 才通过的门禁，宿主却回了一份空 provenance，
   * 于是证据里变成"凭空提的退款"。
   */
  it('超时前子进程已经回来的工具结果，仍然进这次运行的 provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-hang-prov-'))
    const entry = join(dir, 'hang-prov.js')
    // 答 hello；收到 run 就先推一条带 provenance 的 tool.result 事件，然后不答话
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
        "    if (msg.method === 'agentsws/run') {",
        '      process.stdout.write(',
        "        JSON.stringify({ jsonrpc: '2.0', method: 'agentsws/event', params: { token: msg.params.token, event: { type: 'tool.result', call_id: 'c1', tool: 'get_order', status: 'ok', provenance_added: [{ type: 'order', id: 'ord_1001' }] } } }) + '\\n',",
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
    expect(events.some((e) => e.type === 'tool.result')).toBe(true)
    expect(result.provenance.seen.order).toEqual(['ord_1001'])
    expect(result.provenance.read_full).toEqual(['order:ord_1001'])
    expect(result.usage.tool_calls).toBe(0)
  })

  it('provenanceOf：按事件顺序重建，重复出现的挪到末尾', () => {
    const state = provenanceOf(
      'run_1',
      [
        {
          type: 'tool.result',
          call_id: 'c1',
          tool: 'list_orders',
          status: 'ok',
          provenance_added: [
            { type: 'order', id: 'ord_1' },
            { type: 'order', id: 'ord_2' },
          ],
        },
        { type: 'tool.call', call_id: 'c2', tool: 'get_order', input: {} },
        {
          type: 'tool.result',
          call_id: 'c2',
          tool: 'get_order',
          status: 'ok',
          provenance_added: [{ type: 'order', id: 'ord_1' }],
        },
      ],
      '2026-09-07T00:00:00.000Z',
    )
    expect(state.seen.order).toEqual(['ord_2', 'ord_1'])
    expect(state.run_id).toBe('run_1')
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
