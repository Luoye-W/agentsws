/**
 * WP147（Luoye 09-24「截图改成给 AI 看」）：电脑操控与浏览器的截图都送进模型。
 *
 * | 层 | 用什么 | 测什么 |
 * |---|---|---|
 * | 电脑操控 | **真**官方提供方 + 假驱动（`get_window_state` 回一张真 PNG） | 替身模型收到的请求里确有图片；附件库在这次运行的临时目录、运行完删掉 |
 * | 浏览器（Playwright） | 官方 `mountSessionMcp` + 假 Playwright MCP（只把 `@playwright/mcp` 那个进程换掉） | `browser_take_screenshot` 的图同样进模型 |
 * | 没声明看图 | 同上，`imageInput` 不给 | 不放图，工具结果里是官方诊断 |
 * | 预算 | `imageBudget` 调小 | 超了 → 官方 `image/offload` 把最旧的换占位、重试这一步 |
 * | 日志 / 数据目录 | `createDshRuntime` 带 `sessionLogRoot` / `presetRoot` | 事件与数据目录里没有图片字节 |
 *
 * **CI 里不启动真驱动、不开浏览器、不截真屏**：两个假服务器只回固定内容。
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChatMessage, Completion, RunComputerUse } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { visionProbeBase64 } from '@agentsws/model-gateway'
import { describe, expect, it, vi } from 'vitest'
import {
  CUA_TOOL_PREFIX,
  createDshRuntime,
  createHarness,
  type DshRuntimeOptions,
  type ModelGatewayLike,
  REQUEST_IMAGE_BUDGET,
  subprocessAvailable,
} from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

/*
 * 浏览器那条腿：官方 Playwright 提供方是「`mountSessionMcp` + 起 `@playwright/mcp` 的 cli.js」
 * 这么一层薄壳（上游 `lib/index.js` 全文不到 30 行）。测试只把**那个进程**换成假 MCP 服务器，
 * 其余（官方浏览器 seam、官方 MCP 桥、图片准入、我们的门禁 / 附件库 / 适配器）全是真的。
 */
vi.mock('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', async () => {
  const runtime = await import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const gw = await import('@agentsws/model-gateway')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsws-fake-pw-'))
  const server = path.join(dir, 'playwright-mcp.cjs')
  fs.writeFileSync(
    server,
    fakeMcpServer(['browser_snapshot', 'browser_take_screenshot'], gw.visionProbeBase64()),
    'utf8',
  )
  return {
    name: 'experimental-browser-use-playwright-mcp',
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
    Config: runtime.BrowserMcpConfig,
    apply(ctx: never) {
      runtime.mountSessionMcp(ctx, {
        name: 'playwright-mcp',
        exclusive: false,
        command: process.execPath,
        args: [server],
      } as never)
    },
  }
})

/**
 * 一个讲 MCP stdio（一行一条 JSON-RPC）的最小服务器。名字以 `screenshot` / `window_state`
 * 结尾的工具回「一段文字 + 一张图」，别的只回文字。
 */
function fakeMcpServer(tools: string[], png: string): string {
  return `
const tools = ${JSON.stringify(tools)}.map((name) => ({ name, description: 'fake ' + name, inputSchema: { type: 'object', properties: {} } }))
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === '') continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.0' } })
    else if (msg.method === 'tools/list') reply({ tools })
    else if (msg.method === 'ping') reply({})
    else if (msg.method === 'tools/call') {
      const name = msg.params.name
      if (/(screenshot|window_state)$/.test(name)) reply({ content: [{ type: 'text', text: 'tree_markdown: AXWindow "Notes"' }, { type: 'image', data: ${JSON.stringify(png)}, mimeType: 'image/png' }] })
      else reply({ content: [{ type: 'text', text: 'ok ' + name }] })
    } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no ' + msg.method } }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`
}

const PNG = visionProbeBase64()
const DIR = mkdtempSync(join(tmpdir(), 'agentsws-wp147-test-'))
const DRIVER = join(DIR, 'cua-driver')
writeFileSync(
  DRIVER,
  `#!${process.execPath}\n${fakeMcpServer(['list_apps', 'get_window_state', 'click'], PNG)}`,
  'utf8',
)
chmodSync(DRIVER, 0o755)

