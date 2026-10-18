/**
 * WP409（内测真机 10-18 #1）：更新下载断流。替身网络模拟「下到一半连接被关」、差分失败退整包、续传接着下、
 * 主进程未捕获的 `net::ERR_*` 不弹框而是交给下载。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../src/logging.js'
import { classifyUpdateError } from '../src/update-controller.js'
import {
  DownloadInterrupted,
  defaultRetryDelay,
  downloadResumable,
  idleGuard,
  isNetError,
  mainProcessErrorHandler,
  placeInUpdaterCache,
  type RangeResponse,
  type ResumableFiles,
  resolveUpdateFile,
  retryable,
  robustDownload,
} from '../src/update-download.js'

const closed = (): Error => new Error('net::ERR_CONNECTION_CLOSED')
const noSleep = async (): Promise<void> => undefined

/** 内存里的文件。 */
function memFiles(): ResumableFiles & { data: Map<string, Buffer> } {
  const data = new Map<string, Buffer>()
  return {
    data,
    size: (p) => data.get(p)?.length,
    openAppend: async (p) => ({
      write: async (chunk) => {
        data.set(p, Buffer.concat([data.get(p) ?? Buffer.alloc(0), Buffer.from(chunk)]))
      },
      close: async () => undefined,
    }),
    remove: (p) => {
      data.delete(p)
    },
    rename: (from, to) => {
      const v = data.get(from)
      if (v === undefined) throw new Error(`ENOENT ${from}`)
      data.set(to, v)
      data.delete(from)
    },
    ensureDir: () => undefined,
    writeText: (p, text) => {
      data.set(p, Buffer.from(text, 'utf8'))
    },
    sha512: async (p) =>
      createHash('sha512')
        .update(data.get(p) ?? Buffer.alloc(0))
        .digest('base64'),
  }
}

const PAYLOAD = Buffer.from('0123456789'.repeat(100)) // 1000 字节
const SHA = createHash('sha512').update(PAYLOAD).digest('base64')

/** 替身下载站：认 Range；`cutAfter` 给了就在送出这么多字节后断流（只断一次一个）。 */
function server(cuts: number[], opts: { ignoreRange?: boolean } = {}) {
  const ranges: (string | undefined)[] = []
  const fetch = async (_url: string, headers: Record<string, string>): Promise<RangeResponse> => {
    ranges.push(headers.Range)
    const m = /bytes=(\d+)-/.exec(headers.Range ?? '')
    const start = m === null || opts.ignoreRange === true ? 0 : Number(m[1])
    const cut = cuts.shift()
    const body = async function* () {
      let sent = 0
      for (let i = start; i < PAYLOAD.length; i += 100) {
        if (cut !== undefined && sent >= cut) throw closed()
        const chunk = PAYLOAD.subarray(i, Math.min(i + 100, PAYLOAD.length))
        sent += chunk.length
        yield new Uint8Array(chunk)
      }
    }
    return { status: start > 0 ? 206 : 200, body: body() }
  }
  return { fetch, ranges }
}

