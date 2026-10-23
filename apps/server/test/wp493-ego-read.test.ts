/**
 * WP493（决策 1718 / 1708）：ego 只读通道。
 *
 * 不起真 ego、不联网：脚本放进一个**进程内的假 ego 运行时**里真跑一遍（`taskSpace` / `page.*` 都是替身，
 * 记下它被叫了什么），验：只读（没有白名单外的点击、只 GET、跨源不发）、空间收尾（`finish({ keep: [] })`）、
 * 选路（ego 能用 / 不能用 / 没选）、读 Reddit（同一份 `runRedditRead`、翻页回放、被拦就停）、在线表格
 * （Google 导出 CSV、飞书读格子 → 导出 Excel）。
 */
import * as fsp from 'node:fs/promises'
import type { RedditReadJob } from '@agentsws/browser-action'
import type { EgoProcessResult } from '@agentsws/dsh-adapter'
import { zipFiles } from '@agentsws/knowledge'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserSettings } from '../src/browser-settings.js'
import {
  copiedGrid,
  createEgoPageReader,
  createEgoReadiness,
  createEgoRedditPump,
  createEgoSheetReader,
  createPageReadChain,
  EGO_READ_FORBID_CLICK,
  EGO_READ_SAFE_CLICK,
  type EgoFetchRead,
  type EgoReadScriptConfig,
  egoReadScript,
  egoRedditRead,
  onlineSheetCall,
  onlineSheetKindOf,
  parseTsv,
  runEgoRead,
} from '../src/ego-read/index.js'
import type { EgoSpawn } from '../src/ego-write/runner.js'

/* ── 进程内的假 ego 运行时 ─────────────────────────────────────────── */

interface FakeSite {
  /** 打开某个地址后页面长什么样（`read` 那一步读到的）。 */
  pages?: Record<
    string,
    {
      text?: string
      html?: string
      tables?: { source: string; rows: string[][] }[]
      password?: number
    }
  >
  /** 同源 GET 回什么（按完整地址）。 */
  fetches?: Record<string, { status: number; ct: string; body: string }>
  /** 页面上的菜单项（字 / aria）；`download` = 点它会下载。 */
  menu?: { text: string; aria?: string; download?: { name: string; bytes: Uint8Array } }[]
  /** 打开这个地址直接下载。 */
  downloads?: Record<string, { name: string; bytes: Uint8Array }>
  /** `taskSpace` 一开就抛（ego 交给人 / 名字撞了）。 */
  spaceError?: string
  /** 页面上有一块大画布（飞书）；`copy` = 点格子 → 全选 → 复制时页面调 setData 写出的那几份。 */
  canvas?: { copy?: [string, string][] }
}

