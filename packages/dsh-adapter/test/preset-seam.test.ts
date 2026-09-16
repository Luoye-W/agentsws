/**
 * WP86（55 §4 第三层）：职责 preset 承载连接。
 *
 * 五组，对应交付单的五件事：
 *
 * (a) **生成是幂等的**：同一条 RunRequest 两次生成逐字节相同、**不动 mtime**；
 *     连接变了才变。这一条不是"省 IO"——上游把"代"钉在组合文件的 mtime + size 上，
 *     而被顶掉的那一代**永远不回收**，每次重写 = 每次多一棵永不释放的子树。
 * (b) **凭据只有名字**：生成的文件里逐字节查不到任何值。
 * (c) **按职责隔离**：另一条职责的 Agent 看不见这台服务器的 `serverName`。
 * (d) **`read_tools` 判定**：勾了的按读、没勾的按写；公司端写的那个一调就拒。
 * (e) **`restrict` 的顺序是硬的**：先 mount 后 restrict，且 preset 的工具必须列名。
 *
 * 对手方是 `test/fixtures/fake-mcp-server.mjs`——一个**零依赖**的 stdio MCP 服务器
 * （报 `look` 与 `touch` 两个工具）。
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunConnection } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { CompositeCredentials, envRefSource } from '@agentsws/credentials-openconnector'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { DshHarness } from '../src/index.js'
import {
  classifySideEffect,
  createHarness,
  mcpReadToolMap,
  presetCredentialRefs,
  presetIdOf,
  presetToolNames,
  writePreset,
} from '../src/index.js'
import { brainGateway, FixedClock, makeRequest, recorder } from './helpers.js'

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-mcp-server.mjs')

/** 一条指向假服务器的连接。`read_tools` 只勾 `look`。 */
function connection(overrides: Partial<RunConnection> = {}): RunConnection {
  return {
    kind: 'mcp:my-tools',
    server_name: 'ws_test_my-tools',
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE],
    read_tools: ['look'],
    tools: ['look', 'touch'],
    ...overrides,
  }
}

const roots: string[] = []
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-preset-'))
  roots.push(dir)
  return dir
}

const open: DshHarness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose()
})

async function harnessFor(
  req: ReturnType<typeof makeRequest>,
  root: string,
  credentials?: unknown,
): Promise<DshHarness> {
  const paths = writePreset(req, root)
  const rec = recorder()
  const h = await createHarness({
    request: req,
    sink: () => undefined,
    provenance: new Provenance(req.id),
    options: {
      clock: new FixedClock(),
      gateway: brainGateway(),
      stage: rec.stage,
      createDraft: rec.createDraft,
      executeTool: async () => ({ status: 'ok', data: null }),
      ...(credentials === undefined ? {} : { credentials }),
    },
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
    preset: { root: paths.root, id: paths.id },
  })
  open.push(h)
  return h
}

// ── (a) 幂等 ────────────────────────────────────────────────────────────────
describe('(a) preset 生成是幂等的', () => {
  it('同一条职责两次生成：内容逐字节相同，且第二次一个字节都没写（mtime 没动）', () => {
    const root = newRoot()
    const req = makeRequest({ connections: [connection()] })
    const first = writePreset(req, root)
    expect(first.written).toBe(true)
    const text = readFileSync(first.composition, 'utf8')
    const mtime = statSync(first.composition).mtimeMs

    const second = writePreset(req, root)
    expect(second.dir).toBe(first.dir)
    expect(second.written).toBe(false)
    expect(readFileSync(second.composition, 'utf8')).toBe(text)
    // 上游把"代"钉在 mtime + size 上：没动 = 不会起新一代（也就不会漏一棵子树）
    expect(statSync(second.composition).mtimeMs).toBe(mtime)
  })

  it('连接变了才变：加一台服务器 → 内容变、这次真的写了', () => {
    const root = newRoot()
    const req = makeRequest({ connections: [connection()] })
    const before = readFileSync(writePreset(req, root).composition, 'utf8')
    const more = makeRequest({
      connections: [connection(), connection({ server_name: 'ws_test_other', kind: 'mcp:other' })],
    })
    const after = writePreset(more, root)
    expect(after.written).toBe(true)
    expect(readFileSync(after.composition, 'utf8')).not.toBe(before)
  })

  it('一条连接都没有：组合是空列表（照样是"一列具名插件行"，preset 不 broken）', () => {
    const root = newRoot()
    const paths = writePreset(makeRequest(), root)
    expect(parse(readFileSync(paths.composition, 'utf8'))).toEqual([])
  })

  it('目录名是过得了上游 preset id 规矩的那一个（职责 id 带点，目录名不能带）', () => {
    expect(presetIdOf('dtc.support')).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    // 换过字符的挂哈希：`a.b` 与 `a_b` 不会共用一个 preset（那等于把 A 的连接挂给 B）
    expect(presetIdOf('a.b')).not.toBe(presetIdOf('a_b'))
    // 本来就合规的不动，目录名仍然是人看得懂的那一个
    expect(presetIdOf('support')).toBe('support')
  })
})

