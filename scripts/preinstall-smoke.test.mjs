/**
 * WP290：装包前冒烟脚本自己的用例。
 *
 * 纯函数（剧本、参数、找产物、出表）直接打；端到端那两条用**当前构建**真跑一轮「网站运营」：
 * 原样跑是绿的；把店铺工具 `shop_add_product_images` 的参数表故意改坏（10-09 同一处），冒烟必须红，
 * 而且红在「工具过 dsh」那一格、带着 dsh 的原始报错。没 `npx tsc -b` 过（没有 dist）就跳过端到端两条。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadServer,
  parseArgs,
  renderTable,
  resolveServer,
  runSmoke,
  runVerdict,
} from './preinstall-smoke.mjs'
import { MARK_CARD, MARK_FAIL, SMOKE_ANSWER, scriptedReply } from './preinstall-smoke-model.mjs'

const REPO = resolve(import.meta.dirname, '..')
const SERVER_ENTRY = join(REPO, 'apps', 'server', 'dist', 'index.js')
const STAND_INS = join(REPO, 'packages', 'stand-ins', 'dist', 'index.js')
const built = existsSync(SERVER_ENTRY) && existsSync(STAND_INS)

describe('假模型剧本', () => {
  const tools = [{ type: 'function', function: { name: 'draft_reply' } }]
  it('出卡记号：第一轮调 draft_reply，看到工具结果后收尾', () => {
    const first = scriptedReply({
      tools,
      messages: [{ role: 'user', content: `${MARK_CARD} 起草` }],
    })
    expect(first.status).toBe(200)
    expect(first.message.tool_calls[0].function.name).toBe('draft_reply')
    const second = scriptedReply({
      tools,
      messages: [
        { role: 'user', content: `${MARK_CARD} 起草` },
        { role: 'tool', content: '{}' },
      ],
    })
    expect(second.message.tool_calls).toBeUndefined()
  })
  it('报错记号回 400；没有记号回一句话', () => {
    expect(scriptedReply({ messages: [{ role: 'user', content: MARK_FAIL }] }).status).toBe(400)
    const plain = scriptedReply({ tools, messages: [{ role: 'user', content: '店里有什么' }] })
    expect(plain.message.content).toBe(SMOKE_ANSWER)
    expect(plain.tools).toEqual(['draft_reply'])
  })
})

describe('参数与产物', () => {
  it('参数', () => {
    expect(parseArgs(['--app', 'x', '--positions', 'a, b', '--keep'])).toEqual({
      app: 'x',
      positions: ['a', 'b'],
      keep: true,
    })
    expect(() => parseArgs(['--nope'])).toThrow('不认识')
  })
  it('认安装包布局：win-unpacked → resources/app/node_modules/@agentsws/server，捆绑 Node 一起找到', () => {
    const files = new Set([
      join('/w', 'resources', 'app', 'node_modules', '@agentsws', 'server', 'dist', 'index.js'),
      join('/w', 'resources', 'node', 'node.exe'),
    ])
    const got = resolveServer({ app: '/w', exists: (p) => files.has(p), platform: 'win32' })
    expect(got?.entry).toContain(join('resources', 'app', 'node_modules'))
    expect(got?.node).toBe(join('/w', 'resources', 'node', 'node.exe'))
    expect(resolveServer({ app: '/nothing', exists: () => false })).toBeUndefined()
  })
  it('运行结论带原始错误', () => {
    const v = runVerdict([
      { type: 'run.started', payload: { runtime: 'dsh' } },
      { type: 'run.failed', payload: { error: { code: 'internal', message: 'boom' } } },
    ])
    expect(v).toEqual({ ok: false, runtime: 'dsh', error: 'run.failed internal: boom' })
  })
  it('出表：失败列原始错误、等 WP287 不算失败', () => {
    const text = renderTable({
      ok: false,
      ms: 1000,
      world: [{ name: '接模型', ok: true }],
      rows: [
        {
          id: 'web-ops',
          name: '网站运营',
          cells: {
            position: { status: 'pass', text: '4 条职责' },
            tools: { status: 'fail', text: '3/4 条', error: 'dtc.store：run.failed internal: x' },
            ask: { status: 'pending', text: '等 WP287' },
          },
        },
      ],
    })
    expect(text).toContain('✗ 3/4 条')
    expect(text).toContain('dtc.store：run.failed internal: x')
    expect(text).toContain('等 WP287 的 1 格')
    expect(text).toContain('不要装包')
  })
})

describe.skipIf(!built)('端到端（当前构建、真 dsh、本机假模型）', () => {
  let restore = () => {}
  afterEach(() => {
    restore()
    restore = () => {}
  })
  const smoke = async () =>
    runSmoke({
      serverModule: await loadServer(SERVER_ENTRY),
      positions: ['web-ops'],
      // 进程内装 dsh：下面那条要在本进程里改坏参数表（子进程档读的是磁盘上的那份）
      dshMode: 'in-process',
    })

  it('网站运营原样跑：每一格过（或等 WP287），店铺工具真摆进了运行', async () => {
    const result = await smoke()
    expect(result.world.every((w) => w.ok)).toBe(true)
    const [row] = result.rows
    expect(row.cells.tools.status).toBe('pass')
    expect(row.tools['dtc.store']).toContain('shop_add_product_images')
    expect(result.ok).toBe(true)
  }, 180_000)

  it('把 shop_add_product_images 的参数表改坏：冒烟红在「工具过 dsh」，带 dsh 的原始报错', async () => {
    const standIns = await import(pathToFileURL(STAND_INS).href)
    const def = standIns.SHOP_TOOL_DEF_BY_NAME.get('shop_add_product_images')
    const items = def.input_schema.properties.images.items
    const before = items.type
    // 改坏：dsh 的参数表 DSL 不认联合类型（与 10-09 那次一样，是「dsh 编译不过」这一类）
    items.type = ['object', 'null']
    restore = () => {
      items.type = before
    }
    const result = await smoke()
    expect(result.ok).toBe(false)
    const [row] = result.rows
    expect(row.cells.tools.status).toBe('fail')
    expect(row.cells.tools.error).toContain('dtc.store')
    expect(row.cells.tools.error).toContain('parameters.images.items')
    expect(renderTable(result)).toContain('不要装包')
  }, 180_000)
})
