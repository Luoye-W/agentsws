/**
 * WP345：插件跟着工坊更新（`src/lib/self-update.ts` + `src/lib/idle-gate.ts`）。
 *
 * 版本比对、空闲判断（关闸 → 等手上那件做完 → 重载）、重载后上报「从哪版换来」、
 * 重载了还是旧版就放弃（不每分钟重载）、本机没开 / 没配对什么都不做；领活的轮询关闸后不再领新活。
 */
import { buildAdsJob } from '@agentsws/browser-action'
import { afterEach, describe, expect, it } from 'vitest'
import { pollAdsOnce } from '../src/lib/ads/poller'
import { actionsBusy, actionsHeld, holdActions, registerBusy } from '../src/lib/idle-gate'
import { pollRedditOnce } from '../src/lib/reddit/poller'
import { checkForUpdate, runningVersion, UPDATE_KEY } from '../src/lib/self-update'
import { memoryStore, SETTINGS_KEY } from '../src/lib/storage'
import { FakeTab } from './ads-fakes'

const NOW = '2026-10-15T09:00:00.000Z'
const pauseJob = () =>
  buildAdsJob({
    id: 'job_p',
    workspace_id: 'ws',
    account: { platform: 'google_ads', id: '123-456-7890', ocid: '42' },
    action: { kind: 'pause', entity: { level: 'campaign', id: '111', name: '春季' } },
    approval_id: 'ap_1',
    created_at: NOW,
  })
let busy = false
registerBusy('test', () => busy)

afterEach(() => {
  holdActions(false)
  busy = false
})