// 子进程档的门禁用子进程自己的墙钟（`wallClockMs` 是函数、过不了进程边界），
// 所以授权窗口必须跟真实时间走——写死日期会在第二天变成"授权已过期"（WP149 撞上）。
const T0 = Date.now()
const GRANTED: RunComputerUse = {
  command: DRIVER,
  args: ['mcp'],
  minutes: 10,
  granted_until: new Date(T0 + 10 * 60_000).toISOString(),
  grant_id: 'apv_cu_1',
}
const SHOT = `${CUA_TOOL_PREFIX}get_window_state`
const PW_SHOT = 'mcp__playwright-mcp__browser_take_screenshot'

/** 按脚本出工具调用的替身模型；每一次收到的消息都记下来。 */
function scripted(calls: string[]): ModelGatewayLike & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    seen,
    async complete(req) {
      seen.push(req.messages)
      const name = calls[seen.length - 1]
      return name === undefined
        ? done('看过了。')
        : done('', [{ id: `call_${seen.length}`, name, input: {} }])
    },
  }
}

type Part = Extract<ChatMessage['content'], unknown[]>[number]
const partsOf = (m: ChatMessage): Part[] => (typeof m.content === 'string' ? [] : m.content)
const imagesIn = (messages: ChatMessage[]): Part[] =>
  messages.flatMap((m) => partsOf(m).filter((p) => p.type === 'image'))
const toolText = (messages: ChatMessage[]): string =>
  messages
    .filter((m) => m.role === 'tool')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
    )
    .join('\n')

const meta = (req: ReturnType<typeof makeRequest>) => ({
  workspace_id: req.workspace_id,
  assignment_id: req.actor.assignment_id,
  role_id: req.actor.role_id,
  run_id: req.id,
  purpose: 'run' as const,
})

async function harnessOf(
  req: ReturnType<typeof makeRequest>,
  gateway: ModelGatewayLike,
  extra: { imageInput?: boolean; imageBudget?: typeof REQUEST_IMAGE_BUDGET } = {},
) {
  const { sink, events } = collect()
  const harness = await createHarness({
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions({ wallClockMs: () => T0, gateway }),
    buildStageIntent: () => undefined,
    buildDraftPayload: () => undefined,
    model: 'stub-v1',
    meta: meta(req),
    ...extra,
  })
  return { harness, events }
}

/** 这次运行的附件库根（官方 `LocalAttachmentStore.root` = `<dshHome>/attachments/v1`）。 */
const imageHomeOf = (ctx: { get(name: string): unknown }): string | undefined => {
  const store = ctx.get('attachments') as { root?: string } | undefined
  return store?.root === undefined ? undefined : dirname(dirname(store.root))
}