describe('isNetError / retryable', () => {
  it('认 Chromium 网络栈的断线错误', () => {
    expect(isNetError(closed())).toBe(true)
    expect(isNetError(new Error('ENOSPC'))).toBe(false)
    expect(isNetError('net::ERR_CONNECTION_RESET')).toBe(true)
  })

  it('断线 / 超时 / 校验没过再试；磁盘满、404 不试', () => {
    expect(retryable(closed())).toBe(true)
    expect(retryable(new DownloadInterrupted(closed()))).toBe(true)
    expect(retryable(new Error('Request timed out'))).toBe(true)
    expect(retryable(new Error('sha512 checksum mismatch, expected x'))).toBe(true)
    expect(retryable(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe(false)
    expect(retryable(new Error('HttpError: 404 Not Found'))).toBe(false)
    expect(retryable(new Error('something odd'))).toBe(false)
  })

  it('叫停的那一次在状态机里仍算「网络」', () => {
    expect(classifyUpdateError(new DownloadInterrupted(closed()))).toBe('network')
  })
})

describe('mainProcessErrorHandler（主进程兜底，不弹原生框）', () => {
  it('断线交给正在跑的下载；别的只写日志', () => {
    const onNetError = vi.fn(() => true)
    const handle = mainProcessErrorHandler({ logger: silentLogger(), onNetError })
    handle(closed())
    expect(onNetError).toHaveBeenCalledTimes(1)
    handle(new TypeError('x is undefined'))
    expect(onNetError).toHaveBeenCalledTimes(1)
  })
})

describe('robustDownload', () => {
  it('第一次就好：只下一次、走差分', async () => {
    const attempt = vi.fn(async () => ['a.exe'])
    await expect(
      robustDownload({ attempt, sleep: noSleep, logger: silentLogger() }),
    ).resolves.toEqual(['a.exe'])
    expect(attempt.mock.calls).toEqual([[true]])
  })

  it('差分那次断了 → 退整包（不再差分），续传接着下', async () => {
    const calls: boolean[] = []
    const resume = vi.fn(async () => undefined)
    const files = await robustDownload({
      attempt: async (differential) => {
        calls.push(differential)
        if (differential) throw new DownloadInterrupted(closed())
        return ['full.exe']
      },
      resume,
      sleep: noSleep,
      logger: silentLogger(),
    })
    expect(files).toEqual(['full.exe'])
    expect(calls).toEqual([true, false])
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('没有续传（备用源）就整包重下，最多 3 次，之后把最后那个错抛出来', async () => {
    const calls: boolean[] = []
    const waits: number[] = []
    const out = robustDownload({
      attempt: async (differential) => {
        calls.push(differential)
        throw closed()
      },
      sleep: async (ms) => {
        waits.push(ms)
      },
      logger: silentLogger(),
    })
    await expect(out).rejects.toThrow('net::ERR_CONNECTION_CLOSED')
    expect(calls).toEqual([true, false, false, false])
    expect(waits).toEqual([2000, 4000, 8000])
  })

  it('磁盘满不重试，原样抛', async () => {
    const attempt = vi.fn(async () => {
      throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
    })
    await expect(
      robustDownload({ attempt, sleep: noSleep, logger: silentLogger() }),
    ).rejects.toThrow('ENOSPC')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('等待时间指数增长，封顶 30 秒', () => {
    expect([1, 2, 3, 10].map(defaultRetryDelay)).toEqual([2000, 4000, 8000, 30_000])
  })
})

describe('downloadResumable（续传）', () => {
  const base = { url: 'https://dl/x.exe', partial: '/c/x.exe.part', sha512: SHA }

  it('断了两次：每次带 Range 接着下，下完校验过', async () => {
    const files = memFiles()
    const { fetch, ranges } = server([300, 400])
    const progress: number[] = []
    const out = await downloadResumable({
      ...base,
      size: PAYLOAD.length,
      fetch,
      files,
      sleep: noSleep,
      onProgress: (p) => progress.push(p),
      logger: silentLogger(),
    })
    expect(out).toBe(base.partial)
    expect(ranges).toEqual([undefined, 'bytes=300-', 'bytes=700-'])
    expect(files.data.get(base.partial)?.equals(PAYLOAD)).toBe(true)
    expect(progress.at(-1)).toBe(100)
  })

  it('上次留下的半截直接接着下（跨两次点「重试」）', async () => {
    const files = memFiles()
    files.data.set(base.partial, PAYLOAD.subarray(0, 500))
    const { fetch, ranges } = server([])
    await downloadResumable({
      ...base,
      size: 1000,
      fetch,
      files,
      sleep: noSleep,
      logger: silentLogger(),
    })
    expect(ranges).toEqual(['bytes=500-'])
    expect(files.data.get(base.partial)?.equals(PAYLOAD)).toBe(true)
  })

  it('服务器不认 Range（回 200）：丢掉半截从头写', async () => {
    const files = memFiles()
    files.data.set(base.partial, Buffer.from('garbage'))
    const { fetch } = server([], { ignoreRange: true })
    const real = async (url: string, h: Record<string, string>) => ({
      ...(await fetch(url, h)),
      status: 200,
    })
    await downloadResumable({
      ...base,
      size: 1000,
      fetch: real,
      files,
      sleep: noSleep,
      logger: silentLogger(),
    })
    expect(files.data.get(base.partial)?.equals(PAYLOAD)).toBe(true)
  })

  it('一直一个字节都下不到：连续 3 次后放弃', async () => {
    const files = memFiles()
    const { fetch, ranges } = server([0, 0, 0, 0])
    await expect(
      downloadResumable({
        ...base,
        size: 1000,
        fetch,
        files,
        sleep: noSleep,
        logger: silentLogger(),
      }),
    ).rejects.toThrow('net::ERR_CONNECTION_CLOSED')
    expect(ranges).toHaveLength(3)
  })

  it('校验没过：丢掉半截，抛「checksum」（外层再试会从头下）', async () => {
    const files = memFiles()
    const { fetch } = server([])
    await expect(
      downloadResumable({
        ...base,
        sha512: 'wrong',
        size: 1000,
        fetch,
        files,
        sleep: noSleep,
        logger: silentLogger(),
      }),
    ).rejects.toThrow('sha512 checksum mismatch')
    expect(files.data.has(base.partial)).toBe(false)
  })

  it('4xx（非 416）不重试', async () => {
    const files = memFiles()
    const fetch = vi.fn(async () => ({ status: 403, body: null }))
    await expect(
      downloadResumable({
        ...base,
        size: 1000,
        fetch,
        files,
        sleep: noSleep,
        logger: silentLogger(),
      }),
    ).rejects.toThrow('HTTP 403')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('交给 electron-updater 的缓存', () => {
  it('放进 pending/ 并写它认的 update-info.json', () => {
    const files = memFiles()
    files.data.set('/c/resume/x.exe.part', PAYLOAD)
    const dest = placeInUpdaterCache({
      files,
      from: '/c/resume/x.exe.part',
      pendingDir: '/c/pending',
      fileName: 'x.exe',
      sha512: SHA,
      isAdminRightsRequired: false,
      join,
    })
    expect(dest).toBe(join('/c/pending', 'x.exe'))
    expect(files.data.get(dest)?.equals(PAYLOAD)).toBe(true)
    expect(
      JSON.parse(files.data.get(join('/c/pending', 'update-info.json'))?.toString() ?? ''),
    ).toEqual({
      fileName: 'x.exe',
      sha512: SHA,
      isAdminRightsRequired: false,
    })
  })

  it('latest.yml 里的相对文件名按更新源补全；文件名只取最后一段', () => {
    expect(
      resolveUpdateFile(
        'https://dl.agentsws.com/beta',
        'Agents-Workshop-Setup-0.2.1-beta.1-x64.exe',
      ),
    ).toEqual({
      url: 'https://dl.agentsws.com/beta/Agents-Workshop-Setup-0.2.1-beta.1-x64.exe',
      fileName: 'Agents-Workshop-Setup-0.2.1-beta.1-x64.exe',
    })
    expect(resolveUpdateFile('https://dl.agentsws.com/beta/', '../../evil.exe').fileName).toBe(
      'evil.exe',
    )
  })
})

describe('idleGuard（代理吊着不给数据）', () => {
  it('每来一块就重新计时；一直没数据就叫停', async () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = []
    const fake = {
      set: (fn: () => void, ms: number) => {
        const t = { fn, ms, live: true }
        timers.push(t)
        return t
      },
      clear: (h: unknown) => {
        ;(h as { live: boolean }).live = false
      },
    }
    const abort = vi.fn()
    async function* body() {
      yield 1
      yield 2
    }
    const got: number[] = []
    for await (const x of idleGuard(body(), abort, 60_000, fake)) got.push(x)
    expect(got).toEqual([1, 2])
    expect(timers.every((t) => !t.live)).toBe(true)
    expect(timers[0]?.ms).toBe(60_000)
    // 计时器到点 = 叫停
    timers[0]?.fn()
    expect(abort).toHaveBeenCalledTimes(1)
  })
})

describe('10-18 内测那一幕：差分下载断线、错误没人接、下载卡住', () => {
  it('主进程兜底叫停卡住的那一次 → 退整包下完；全程不弹框', async () => {
    let interrupt: ((err: unknown) => boolean) | undefined
    const guard = mainProcessErrorHandler({
      logger: silentLogger(),
      onNetError: (err) => interrupt?.(err) ?? false,
    })
    const calls: boolean[] = []
    const attempt = (differential: boolean): Promise<string[]> =>
      new Promise((resolve, reject) => {
        calls.push(differential)
        interrupt = (err) => {
          interrupt = undefined
          reject(new DownloadInterrupted(err))
          return true
        }
        // 差分那次：永远不回来（库里 multipleRangeDownloader 的 response 没挂 error 监听）
        if (!differential) resolve(['full.exe'])
      })
    const out = robustDownload({ attempt, sleep: noSleep, logger: silentLogger() })
    await Promise.resolve()
    // Electron net 流把 net::ERR_CONNECTION_CLOSED 抛成主进程未捕获异常
    guard(closed())
    await expect(out).resolves.toEqual(['full.exe'])
    expect(calls).toEqual([true, false])
  })
})