// ── (b) 凭据只有名字 ────────────────────────────────────────────────────────
describe('(b) 凭据只有名字（13 §4）', () => {
  it('请求头与环境变量的值一个字节都不在生成的文件里，只有引用名', () => {
    const root = newRoot()
    const req = makeRequest({
      connections: [
        connection({
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          command: undefined,
          args: undefined,
          header_refs: { Authorization: 'AGENTSWS_MCP_MY_TOOLS_AUTHORIZATION' },
        }),
      ],
    })
    const paths = writePreset(req, root)
    const text = readFileSync(paths.composition, 'utf8')
    expect(text).toContain('AGENTSWS_MCP_MY_TOOLS_AUTHORIZATION')
    // 引用的形状是官方那种（`!!js`），并且带 `?? ''` —— 没配凭据时整份 preset 还挂得上
    expect(text).toContain("!!js process.env.AGENTSWS_MCP_MY_TOOLS_AUTHORIZATION ?? ''")
    expect(text).not.toContain('Bearer')
    expect(presetCredentialRefs(req)).toEqual(['AGENTSWS_MCP_MY_TOOLS_AUTHORIZATION'])
  })

  it('没有凭据的连接：文件里连 headers / env 这两个键都不出现', () => {
    const root = newRoot()
    const text = readFileSync(
      writePreset(makeRequest({ connections: [connection()] }), newRoot()).composition,
      'utf8',
    )
    expect(text).not.toContain('headers')
    expect(text).not.toContain('env:')
    expect(root).toBeTypeOf('string')
  })
})

// ── (c) 按职责隔离 ──────────────────────────────────────────────────────────
describe('(c) mcp-client 行只对这条职责可见', () => {
  it('两条职责各挂各的：另一条的 Agent 看不到这个 serverName', async () => {
    const root = newRoot()
    const mine = makeRequest({ connections: [connection()] })
    const theirs = makeRequest({
      id: 'run_0002',
      role_id: 'dtc.content',
      connections: [
        connection({ kind: 'mcp:other', server_name: 'ws_test_other', read_tools: ['look'] }),
      ],
    })
    const a = await harnessFor(mine, root)
    const b = await harnessFor(theirs, root)

    const names = (h: DshHarness): string[] =>
      h.ctx.tools.schemas(h.agent as never).map((s) => s.name)
    expect(names(a)).toContain('mcp__ws_test_my-tools__look')
    expect(names(a)).not.toContain('mcp__ws_test_other__look')
    expect(names(b)).toContain('mcp__ws_test_other__look')
    expect(names(b)).not.toContain('mcp__ws_test_my-tools__look')
  })

  it('一台都没挂的运行里，工具面上一个 mcp__* 都不存在', async () => {
    const req = makeRequest()
    const h = await harnessFor(req, newRoot())
    const names = h.ctx.tools.schemas(h.agent as never).map((s) => s.name)
    expect(names.filter((n) => n.startsWith('mcp__'))).toEqual([])
  })
})

// ── (d) read_tools 判定 ─────────────────────────────────────────────────────
describe('(d) read_tools：勾了的按读，没勾的按写', () => {
  const req = makeRequest({ connections: [connection()] })
  const map = mcpReadToolMap(req)

  it('勾进只读清单的按 read_external', () => {
    expect(classifySideEffect('mcp__ws_test_my-tools__look', undefined, {}, map)).toBe(
      'read_external',
    )
  })

  it('没勾的按 write_external —— 名字长得再像"只读"也一样', () => {
    expect(classifySideEffect('mcp__ws_test_my-tools__touch', undefined, {}, map)).toBe(
      'write_external',
    )
    // `get_` 前缀的兜底规则**不适用于** MCP 工具：一台服务器叫 get_x 的工具照样能下单
    expect(classifySideEffect('mcp__ws_test_my-tools__get_everything', undefined, {}, map)).toBe(
      'write_external',
    )
  })

  it('这次运行没挂的服务器：整台按写（最严兜底）', () => {
    expect(classifySideEffect('mcp__somewhere_else__look', undefined, {}, map)).toBe(
      'write_external',
    )
  })

  it('公司端（executor）一调没勾的那个就被门禁拒，读的那个放行', async () => {
    const run = makeRequest({ connections: [connection()] })
    const h = await harnessFor(run, newRoot())
    const write = await h.gate.execute('c1', 'mcp__ws_test_my-tools__touch', { q: 'x' })
    expect(write.isError).toBe(true)
    expect(h.gate.records.get('c1')?.status).toBe('blocked')
    expect(h.gate.records.get('c1')?.reason).toContain('write_external_requires_executor')

    const read = await h.gate.execute('c2', 'mcp__ws_test_my-tools__look', { q: 'x' })
    expect(read.isError).toBe(false)
  })
})

