/**
 * WP82（55 §3 末段）：托盘那条「打开工作用的浏览器」。
 *
 * 四件事各钉一条，每一条都是这个功能真正的价值所在：
 * - **单独一个 Profile**（不碰用户日常那个）与**调试口只听回环**；
 * - 已经开着就**复用**，不冒第二个窗口（attach 一次一个 Session）；
 * - 找不到 Chrome 就**如实说**，不去下载（16 §3）；
 * - 起来了但没开出调试口 → 也如实说，不假装成功。
 *
 * 一个 Chrome 都不真起：可执行文件用假的 `FileStore` 造出来，spawn 用假的。
 */
import { describe, expect, it } from 'vitest'
import { memoryFileStore } from '../src/node-files.js'
import type { FetchLike } from '../src/ports.js'
import {
  candidateExecutables,
  openWorkBrowser,
  WORK_BROWSER_PORT,
  workProfileDir,
} from '../src/work-browser.js'
import { fakeSpawner, response } from './fakes.js'

const USER_DATA = '/Users/me/Library/Application Support/agentsws'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VERSION_BODY = JSON.stringify({ Browser: 'Chrome/140.0.7259.2' })

/** 假 fetch：`live` 里的端口通，别的不通。 */
function probe(live: Set<number>): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const impl = (async (url: string) => {
    calls.push(url)
    const port = Number(/:(\d+)\//.exec(url)?.[1] ?? 0)
    if (!live.has(port)) throw new Error('ECONNREFUSED')
    return response(200, VERSION_BODY)
  }) as FetchLike & { calls: string[] }
  impl.calls = calls
  return impl
}

/** 一路往前跳的时钟：等就绪那一圈立刻超时（测试不真等 10 秒）。 */
function ticking(): () => number {
  let n = 0
  return () => {
    n += 20_000
    return n
  }
}

function ports(over: Partial<Parameters<typeof openWorkBrowser>[0]> = {}) {
  return {
    files: memoryFileStore({ [CHROME]: 'binary' }),
    spawner: fakeSpawner(),
    fetch: probe(new Set<number>()),
    userDataDir: USER_DATA,
    platform: 'darwin' as NodeJS.Platform,
    sleep: () => Promise.resolve(),
    now: () => 0,
    ...over,
  }
}

describe('打开工作用的浏览器', () => {
  it('起的是一个**单独 Profile** 的 Chrome，调试口只听回环', async () => {
    // 起完第 2 次探测时端口就通了（第一次是"有没有已经开着的"那一轮）
    let seen = 0
    const live = new Set<number>()
    const fetchLike = (async (url: string) => {
      seen += 1
      // 前四次是"找已经开着的"那一轮（9333/9334/9335/9336），一律不通
      if (seen > 4) live.add(WORK_BROWSER_PORT)
      const port = Number(/:(\d+)\//.exec(url)?.[1] ?? 0)
      if (!live.has(port)) throw new Error('ECONNREFUSED')
      return response(200, VERSION_BODY)
    }) as FetchLike
    const p = ports({ fetch: fetchLike })
    const result = await openWorkBrowser(p)

    expect(result).toMatchObject({ ok: true, reused: false, executable: CHROME })
    if (!result.ok) return
    expect(result.endpoint).toBe(`http://127.0.0.1:${WORK_BROWSER_PORT}`)

    const spawned = p.spawner.requests[0]
    expect(spawned?.command).toBe(CHROME)
    // **不碰用户日常那个 Profile**（55 §3 末段点名的那类跨 Profile 泄漏）
    expect(spawned?.args).toContain(`--user-data-dir=${workProfileDir(USER_DATA)}`)
    expect(result.profileDir).toBe(`${USER_DATA}/browser-profile`)
    // 调试口只听 127.0.0.1：别的机器连不上你的浏览器
    expect(spawned?.args).toContain('--remote-debugging-address=127.0.0.1')
    expect(spawned?.args).toContain(`--remote-debugging-port=${WORK_BROWSER_PORT}`)
    // 没有这一条时 Chrome 会把窗口交给已经在跑的实例，user-data-dir 与调试口双双失效
    expect(spawned?.args).toContain('--no-first-run')
  })

  it('已经有一个开着就复用，不再起第二个窗口（attach 一次一个 Session）', async () => {
    const p = ports({ fetch: probe(new Set([WORK_BROWSER_PORT])) })
    const result = await openWorkBrowser(p)
    expect(result).toMatchObject({
      ok: true,
      reused: true,
      endpoint: `http://127.0.0.1:${WORK_BROWSER_PORT}`,
    })
    expect(p.spawner.requests).toHaveLength(0)
  })

  it('9333 被别的程序占了、9334 上是我们的 → 用 9334', async () => {
    const p = ports({ fetch: probe(new Set([WORK_BROWSER_PORT + 1])) })
    const result = await openWorkBrowser(p)
    expect(result).toMatchObject({ ok: true, reused: true })
    if (result.ok) expect(result.endpoint).toBe(`http://127.0.0.1:${WORK_BROWSER_PORT + 1}`)
  })

  it('没装 Chrome → 如实说，不去下载（16 §3）', async () => {
    const p = ports({ files: memoryFileStore() })
    const result = await openWorkBrowser(p)
    expect(result).toMatchObject({ ok: false, reason: 'no_chrome' })
    if (!result.ok) expect(result.detail).toContain('没找到 Chrome')
    expect(p.spawner.requests).toHaveLength(0)
  })

  it('用户自己指了路径就用那一个，不去猜（哪怕系统里也有 Chrome）', async () => {
    const custom = '/opt/brave/brave'
    const p = ports({
      files: memoryFileStore({ [CHROME]: 'binary', [custom]: 'binary' }),
      executablePath: custom,
      // 时钟一路往前跳 → 起完之后不死等，直接走到 `not_ready`；这一条只看挑了谁
      now: ticking(),
    })
    const result = await openWorkBrowser(p)
    expect(p.spawner.requests[0]?.command).toBe(custom)
    expect(result.ok).toBe(false)
  })

  it('起来了但没开出调试口 → 如实说，不假装成功', async () => {
    const p = ports({ now: ticking() })
    const result = await openWorkBrowser(p)
    expect(result).toMatchObject({ ok: false, reason: 'not_ready' })
    if (!result.ok) expect(result.detail).toContain('没有开出调试口')
  })
})

describe('各平台上去哪儿找 Chrome', () => {
  it('三个平台都给得出候选，而且第一顺位是 Google Chrome', () => {
    expect(candidateExecutables('darwin')[0]).toContain('Google Chrome')
    expect(candidateExecutables('win32')[0]).toContain('chrome.exe')
    expect(candidateExecutables('linux')[0]).toContain('google-chrome')
  })
})