describe('(a) 电脑操控：截图进模型', () => {
  it('路由声明能看图 → 下一轮请求的工具结果里有图片部件；附件库在临时目录、运行完删掉', async () => {
    const gateway = scripted([SHOT])
    const { harness, events } = await harnessOf(makeRequest({ computer_use: GRANTED }), gateway, {
      imageInput: true,
    })
    const home = imageHomeOf(harness.ctx)
    try {
      await harness.runTurn('Look at the Notes window.')
      expect(gateway.seen).toHaveLength(2)
      const second = gateway.seen[1] ?? []
      const images = imagesIn(second)
      expect(images).toHaveLength(1)
      const image = images[0] as { type: 'image'; mime: string; data: string }
      expect(image.mime).toMatch(/^image\/(png|jpeg|webp)$/u)
      expect(Buffer.from(image.data, 'base64').length).toBeGreaterThan(50)
      const tool = second.find((m) => m.role === 'tool')
      expect(tool?.name).toBe(SHOT)
      // 文字照样在（无障碍树优先），图前面是官方的句柄文字（附件 id + 送出去的尺寸）
      expect(toolText(second)).toContain('tree_markdown')
      expect(toolText(second)).toMatch(/Image .*request preview \d+x\d+px/u)
      // 事件里没有图片字节
      const log = JSON.stringify(events)
      expect(log).not.toContain(image.data.slice(0, 64))
      expect(log).not.toContain(PNG.slice(0, 64))
      expect(home).toBeDefined()
      expect(home?.startsWith(tmpdir())).toBe(true)
      expect(existsSync(home ?? '')).toBe(true)
    } finally {
      await harness.dispose()
    }
    expect(existsSync(home ?? '')).toBe(false)
  })

  it('路由没声明看图 → 不放图；工具结果的位置是官方 MCP 桥的诊断', async () => {
    const gateway = scripted([SHOT])
    const { harness } = await harnessOf(makeRequest({ computer_use: GRANTED }), gateway)
    try {
      await harness.runTurn('Look at the Notes window.')
      const second = gateway.seen[1] ?? []
      expect(imagesIn(second)).toHaveLength(0)
      expect(toolText(second)).toContain('tree_markdown')
      expect(toolText(second)).toContain('does not declare image input')
      expect(JSON.stringify(second)).not.toContain(PNG.slice(0, 64))
    } finally {
      await harness.dispose()
    }
  })

  it('没有浏览器也没有电脑操控的运行：附件库不挂（行为一字不变）', async () => {
    const { harness } = await harnessOf(makeRequest(), scripted([]), { imageInput: true })
    try {
      expect(harness.ctx.get('attachments')).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })
})

describe('(b) 浏览器（官方 Playwright 那条路）：截图同样进模型', () => {
  it('browser_take_screenshot 的图进了下一轮请求；门禁读写分类不变（读）', async () => {
    const gateway = scripted([PW_SHOT])
    const req = makeRequest({
      browser: { mode: 'attach', endpoint: 'http://127.0.0.1:9' },
      allowed_hosts: ['example.com'],
    })
    const { harness, events } = await harnessOf(req, gateway, { imageInput: true })
    const home = imageHomeOf(harness.ctx)
    try {
      await harness.runTurn('Take a screenshot of the page.')
      const second = gateway.seen[1] ?? []
      expect(imagesIn(second)).toHaveLength(1)
      expect(second.find((m) => m.role === 'tool')?.name).toBe(PW_SHOT)
      expect(harness.gate.records.get('call_1')?.status).toBe('ok')
      expect(JSON.stringify(events)).not.toContain(PNG.slice(0, 64))
    } finally {
      await harness.dispose()
    }
    expect(existsSync(home ?? '')).toBe(false)
  })
})

describe('(c) 预算：一次请求的图超了，最旧的换官方占位', () => {
  it('上限 2 张时第 3 张来了 → 官方 image/offload 记一笔、重试这一步；请求里始终不超过 2 张', async () => {
    const gateway = scripted([SHOT, SHOT, SHOT])
    const { harness } = await harnessOf(makeRequest({ computer_use: GRANTED }), gateway, {
      imageInput: true,
      imageBudget: { representation: 'base64', maxImages: 2, countQuantum: 1 },
    })
    try {
      await harness.runTurn('Keep looking.')
      // 4 次真的到了模型（重试那一次之前的报错不算一次模型请求）
      expect(gateway.seen).toHaveLength(4)
      for (const messages of gateway.seen) expect(imagesIn(messages).length).toBeLessThanOrEqual(2)
      const last = gateway.seen[3] ?? []
      expect(imagesIn(last)).toHaveLength(2)
      expect(toolText(last)).toContain('image omitted to fit request image limits')
    } finally {
      await harness.dispose()
    }
  })

  it('默认预算写在明处：一次请求最多 8 张，超了最旧的 4 张一起换占位', () => {
    expect(REQUEST_IMAGE_BUDGET).toMatchObject({ maxImages: 8, countQuantum: 4 })
  })
})

describe('(d) 整次运行：事件日志与数据目录里没有图片字节', () => {
  const modes: ('in-process' | 'subprocess')[] = subprocessAvailable()
    ? ['in-process', 'subprocess']
    : ['in-process']
  it.each(modes)(
    'createDshRuntime（%s）跑一次带截图的电脑操控；会话日志 / preset 目录逐个文件查',
    async (mode) => {
      const data = mkdtempSync(join(tmpdir(), 'agentsws-wp147-data-'))
      const gateway = scripted([SHOT])
      const options: DshRuntimeOptions = baseOptions({
        gateway,
        mode,
        wallClockMs: () => T0,
        sessionLogRoot: join(data, 'sessions'),
        presetRoot: join(data, 'presets'),
        imageInput: (model) => model.model === 'stub-v1',
      })
      const runtime = createDshRuntime(options)
      const { sink, events } = collect()
      await runtime.run(makeRequest({ computer_use: GRANTED }), sink, new AbortController().signal)
      const sent = imagesIn(gateway.seen[1] ?? [])[0] as { data: string } | undefined
      expect(sent).toBeDefined()
      const needles = [PNG.slice(0, 64), (sent?.data ?? '').slice(0, 64)]
      const log = JSON.stringify(events)
      for (const n of needles) expect(log).not.toContain(n)
      const files: string[] = []
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else files.push(p)
        }
      }
      walk(data)
      expect(files.length).toBeGreaterThan(0)
      for (const f of files) {
        const body = readFileSync(f)
        expect(body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
        for (const n of needles) expect(body.toString('utf8')).not.toContain(n)
      }
    },
  )
})