/** 假本机：记下每次报的版本，回文件夹里那一版。 */
function local(folder: string | undefined, opts: { down?: boolean; status?: number } = {}) {
  const calls: Record<string, unknown>[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (opts.down === true) throw new TypeError('fetch failed')
    calls.push({ url, ...(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>) })
    const status = opts.status ?? 200
    return new Response(
      JSON.stringify(
        status === 200
          ? { ok: true, data: folder === undefined ? {} : { folder_version: folder } }
          : { ok: false, error: { message: 'x' } },
      ),
      { status },
    )
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const paired = (extra: Record<string, unknown> = {}) =>
  memoryStore({ [SETTINGS_KEY]: { port: 4399, token: 'ext_t' }, ...extra })

function deps(
  store: ReturnType<typeof memoryStore>,
  running: string,
  fetch: typeof globalThis.fetch,
) {
  const reloads: number[] = []
  return {
    reloads,
    d: {
      store,
      fetch,
      running,
      reload: () => {
        reloads.push(1)
      },
      now: () => NOW,
      sleep: async () => {},
      maxWaitMs: 3000,
    },
  }
}

describe('版本', () => {
  it('version_name 优先（带 beta 号的完整那串）', () => {
    expect(runningVersion({ version: '0.2.0', version_name: '0.2.0-beta.8' })).toBe('0.2.0-beta.8')
    expect(runningVersion({ version: '0.2.0' })).toBe('0.2.0')
    expect(runningVersion({ version: '0.2.0', version_name: '' })).toBe('0.2.0')
  })
})

describe('问一次「工坊换了新版没有」', () => {
  it('WP432：没配对也问（不带令牌、只问版本号）；一样就不动', async () => {
    const l = local('1')
    const { d, reloads } = deps(memoryStore(), '1', l.fetch)
    expect(await checkForUpdate(d)).toBe('unpaired')
    expect(l.calls).toEqual([
      { url: 'http://127.0.0.1:4317/v1/extension/version/probe', version: '1' },
    ])
    expect(reloads).toEqual([])
  })

  it('WP432：没配对、工坊换了新版 → 等空闲后自己重载；重载了还是旧版 → 这一版不再重试', async () => {
    const l = local('2')
    const store = memoryStore()
    const first = deps(store, '1', l.fetch)
    expect(await checkForUpdate(first.d)).toBe('reloading')
    expect(first.reloads).toEqual([1])
    // 重载后还是 1（多半从别的文件夹加载的）
    const again = deps(store, '1', l.fetch)
    expect(await checkForUpdate(again.d)).toBe('gave_up')
    expect(again.reloads).toEqual([])
  })

  it('WP432：没配对、本机没开 → 什么都不做', async () => {
    const l = local('2', { down: true })
    const { d, reloads } = deps(memoryStore(), '1', l.fetch)
    expect(await checkForUpdate(d)).toBe('unpaired')
    expect(reloads).toEqual([])
  })

  it('一样：只报版本，不重载', async () => {
    const l = local('0.2.0-beta.8')
    const { d, reloads } = deps(paired(), '0.2.0-beta.8', l.fetch)
    expect(await checkForUpdate(d)).toBe('same')
    expect(l.calls).toEqual([
      { url: 'http://127.0.0.1:4399/v1/extension/version', version: '0.2.0-beta.8' },
    ])
    expect(reloads).toEqual([])
  })

  it('不是桌面版（本机没回文件夹版本）：什么都不做', async () => {
    const { d, reloads } = deps(paired(), '1.0.0', local(undefined).fetch)
    expect(await checkForUpdate(d)).toBe('same')
    expect(reloads).toEqual([])
  })

  it('本机没开 / 老版本本机服务：什么都不做', async () => {
    const a = deps(paired(), '1.0.0', local('2.0.0', { down: true }).fetch)
    expect(await checkForUpdate(a.d)).toBe('offline')
    const b = deps(paired(), '1.0.0', local('2.0.0', { status: 501 }).fetch)
    expect(await checkForUpdate(b.d)).toBe('offline')
    expect([...a.reloads, ...b.reloads]).toEqual([])
  })

  it('不一样、手上没活：记下「从哪版换到哪版」再重载', async () => {
    const store = paired()
    const { d, reloads } = deps(store, '0.2.0-beta.7', local('0.2.0-beta.8').fetch)
    expect(await checkForUpdate(d)).toBe('reloading')
    expect(reloads).toEqual([1])
    expect((await store.get([UPDATE_KEY]))[UPDATE_KEY]).toEqual({
      reloading: { from: '0.2.0-beta.7', to: '0.2.0-beta.8', at: NOW },
    })
  })

  it('重载后第一次问：带上「从哪版换来」，记录清掉', async () => {
    const store = paired({
      [UPDATE_KEY]: { reloading: { from: '0.2.0-beta.7', to: '0.2.0-beta.8', at: NOW } },
    })
    const l = local('0.2.0-beta.8')
    const { d, reloads } = deps(store, '0.2.0-beta.8', l.fetch)
    expect(await checkForUpdate(d)).toBe('same')
    expect(l.calls[0]).toMatchObject({ version: '0.2.0-beta.8', reloaded_from: '0.2.0-beta.7' })
    expect((await store.get([UPDATE_KEY]))[UPDATE_KEY]).toEqual({})
    expect(reloads).toEqual([])
  })

  it('重载了还是旧版：报「放弃了」，这一版不再重试；工坊再换一版就再试', async () => {
    const store = paired({
      [UPDATE_KEY]: { reloading: { from: '1.0.0', to: '1.0.1', at: NOW } },
    })
    const l = local('1.0.1')
    const first = deps(store, '1.0.0', l.fetch)
    expect(await checkForUpdate(first.d)).toBe('gave_up')
    expect(await checkForUpdate(first.d)).toBe('gave_up')
    expect(first.reloads).toEqual([])
    expect(l.calls.map((c) => c.gave_up)).toEqual(['1.0.1', '1.0.1'])
    const next = deps(store, '1.0.0', local('1.0.2').fetch)
    expect(await checkForUpdate(next.d)).toBe('reloading')
    expect(next.reloads).toEqual([1])
  })

  it('手上有活：关闸等它做完；等不到就下一分钟再试，等到了再重载', async () => {
    const store = paired()
    busy = true
    const { d, reloads } = deps(store, '1.0.0', local('1.0.1').fetch)
    expect(await checkForUpdate(d)).toBe('waiting')
    expect(actionsHeld()).toBe(true)
    expect(reloads).toEqual([])
    let ticks = 0
    const done = await checkForUpdate({
      ...d,
      sleep: async () => {
        ticks += 1
        if (ticks === 2) busy = false
      },
    })
    expect(done).toBe('reloading')
    expect(reloads).toEqual([1])
  })

  it('同一时刻只跑一个', async () => {
    const store = paired()
    busy = true
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { d } = deps(store, '1.0.0', local('1.0.1').fetch)
    const a = checkForUpdate({ ...d, sleep: () => gate })
    expect(await checkForUpdate(d)).toBe('waiting')
    busy = false
    release()
    expect(await a).toBe('reloading')
  })

  it('换回来了（文件夹又是正在跑的这一版）：开闸', async () => {
    holdActions(true)
    const { d } = deps(paired(), '1.0.0', local('1.0.0').fetch)
    expect(await checkForUpdate(d)).toBe('same')
    expect(actionsHeld()).toBe(false)
  })
})

describe('关闸后领活的轮询不再领新活', () => {
  it('闸关着：广告、Reddit 都直接回 held，不去问本机', async () => {
    holdActions(true)
    const calls: string[] = []
    const fetch = (async (url: string) => {
      calls.push(url)
      return new Response('{}')
    }) as typeof globalThis.fetch
    const store = paired()
    const perms = {
      contains: async () => true,
      request: async () => true,
      remove: async () => true,
    }
    expect(
      await pollAdsOnce({
        store,
        perms,
        fetch,
        openTab: async () => new FakeTab().driver(),
        control: { stop: false },
        now: () => NOW,
        sleep: async () => {},
        waitSeconds: 0,
      }),
    ).toBe('held')
    expect(
      await pollRedditOnce({
        store,
        perms,
        fetch,
        readFetch: () => async (url) => ({
          status: 200,
          url,
          content_type: 'application/json',
          body: '{}',
        }),
        now: () => NOW,
        sleep: async () => {},
        control: { stop: false },
      }),
    ).toBe('held')
    expect(calls).toEqual([])
  })

  it('做到一半关闸：这一件做完、回了结局，不再领下一件', async () => {
    const calls: string[] = []
    const fetch = (async (url: string) => {
      calls.push(new URL(url).pathname)
      const path = new URL(url).pathname
      const data = path.endsWith('/next')
        ? { job: pauseJob(), retry_after_ms: 0 }
        : path.endsWith('/progress')
          ? { stop: false, confirmed: false }
          : {}
      return new Response(JSON.stringify({ ok: true, data }))
    }) as typeof globalThis.fetch
    const tab = new FakeTab()
    const out = await pollAdsOnce({
      store: paired(),
      perms: {
        contains: async () => true,
        request: async () => true,
        remove: async () => true,
      },
      fetch,
      openTab: async () => {
        // 领到活之后、开始做之前：工坊换了新版、关闸
        holdActions(true)
        expect(actionsBusy()).toBe(true)
        return tab.driver()
      },
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      waitSeconds: 0,
      gapMs: 0,
    })
    expect(out).toBe('ran')
    expect(calls.filter((p) => p.endsWith('/next'))).toHaveLength(1)
    expect(calls.some((p) => p.endsWith('/result'))).toBe(true)
    expect(actionsBusy()).toBe(false)
  })
})