interface FakeLog {
  keys: string[]
  mouse: string[]
  gotos: string[]
  fetches: { url: string; method: string }[]
  clicks: string[]
  finished: unknown[]
  spaces: string[]
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<void>

/** 一个假 `ego-browser nodejs`：在本进程里跑脚本。 */
function fakeEgo(site: FakeSite): { spawn: EgoSpawn; log: FakeLog; scripts: string[] } {
  const log: FakeLog = {
    keys: [],
    mouse: [],
    gotos: [],
    fetches: [],
    clicks: [],
    finished: [],
    spaces: [],
  }
  const scripts: string[] = []
  const spawn: EgoSpawn = async ({ stdin }) => {
    scripts.push(stdin ?? '')
    const out: string[] = []
    let url = 'about:blank'
    let marked: FakeSite['menu'] extends (infer T)[] | undefined ? T | undefined : never
    let pendingDownload: ((d: unknown) => void) | undefined
    const makeDownload = (dl: { name: string; bytes: Uint8Array }) => ({
      suggestedFilename: () => dl.name,
      saveAs: async (path: string) => {
        await fsp.writeFile(path, dl.bytes)
      },
    })
    let captured: [string, string][] = []
    let cellSelected = false
    let selectedAll = false
    const page = {
      label: 'p1',
      mouse: {
        click: async (x: number, y: number, o: { label?: string }) => {
          log.mouse.push(`${x},${y}|${o?.label ?? ''}`)
          cellSelected = site.canvas !== undefined
        },
      },
      keyboard: {
        press: async (key: string) => {
          log.keys.push(key)
          if (key === 'ControlOrMeta+A') selectedAll = cellSelected
          // 页面的复制处理：选中了就调 setData（被截住，不进系统剪贴板）
          if (key === 'ControlOrMeta+C' && selectedAll) captured = [...(site.canvas?.copy ?? [])]
        },
      },
      async goto(u: string) {
        log.gotos.push(u)
        url = u
        const dl = site.downloads?.[u]
        if (dl !== undefined && pendingDownload !== undefined) {
          pendingDownload(makeDownload(dl))
          throw new Error('net::ERR_ABORTED')
        }
      },
      // 真等一点点（找菜单那一段按真时间轮询 8 秒）
      waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      url: () => url,
      async snapshot() {
        return '- document\n  - grid "sheet"'
      },
      async evaluate(
        fn: (arg: unknown) => unknown,
        arg: { text?: string; attr?: string; either?: boolean },
      ) {
        const src = String(fn)
        if (src.includes('__agentswsCopyOn')) {
          captured = []
          return site.canvas === undefined ? undefined : { x: 10, y: 60, w: 900, h: 500 }
        }
        if (src.includes('__agentswsCopy')) return captured
        if (src.includes('data-agentsws-read')) {
          const textRe = arg.text === undefined ? undefined : new RegExp(arg.text, 'i')
          const attrRe = arg.attr === undefined ? undefined : new RegExp(arg.attr, 'i')
          const hit = (site.menu ?? []).find((m) => {
            const t = textRe === undefined ? true : textRe.test(m.text)
            const a = attrRe === undefined ? true : attrRe.test(m.aria ?? '')
            return arg.either === true
              ? (textRe !== undefined && t) || (attrRe !== undefined && a)
              : t && a
          })
          marked = hit
          return hit === undefined ? undefined : `${hit.text} ${hit.aria ?? ''}`.trim()
        }
        const p = site.pages?.[url] ?? {}
        return {
          final_url: url,
          title: 'fake',
          text: p.text ?? '',
          ...(arg && (arg as { html?: boolean }).html ? { html: p.html ?? '' } : {}),
          password_inputs: p.password ?? 0,
          canvases: 1,
          tables: p.tables ?? [],
        }
      },
      async fetch(u: string, opts: { method?: string }) {
        log.fetches.push({ url: u, method: opts?.method ?? 'GET' })
        const r = site.fetches?.[u]
        if (r === undefined)
          return {
            ok: false,
            status: 404,
            url: u,
            headers: { 'Content-Type': 'text/html' },
            body: 'nope',
          }
        return {
          ok: r.status < 300,
          status: r.status,
          url: u,
          headers: { 'Content-Type': r.ct },
          body: r.body,
        }
      },
      async click(sel: string, opts: { label?: string }) {
        log.clicks.push(`${sel}|${opts?.label ?? ''}|${marked?.text ?? ''}`)
        if (marked?.download !== undefined && pendingDownload !== undefined)
          pendingDownload(makeDownload(marked.download))
      },
      waitForEvent(name: string) {
        expect(name).toBe('download')
        return new Promise((resolve, reject) => {
          pendingDownload = resolve
          setTimeout(() => reject(new Error('Timeout waiting for download')), 50)
        })
      },
    }
    const task = {
      spaceId: 41,
      page: () => page,
      finish: async (o: unknown) => {
        log.finished.push(o)
      },
    }
    const taskSpace = async (name: string) => {
      log.spaces.push(name)
      if (site.spaceError !== undefined) throw new Error(site.spaceError)
      return task
    }
    const con = { log: (...a: unknown[]) => out.push(a.map(String).join(' ')) }
    const t0 = Date.now()
    try {
      // vitest 的沙箱里 `new Function` 不能动态 import：把脚本开头那一句换成直接给的 fs
      const body = (stdin ?? '').replace('await import("node:fs/promises")', '__fs')
      expect(body).not.toContain('await import(')
      await new AsyncFunction('taskSpace', 'console', '__fs', body)(taskSpace, con, fsp)
    } catch (e) {
      return {
        exit_code: 1,
        timed_out: false,
        duration_ms: Date.now() - t0,
        stdout: out.join('\n'),
        stderr: String(e),
      } satisfies EgoProcessResult
    }
    return {
      exit_code: 0,
      timed_out: false,
      duration_ms: Date.now() - t0,
      stdout: out.join('\n'),
      stderr: '',
    } satisfies EgoProcessResult
  }
  return { spawn, log, scripts }
}

const reader = (site: FakeSite, path: string | undefined = '/fake/ego-browser') => {
  const ego = fakeEgo(site)
  return { ...ego, reader: createEgoPageReader({ egoPath: () => path, spawn: ego.spawn }) }
}

/* ── 只读保证 ─────────────────────────────────────────────────────── */

describe('只读：脚本里能做的就那几样', () => {
  const cfg: EgoReadScriptConfig = {
    space: 's',
    url: 'https://example.com/',
    out: '/tmp/x.json',
    steps: [{ op: 'read', id: 'r' }],
  }
  const script = egoReadScript(cfg)
  it('没有填 / 打字 / 按键 / 鼠标 / 选项 / 上传 / 对话框；点击只有 safeClick 那一处', () => {
    for (const bad of [
      /\.fill\(/u,
      /\.type\(/u,
      /insertText|keyboard\.paste|keyboard\.type|keyboard\.down/u,
      /mouse\.(down|up|move|wheel|dblclick)/u,
      /selectOption/u,
      /setInputFiles/u,
      /acceptDialog|dismissDialog/u,
      /dblclick|dragAndDrop|\.hover\(/u,
      /takeOverTaskSpace\(|claimTaskSpace\(/u,
      /\.cdp\(/u,
    ])
      expect(script).not.toMatch(bad)
    // 点击：菜单只在 safeClick；画布只在 copy 那一下；按键只走 pressKey（白名单三个键）
    expect(script.match(/page\.click\(/gu)).toHaveLength(1)
    expect(script.match(/mouse\.click\(/gu)).toHaveLength(1)
    expect(script.match(/keyboard\.press\(/gu)).toHaveLength(1)
    expect(script).toMatch(
      /const pressKey = async \(key\) => \{\s*if \(!CFG\.keys\.includes\(key\)\) throw/u,
    )
    expect(script).toContain('"keys":["ControlOrMeta+A","ControlOrMeta+C","Escape"]')
    // 截住复制时不调原来的 setData（不改用户剪贴板）
    expect(script).not.toMatch(/\.call\(|\.apply\(|originalSetData/u)
    expect(script).toMatch(/const safeClick = async[\s\S]*?await page\.click\(/u)
    // fetch 只发 GET
    expect(script.match(/page\.fetch\(/gu)).toHaveLength(1)
    expect(script).toContain('{ method: "GET", timeout: 30000 }')
    // 收尾：只有一处 finish，而且什么都不留
    expect(script.match(/\.finish\(/gu)).toHaveLength(1)
    expect(script).toContain('task.finish({ keep: [] })')
  })
  it('白名单认导出菜单，黑名单字样一律拒', () => {
    const safe = new RegExp(EGO_READ_SAFE_CLICK, 'i')
    const forbid = new RegExp(EGO_READ_FORBID_CLICK, 'i')
    const ok = (s: string) => safe.test(s) && !forbid.test(s)
    for (const s of [
      '更多',
      'More',
      '下载为',
      'Download as',
      '导出为',
      'Excel',
      'Excel (.xlsx)',
      'Microsoft Excel (.xlsx)',
      'CSV',
      '⋯',
    ])
      expect(ok(s), s).toBe(true)
    for (const s of [
      '发送',
      '发布',
      'Submit',
      'Delete',
      'Share',
      '分享',
      '保存',
      'Save',
      'Post',
      'Reply',
      '确定',
      'Sign in',
      '更多 删除',
      'Excel 分享',
    ])
      expect(ok(s), s).toBe(false)
  })
})

/* ── 一趟：开空间 → 读 → 收空间 ───────────────────────────────────── */

describe('一趟 ego 读页', () => {
  it('读一整页：正文 / 原文 / 表格 / 密码框；空间收掉（keep 为空）', async () => {
    const { reader: r, log } = reader({
      pages: {
        'https://example.com/a': {
          text: 'hello',
          html: '<html><body><pre>{"a":1}</pre></body></html>',
          tables: [
            {
              source: 'table',
              rows: [
                ['a', 'b'],
                ['1', '2'],
              ],
            },
          ],
        },
      },
    })
    const got = await r.page('https://example.com/a', { html: true, snapshot: true })
    expect(got).toMatchObject({
      ok: true,
      page: {
        final_url: 'https://example.com/a',
        text: 'hello',
        tables: [
          {
            rows: [
              ['a', 'b'],
              ['1', '2'],
            ],
          },
        ],
      },
    })
    if (got.ok) expect(got.page.snapshot).toContain('grid')
    expect(log.finished).toEqual([{ keep: [] }])
    expect(log.spaces[0]).toMatch(/^工坊 · 读页 · /u)
    // 与插件那一口同形：data = <pre> 里的原文
    const data = await r.read('https://example.com/a', 'data')
    expect(data).toMatchObject({ ok: true, status: 0, text: '{"a":1}' })
    expect(log.finished).toHaveLength(2)
    expect(log.clicks).toEqual([])
  })
  it('同源才 GET、跨源不发；只 GET', async () => {
    const { reader: r, log } = reader({
      fetches: {
        'https://site.test/x.json': { status: 200, ct: 'application/json', body: '{"ok":1}' },
      },
    })
    const got = await r.fetch('https://site.test/start', ['/x.json', 'https://evil.test/steal'])
    expect(got.ok).toBe(true)
    const responses = (got as Extract<EgoFetchRead, { ok: true }>).responses
    expect(responses[0]).toMatchObject({
      url: 'https://site.test/x.json',
      status: 200,
      body: '{"ok":1}',
    })
    expect(responses[1]).toMatchObject({ url: 'https://evil.test/steal', error: 'cross-origin' })
    expect(log.fetches).toEqual([{ url: 'https://site.test/x.json', method: 'GET' }])
    expect(log.finished).toEqual([{ keep: [] }])
  })
  it('ego 把空间交给人（权限框）：照实回 needs_human，不 finish', async () => {
    const { reader: r, log } = reader({
      spaceError: 'A browser permission prompt appeared. The user now controls this task space.',
    })
    const got = await r.page('https://example.com/')
    expect(got).toMatchObject({ ok: false, state: 'needs_human' })
    expect(log.finished).toEqual([])
  })
  it('没选 ego / 没装：不起进程', async () => {
    const ego = fakeEgo({})
    const spawn = vi.fn(ego.spawn)
    const r = createEgoPageReader({ egoPath: () => undefined, spawn })
    expect(r.available()).toBe(false)
    expect(await r.page('https://example.com/')).toMatchObject({ ok: false, state: 'off' })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('ego 起不来 / 管理员身份：unavailable + 人话', async () => {
    const spawn: EgoSpawn = async () => ({
      exit_code: 1,
      timed_out: false,
      duration_ms: 5,
      stdout: '',
      stderr: 'ego-browser is running as administrator',
    })
    const res = await runEgoRead({
      egoPath: '/x',
      call: { url: 'https://e.test', steps: [] },
      spawn,
    })
    expect(res).toMatchObject({ state: 'unavailable' })
    expect(res.why).toContain('管理员身份')
  })
  it('导出菜单里有黑名单字样：拒点、没下载', async () => {
    const { reader: r, log } = reader({
      menu: [{ text: '更多' }, { text: '下载为' }, { text: 'Excel', aria: '' }],
    })
    // 把菜单字改成「分享」：白名单外
    const res = await r.run({
      url: 'https://e.test/sheet',
      steps: [{ op: 'export', id: 'x', clicks: [{ text: '^更多$' }, { text: '^下载为$' }] }],
    })
    expect(res.state).toBe('ok')
    expect(log.clicks).toHaveLength(2)
    const bad = reader({ menu: [{ text: '分享' }] })
    const res2 = await bad.reader.run({
      url: 'https://e.test/sheet',
      steps: [{ op: 'export', id: 'x', clicks: [{ text: '^分享$' }] }],
    })
    expect(res2.steps[0]).toMatchObject({ ok: false })
    expect(res2.steps[0]?.why).toMatch(/refused-click/u)
    expect(bad.log.clicks).toEqual([])
    expect(bad.log.finished).toEqual([{ keep: [] }])
  })
})

/* ── 选路 ─────────────────────────────────────────────────────────── */

describe('选路：ego → 插件 → 内置浏览器', () => {
  const EGO = () => ({ ok: true as const, path: '/u/.local/bin/ego-browser', version: '2.1.0' })
  const settings = (over: Partial<Parameters<typeof createBrowserSettings>[0]> = {}) =>
    createBrowserSettings({
      runtimeMode: () => 'local',
      probe: async (endpoint) => ({ ok: false, endpoint }),
      detectEgo: EGO,
      ...over,
    })
  it('浏览器设置：选了 ego / 默认 ego 才给读路径；选了插件就没有；公司档没有', () => {
    expect(settings().egoReadPath()).toBe('/u/.local/bin/ego-browser')
    const chosen = settings()
    chosen.set({ mode: 'ego' })
    expect(chosen.egoReadPath()).toBe('/u/.local/bin/ego-browser')
    const plugin = settings({ bskExists: () => true, defaultBskPath: () => '/d/bin/bsk' })
    plugin.set({ mode: 'browserskill' })
    expect(plugin.egoReadPath()).toBeUndefined()
    expect(plugin.bskInstalledPath()).toBe('/d/bin/bsk')
    expect(settings({ detectEgo: () => ({ ok: false }) }).egoReadPath()).toBeUndefined()
    expect(settings({ runtimeMode: () => 'docker' }).egoReadPath()).toBeUndefined()
  })
  const okEgo = {
    available: () => true,
    read: vi.fn(async () => ({ ok: true as const, status: 0, final_url: 'u', text: 'ego' })),
    page: vi.fn(async () => ({
      ok: true as const,
      page: {
        final_url: 'u',
        title: '',
        text: 'ego text',
        password_inputs: 0,
        canvases: 0,
        tables: [],
      },
    })),
  }
  const badEgo = {
    available: () => true,
    read: async () => ({ ok: false as const, message: 'ego 这一页没读成' }),
    page: async () => ({
      ok: false as const,
      state: 'failed' as const,
      message: 'ego 这一页没读成',
    }),
  }
  const plugin = {
    read: vi.fn(async () => ({
      ok: true as const,
      status: 0,
      final_url: 'u',
      text: '<p>plugin</p>',
    })),
  }
  const builtin = vi.fn(async () => ({ ok: true, final_url: 'u', text: 'builtin' }))
  it('ego 能用：先 ego，插件 / 内置不碰', async () => {
    const c = createPageReadChain({ ego: () => okEgo, plugin: () => plugin, builtin })
    expect(c.route()).toEqual(['ego', 'plugin', 'builtin'])
    expect(await c.read('u', 'html')).toMatchObject({ ok: true, via: 'ego' })
    expect(await c.readPage('u', 'page')).toMatchObject({
      ok: true,
      via: 'ego',
      text: 'ego text',
      password_inputs: 0,
    })
    expect(plugin.read).not.toHaveBeenCalled()
    expect(builtin).not.toHaveBeenCalled()
  })
  it('ego 没读成 → 插件；没有插件 → 内置浏览器', async () => {
    const c = createPageReadChain({ ego: () => badEgo, plugin: () => plugin, builtin })
    expect(await c.readPage('u', 'html')).toMatchObject({
      ok: true,
      via: 'plugin',
      html: '<p>plugin</p>',
    })
    const c2 = createPageReadChain({ ego: () => badEgo, plugin: () => undefined, builtin })
    expect(await c2.readPage('u', 'page')).toMatchObject({ ok: true, via: 'builtin' })
  })
  it('没选 ego（ego 不可用）：照旧插件 → 内置', async () => {
    const off = { ...okEgo, available: () => false }
    const c = createPageReadChain({ ego: () => off, plugin: () => undefined, builtin })
    expect(c.route()).toEqual(['builtin'])
    expect(await c.read('u', 'html')).toMatchObject({ ok: true, via: 'builtin', text: 'builtin' })
    expect(okEgo.read).toHaveBeenCalledTimes(1)
  })
  it('都没有：照实说没有浏览器', async () => {
    const c = createPageReadChain({ ego: () => undefined, plugin: () => undefined })
    expect(await c.readPage('u', 'page')).toEqual({ ok: false, message: '没有能用的浏览器' })
  })
  it('ego 连没连得上：一分钟内不再连；跑不起来先当连不上', async () => {
    let now = 0
    const probe = vi.fn(async () => ({ connected: true }))
    const r = createEgoReadiness({ path: () => '/ego', probe, nowMs: () => now })
    expect(r.ready()).toBe(false) // 还没连过
    await r.refresh()
    expect(r.ready()).toBe(true)
    now = 30_000
    expect(r.ready()).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    r.markDown()
    expect(r.ready()).toBe(false)
    now = 200_000
    r.ready()
    await new Promise((x) => setTimeout(x, 0))
    expect(probe).toHaveBeenCalledTimes(2)
    expect(r.ready()).toBe(true)
    expect(createEgoReadiness({ path: () => undefined, probe }).ready()).toBe(false)
  })
})

/* ── 读 Reddit ───────────────────────────────────────────────────── */

const ORIGIN = 'http://127.0.0.1:4964'
const thing = (id: string, kind: 't1' | 't3', created = 1_760_400_000) => ({
  kind,
  data: {
    id,
    name: `${kind}_${id}`,
    author: 'alice',
    subreddit: 'ivraxr',
    created_utc: created,
    ...(kind === 't3' ? { title: `post ${id}`, selftext: 'x' } : { body: `c ${id}` }),
    permalink: `/r/ivraxr/comments/p1/x/${id}/`,
  },
})
const listing = (children: unknown[], after: string | null = null) =>
  JSON.stringify({ kind: 'Listing', data: { after, children } })
const json = (body: string, status = 200) => ({
  status,
  ct: 'application/json; charset=UTF-8',
  body,
})

describe('在 ego 里读 Reddit（同一份 runRedditRead）', () => {
  const job = (over: Partial<RedditReadJob> = {}): RedditReadJob => ({
    id: 'rj_1',
    workspace_id: 'ws_1',
    expect_user: 'ivra_official',
    reads: [
      { key: 'inbox', kind: 'inbox', max_pages: 1 },
      { key: 'sub_new:ivraxr', kind: 'sub_new', subreddit: 'ivraxr', max_pages: 3 },
    ],
    title: 't',
    created_at: '2026-10-23T00:00:00.000Z',
    ...over,
  })
  const me = {
    [`${ORIGIN}/api/me.json?raw_json=1`]: json('{"kind":"t2","data":{"name":"ivra_official"}}'),
  }
  it('收件箱 + 自家版块翻两页：第一趟取第一页、第二趟取翻页；每趟都收空间；只 GET', async () => {
    const { reader: r, log } = reader({
      fetches: {
        ...me,
        [`${ORIGIN}/message/inbox/.json?limit=100&raw_json=1&mark=false`]: json(
          listing([thing('c1', 't1')]),
        ),
        [`${ORIGIN}/r/ivraxr/new/.json?limit=100&raw_json=1`]: json(
          listing([thing('a1', 't3')], 't3_a1'),
        ),
        [`${ORIGIN}/r/ivraxr/new/.json?limit=100&raw_json=1&after=t3_a1`]: json(
          listing([thing('a2', 't3')]),
        ),
      },
    })
    const res = await egoRedditRead(job(), { reader: r, origin: ORIGIN, gapMs: 0 })
    expect(res).toMatchObject({ outcome: 'done', user: 'ivra_official' })
    expect(res.parts.map((p) => [p.key, p.items.map((i) => i.name)])).toEqual([
      ['inbox', ['t1_c1']],
      ['sub_new:ivraxr', ['t3_a1', 't3_a2']],
    ])
    expect(log.spaces).toHaveLength(2)
    expect(log.finished).toEqual([{ keep: [] }, { keep: [] }])
    expect(log.gotos.every((u) => u.startsWith(ORIGIN))).toBe(true)
    expect(log.fetches.every((f) => f.method === 'GET' && f.url.startsWith(ORIGIN))).toBe(true)
    // 收件箱不改已读
    expect(log.fetches.find((f) => f.url.includes('/message/'))?.url).toContain('mark=false')
  })
  it('登的不是品牌号：一条都不读（话术换成 ego）', async () => {
    const { reader: r } = reader({
      fetches: {
        [`${ORIGIN}/api/me.json?raw_json=1`]: json('{"kind":"t2","data":{"name":"someone"}}'),
      },
    })
    const res = await egoRedditRead(job(), { reader: r, origin: ORIGIN, gapMs: 0 })
    expect(res.outcome).toBe('wrong_user')
    expect(res.message).toContain('ego 里登着的是 u/someone')
    expect(res.parts).toEqual([])
  })
  it('没登录：not_logged_in', async () => {
    const { reader: r } = reader({ fetches: { [`${ORIGIN}/api/me.json?raw_json=1`]: json('{}') } })
    const res = await egoRedditRead(job(), { reader: r, origin: ORIGIN, gapMs: 0 })
    expect(res.outcome).toBe('not_logged_in')
    expect(res.message).toContain('ego 里的 Reddit 没登录')
  })
  it('429：停下整件活，已读到的照样交回，后面的不再去取', async () => {
    const { reader: r, log } = reader({
      fetches: {
        ...me,
        [`${ORIGIN}/message/inbox/.json?limit=100&raw_json=1&mark=false`]: json(
          'Too Many Requests',
          429,
        ),
        [`${ORIGIN}/r/ivraxr/new/.json?limit=100&raw_json=1`]: json(listing([thing('a1', 't3')])),
      },
    })
    const res = await egoRedditRead(job(), { reader: r, origin: ORIGIN, gapMs: 0 })
    expect(res.outcome).toBe('blocked')
    expect(log.fetches.map((f) => f.url)).not.toContain(
      `${ORIGIN}/r/ivraxr/new/.json?limit=100&raw_json=1`,
    )
  })
  it('ego 用不了：failed（一路都没读）', async () => {
    const r = createEgoPageReader({ egoPath: () => undefined })
    const res = await egoRedditRead(job(), { reader: r })
    expect(res).toMatchObject({ outcome: 'failed', parts: [] })
  })
})

describe('ego 替插件领活', () => {
  const job: RedditReadJob = {
    id: 'rj_9',
    workspace_id: 'ws_1',
    reads: [],
    title: 't',
    created_at: '2026-10-23T00:00:00.000Z',
  }
  it('有活：在 ego 里读、交回；没活：按巡查说的间隔再问；ego 不能用不去领', async () => {
    const queue = [job]
    const results: string[] = []
    const watch = {
      next: vi.fn((i: { connected: boolean; via?: 'ego' }) => {
        expect(i).toEqual({ connected: true, via: 'ego' })
        const j = queue.shift()
        return j === undefined ? { retry_after_ms: 60_000 } : { job: j, retry_after_ms: 0 }
      }),
      result: vi.fn(async (id: string) => {
        results.push(id)
        return { accepted: true as const }
      }),
    }
    const timers: number[] = []
    let ready = true
    const run = vi.fn(async () => ({ outcome: 'done' as const, message: 'ok', parts: [] }))
    const pump = createEgoRedditPump({
      watch: () => watch,
      ready: () => ready,
      run,
      setTimer: (_fn, ms) => {
        timers.push(ms)
        return { cancel: () => undefined }
      },
    })
    await pump.kick()
    expect(run).toHaveBeenCalledWith(job)
    expect(results).toEqual(['rj_9'])
    expect(timers.at(-1)).toBe(60_000)
    ready = false
    watch.next.mockClear()
    await pump.kick()
    expect(watch.next).not.toHaveBeenCalled()
    pump.stop()
  })
})

/* ── 在线表格 ─────────────────────────────────────────────────────── */

const fakeXlsx = (rows: string[][]): Uint8Array => {
  const shared: string[] = []
  const idx = (s: string) => (shared.includes(s) ? shared.indexOf(s) : shared.push(s) - 1)
  const col = (c: number) => String.fromCharCode(65 + c)
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r.map((v, c) => `<c r="${col(c)}${i + 1}" t="s"><v>${idx(v)}</v></c>`).join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`
  return zipFiles([
    { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    {
      path: 'xl/workbook.xml',
      content:
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="红人" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      path: 'xl/sharedStrings.xml',
      content: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    },
    { path: 'xl/worksheets/sheet1.xml', content: sheet },
  ])
}

describe('在线表格（WP489 的可插拔读取口）', () => {
  it('认链接', () => {
    expect(onlineSheetKindOf('https://docs.google.com/spreadsheets/d/abc_1/edit#gid=7')).toBe(
      'google',
    )
    expect(onlineSheetKindOf('https://acme.feishu.cn/sheets/shtABC')).toBe('feishu')
    expect(onlineSheetKindOf('https://x.larksuite.com/wiki/w1')).toBe('feishu')
    expect(onlineSheetKindOf('https://example.com/t')).toBe('other')
    expect(onlineSheetKindOf('ftp://x')).toBeUndefined()
    const g = onlineSheetCall('https://docs.google.com/spreadsheets/d/abc_1/edit#gid=7', 'google')
    expect(g.steps.map((s) => s.id)).toEqual(['page', 'csv', 'csv_dl', 'gviz'])
    expect(JSON.stringify(g)).toContain('/spreadsheets/d/abc_1/export?format=csv&gid=7')
  })
  const G = 'http://127.0.0.1:4963/spreadsheets/d/sheet1/edit#gid=0'
  it('Google：借登录态 GET 导出 CSV', async () => {
    const { reader: r, log } = reader({
      pages: { [G]: { text: 'sheet' } },
      fetches: {
        'http://127.0.0.1:4963/spreadsheets/d/sheet1/export?format=csv&gid=0': {
          status: 200,
          ct: 'text/csv; charset=utf-8',
          body: '名字,平台,粉丝\nAlice,YouTube,12000\nBob,TikTok,800\n',
        },
      },
    })
    const sr = createEgoSheetReader({ ego: r })
    const got = await sr.read(G, { kind: 'google' })
    expect(got).toMatchObject({
      ok: true,
      via: 'google_csv',
      rows: [
        ['名字', '平台', '粉丝'],
        ['Alice', 'YouTube', '12000'],
        ['Bob', 'TikTok', '800'],
      ],
    })
    // 拿到 CSV 就不再打开导出页下载、不再读 gviz
    expect(log.gotos).toEqual([G])
    expect(log.finished).toEqual([{ keep: [] }])
  })
  it('Google：导出 GET 不行 → 打开导出地址下载', async () => {
    const dl = 'http://127.0.0.1:4963/spreadsheets/d/sheet1/export?format=csv&gid=0'
    const { reader: r, log } = reader({
      pages: { [G]: { text: 'sheet' } },
      downloads: { [dl]: { name: 'sheet1.csv', bytes: new TextEncoder().encode('a,b\n1,2\n') } },
    })
    const got = await createEgoSheetReader({ ego: r }).read(G, { kind: 'google' })
    expect(got).toMatchObject({
      ok: true,
      via: 'google_csv',
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    })
    expect(log.gotos).toEqual([G, dl])
  })
  it('Google 没登录：照实说「在 ego 里登录」', async () => {
    const { reader: r } = reader({ pages: { [G]: { text: 'Sign in', password: 1 } } })
    const got = await createEgoSheetReader({ ego: r }).read(G, { kind: 'google' })
    expect(got).toMatchObject({ ok: false, reason: 'login' })
    if (!got.ok) expect(got.message).toContain('ego 里还没登录Google')
  })
  const F = 'http://127.0.0.1:4963/sheets/shtFAKE'
  it('飞书：页面上读得到格子就用格子，不点导出', async () => {
    const { reader: r, log } = reader({
      pages: {
        [F]: {
          tables: [
            {
              source: 'aria',
              rows: [
                ['名字', '粉丝'],
                ['Carol', '3万'],
              ],
            },
          ],
        },
      },
      menu: [{ text: '更多', download: undefined }],
    })
    const got = await createEgoSheetReader({ ego: r }).read(F, { kind: 'feishu' })
    expect(got).toMatchObject({
      ok: true,
      via: 'page_cells',
      rows: [
        ['名字', '粉丝'],
        ['Carol', '3万'],
      ],
    })
    expect(log.clicks).toEqual([])
  })
  it('飞书画布读不到格子 → 更多 → 下载为 → Excel，读下载下来的 xlsx', async () => {
    const xlsx = fakeXlsx([
      ['名字', '平台', '状态'],
      ['Dora', 'Instagram', '已寄样'],
    ])
    const { reader: r, log } = reader({
      pages: { [F]: { text: '' } },
      menu: [
        { text: '', aria: '更多' },
        { text: '下载为' },
        { text: 'Excel (.xlsx)', download: { name: '红人表.xlsx', bytes: xlsx } },
      ],
    })
    const got = await createEgoSheetReader({ ego: r }).read(F, { kind: 'feishu' })
    expect(got).toMatchObject({
      ok: true,
      via: 'export_file',
      rows: [
        ['名字', '平台', '状态'],
        ['Dora', 'Instagram', '已寄样'],
      ],
    })
    expect(log.clicks).toHaveLength(3)
    expect(log.clicks.every((c) => c.startsWith('[data-agentsws-read="t"]|open export menu'))).toBe(
      true,
    )
    expect(log.finished).toEqual([{ keep: [] }])
  })
  it('飞书：没权限；读不出也导不出', async () => {
    const noAccess = reader({ pages: { [F]: { text: '你没有权限访问该文档，申请权限' } } })
    expect(
      await createEgoSheetReader({ ego: noAccess.reader }).read(F, { kind: 'feishu' }),
    ).toMatchObject({
      ok: false,
      reason: 'no_access',
    })
    const none = reader({ pages: { [F]: { text: '' } }, menu: [] })
    const got = await createEgoSheetReader({ ego: none.reader }).read(F, { kind: 'feishu' })
    expect(got).toMatchObject({ ok: false, reason: 'unreadable' })
    if (!got.ok) expect(got.message).toContain('下载为 Excel')
  }, 20_000)
  // 主会话 10-23 真机：多维表格画布上读不到格子；页面复制时写 text/plain（TSV，不带表头）+ text/bitable（转义过的 JSON）
  const BITABLE = {
    baseId: 'bascnFAKE',
    tableId: 'tblFAKE',
    viewId: 'vewFAKE',
    header: [
      { id: 'fld1', name: '名字', type: 1 },
      {
        id: 'fld2',
        name: '平台',
        type: 3,
        property: { options: [{ id: 'opt1', name: 'YouTube' }] },
      },
      { id: 'fld3', name: '粉丝', type: 2 },
    ],
  }
  const escaped = (o: unknown) => JSON.stringify(o).replace(/"/g, '&quot;')
  const B = 'http://127.0.0.1:4963/base/bascnFAKE?table=tblFAKE'
  it('飞书多维表格：画布 → 点一格、全选、复制，截住 text/bitable 的表头 + TSV 的值；不点导出、不改剪贴板', async () => {
    const { reader: r, log } = reader({
      pages: { [B]: { text: '表格 视图 筛选' } },
      canvas: {
        copy: [
          ['text/plain', 'Gus\tYouTube\t12000\n"Hana\nLee"\tTikTok\t800\n'],
          ['text/bitable', escaped(BITABLE)],
        ],
      },
      menu: [{ text: '更多' }],
    })
    const got = await createEgoSheetReader({ ego: r }).read(B, { kind: 'feishu' })
    expect(got).toMatchObject({
      ok: true,
      via: 'copy',
      rows: [
        ['名字', '平台', '粉丝'],
        ['Gus', 'YouTube', '12000'],
        ['Hana\nLee', 'TikTok', '800'],
      ],
    })
    expect(log.mouse).toEqual(['230,150|select a table cell'])
    expect(log.keys).toEqual(['ControlOrMeta+A', 'ControlOrMeta+C', 'Escape'])
    expect(log.clicks).toEqual([])
    expect(log.finished).toEqual([{ keep: [] }])
  })
  it('text/bitable 里带记录：按字段 id 取值、选项 id 换成名字', () => {
    const withRecords = {
      ...BITABLE,
      records: [{ recordId: 'rec1', fields: { fld1: 'Ivy', fld2: 'opt1', fld3: 5000 } }],
    }
    expect(copiedGrid([['text/bitable', escaped(withRecords)]])).toEqual([
      ['名字', '平台', '粉丝'],
      ['Ivy', 'YouTube', '5000'],
    ])
    // 只有 TSV（飞书表格 /sheets/ 也许是这样）：原样给
    expect(copiedGrid([['text/plain', 'a\tb\n1\t2']])).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(copiedGrid([])).toBeUndefined()
    expect(parseTsv('x\t"say ""hi"""\r\n')).toEqual([['x', 'say "hi"']])
  })
  it('复制什么都没截到 → 退到导出 Excel', async () => {
    const { reader: r, log } = reader({
      pages: { [B]: { text: '' } },
      canvas: { copy: [] },
      menu: [
        { text: '', aria: '更多' },
        { text: '下载为' },
        {
          text: 'Excel (.xlsx)',
          download: {
            name: 't.xlsx',
            bytes: fakeXlsx([
              ['a', 'b'],
              ['1', '2'],
            ]),
          },
        },
      ],
    })
    const got = await createEgoSheetReader({ ego: r }).read(B, { kind: 'feishu' })
    expect(got).toMatchObject({
      ok: true,
      via: 'export_file',
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    })
    expect(log.keys).toEqual(['ControlOrMeta+A', 'ControlOrMeta+C', 'Escape'])
    expect(log.clicks).toHaveLength(3)
  })
  it('ego 用不了：off（宿主照常走老路）', async () => {
    const r = createEgoPageReader({ egoPath: () => undefined })
    const sr = createEgoSheetReader({ ego: r })
    expect(sr.available()).toBe(false)
    expect(await sr.read(G)).toMatchObject({ ok: false, reason: 'off' })
  })
})