// ── (e) restrict 的顺序与列名 ───────────────────────────────────────────────
describe('(e) preset 的工具受 tools.restrict 管（与浏览器相反）', () => {
  /*
   * 这一组钉的是**上游那条与浏览器相反的语义**（55 §4 落点里记的那一条）：
   *
   * - 浏览器 provider 在 `agent/created` 里注册，是 scoped registration，
   *   `tools.restrict` 遮不住它，列进白名单还会抛（AGENT-LAYER §9.4）。
   * - preset 是在 `setup` 里 `mount()` 的，它注册的工具**受**白名单管。
   *
   * 所以白名单的来源就是「这台服务器探测出来的工具清单」（`RunConnection.tools`）：
   * 清单里没有的那个，即使服务器真的报了，也到不了模型面前。
   */
  it('探测清单里没有的那个到不了模型面前（白名单来源就是那张清单）', async () => {
    const run = makeRequest({
      // 服务器真的报 look 与 touch，但这次运行的清单里只有 look
      connections: [connection({ tools: ['look'] })],
    })
    const h = await harnessFor(run, newRoot())
    const names = h.ctx.tools.schemas(h.agent as never).map((s) => s.name)
    expect(names).toContain('mcp__ws_test_my-tools__look')
    expect(names).not.toContain('mcp__ws_test_my-tools__touch')
  })

  it('清单齐全时两个都在（职责的 tools.allow 里并没有它们——连接本身就是那张名单）', async () => {
    const run = makeRequest({ connections: [connection()] })
    expect(run.tools.allow).not.toContain('mcp__ws_test_my-tools__look')
    const h = await harnessFor(run, newRoot())
    const names = h.ctx.tools.schemas(h.agent as never).map((s) => s.name)
    expect(names).toContain('mcp__ws_test_my-tools__look')
    expect(names).toContain('mcp__ws_test_my-tools__touch')
  })

  it('presetToolNames 算出来的就是上游的命名规则（serverName 由我们定，不是它自报的）', () => {
    expect(presetToolNames(makeRequest({ connections: [connection()] }))).toEqual([
      'mcp__ws_test_my-tools__look',
      'mcp__ws_test_my-tools__touch',
    ])
  })
})

// ── (f) 凭据真的送到了子进程，但一个字都不进事件 ────────────────────────────
describe('(f) 凭据经 ctx.credentials 解析（13 §4）', () => {
  it('引用解析出来的值到得了 MCP 子进程，但不落文件、不落事件、挂完就从 process.env 消失', async () => {
    const REF = 'FAKE_MCP_TOKEN'
    const SECRET = 'tok_super_secret_value'
    expect(process.env[REF]).toBeUndefined()
    const events: string[] = []
    const run = makeRequest({
      connections: [connection({ env_refs: { FAKE_MCP_TOKEN: REF } })],
    })
    const root = newRoot()
    const paths = writePreset(run, root)
    // 文件里只有名字
    expect(readFileSync(paths.composition, 'utf8')).not.toContain(SECRET)

    const credentials = {
      name: 'agentsws-test-credentials',
      apply(ctx: { plugin: (p: unknown, c: unknown) => unknown }) {
        ctx.plugin(CompositeCredentials, { refs: envRefSource({ [REF]: SECRET }) })
      },
    }
    const h = await harnessFor(run, root, credentials)
    h.ctx.on('session/event', (_s: unknown, e: { type: string }) => events.push(e.type))

    // 假服务器把 `FAKE_MCP_TOKEN` 原样回显——回显里有它，就证明值真的送到了子进程
    const result = await h.gate.execute('c1', 'mcp__ws_test_my-tools__look', { q: 'x' })
    expect(JSON.stringify(result)).toContain(SECRET)

    // 挂完就还原：进程环境里没有留下这个名字
    expect(process.env[REF]).toBeUndefined()
  })

  it('没有 credentials provider 时：引用解析不出来，preset 照样挂得上（值是空串）', async () => {
    const run = makeRequest({
      connections: [connection({ env_refs: { FAKE_MCP_TOKEN: 'AGENTSWS_NO_SUCH_REF' } })],
    })
    const h = await harnessFor(run, newRoot())
    const names = h.ctx.tools.schemas(h.agent as never).map((s) => s.name)
    expect(names).toContain('mcp__ws_test_my-tools__look')
  })
})
