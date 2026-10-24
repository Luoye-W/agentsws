/**
 * WP509：**进程内的假 ego**——把产品生成的 ego 脚本放进本进程里真跑，`taskSpace` / `page.*` 落到一个无头 Chromium
 * 上（Playwright），页面是本机假飞书（`fake-feishu.ts`）。不起真 ego、不联网、不碰任何真网站。
 *
 * 只实现产品脚本用到的那几样 ego 接口（`taskSpace`、`page.goto / evaluate / mouse.click / keyboard.press / keyboard.paste /
 * click / waitForTimeout / url / screenshot`、`finish`），并记下每一次按键、点击、粘贴，测试据此核对「只按白名单的键」。
 * `keyboard.paste` 照 ego 的样子发一次粘贴（这里是派发一个带 `text/plain` 的 paste 事件；真 ego 是原生粘贴快捷键）。
 */
import { join } from 'node:path'
import type { EgoProcessResult } from '@agentsws/dsh-adapter'
import type { EgoSpawn } from '../../src/ego-write/runner.js'

type PwPage = {
  goto(url: string, o?: unknown): Promise<unknown>
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  url(): string
  title(): Promise<string>
  click(sel: string): Promise<void>
  screenshot(o?: unknown): Promise<unknown>
  close(): Promise<void>
  mouse: { click(x: number, y: number): Promise<void> }
  keyboard: { press(key: string): Promise<void> }
}
type PwBrowser = { newContext(o?: unknown): Promise<{ newPage(): Promise<PwPage>; close(): Promise<void> }>; close(): Promise<void> }

export interface FakeEgoLog {
  keys: string[]
  clicks: string[]
  mouse: string[]
  pastes: string[]
  gotos: string[]
  finished: { keep: unknown }[]
  spaces: string[]
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<void>

/** 仓库根下的 Playwright（与截图脚本同一份）。 */
export async function launchChromium(root: string): Promise<PwBrowser> {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const pw = require(join(root, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright')) as {
    chromium: { launch(o: unknown): Promise<PwBrowser> }
  }
  return pw.chromium.launch({ headless: true })
}

export function playwrightEgo(
  browser: PwBrowser,
  options: { rewrite(url: string): string; fastWaits?: boolean },
): { spawn: EgoSpawn; log: FakeEgoLog } {
  const log: FakeEgoLog = { keys: [], clicks: [], mouse: [], pastes: [], gotos: [], finished: [], spaces: [] }
  let spaceSeq = 0
  const spawn: EgoSpawn = async ({ stdin }) => {
    const t0 = Date.now()
    const out: string[] = []
    const err: string[] = []
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } })
    const pages: PwPage[] = []
    const fakeConsole = {
      log: (...a: unknown[]) => out.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => err.push(a.map(String).join(' ')),
      warn: (...a: unknown[]) => err.push(a.map(String).join(' ')),
    }
    const wrap = (p: PwPage) => ({
      label: 'p1',
      goto: async (u: string, o?: { timeout?: number }) => {
        log.gotos.push(u)
        return p.goto(options.rewrite(u), { timeout: o?.timeout ?? 30_000 })
      },
      waitForTimeout: (ms: number) => p.waitForTimeout(options.fastWaits === false ? ms : Math.min(ms, 80)),
      evaluate: (fn: unknown, arg?: unknown) => p.evaluate(fn, arg),
      url: () => p.url(),
      title: () => p.title(),
      click: async (sel: string, o?: { label?: string }) => {
        log.clicks.push(`${sel}|${o?.label ?? ''}`)
        await p.click(sel)
      },
      screenshot: (o?: unknown) => p.screenshot(o),
      snapshot: async () => '',
      mouse: {
        click: async (x: number, y: number, o?: { label?: string }) => {
          log.mouse.push(`${Math.round(x)},${Math.round(y)}|${o?.label ?? ''}`)
          await p.mouse.click(x, y)
        },
      },
      keyboard: {
        press: async (key: string) => {
          log.keys.push(key)
          if (/\+C$/u.test(key)) {
            const before = (await p.evaluate('window.__copyEvents || 0')) as number
            await p.keyboard.press(key)
            const after = (await p.evaluate('window.__copyEvents || 0')) as number
            // 无头 Chromium 有时不把 Meta+C 变成复制事件：照真浏览器的样子补一个（页面照样在 copy 事件里 setData）
            if (after === before)
              await p.evaluate(() =>
                document.dispatchEvent(
                  new ClipboardEvent('copy', {
                    clipboardData: new DataTransfer(),
                    bubbles: true,
                    cancelable: true,
                  }),
                ),
              )
            return
          }
          await p.keyboard.press(key)
        },
        paste: async (input: string | { text: string }) => {
          const text = typeof input === 'string' ? input : input.text
          log.pastes.push(text)
          await p.evaluate((t: string) => {
            const dt = new DataTransfer()
            // 不经 setData（脚本把它截住了）：原生粘贴也不经页面的 setData
            dt.items.add(t, 'text/plain')
            document.dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
            )
          }, text)
        },
      },
    })
    const taskSpace = async (name: string) => {
      log.spaces.push(name)
      spaceSeq += 1
      const spaceId = spaceSeq
      const real = await ctx.newPage()
      pages.push(real)
      const page = wrap(real)
      return {
        spaceId,
        page: (_label: string) => page,
        finish: async (o: { keep: unknown }) => {
          log.finished.push(o)
          for (const p of pages) await p.close().catch(() => undefined)
        },
      }
    }
    let exit = 0
    try {
      // vitest 的沙箱里 `new Function` 里不能 `import()`：换成本进程递进去的那一个（真 ego 照原样 import）
      const body = (stdin ?? '').replace(/await import\(/gu, 'await __import(')
      const run = new AsyncFunction('taskSpace', 'console', '__import', body)
      await run(taskSpace, fakeConsole, (m: string) => import(m))
    } catch (e) {
      exit = 1
      // 最后一行是原因（与真 ego 一样：调用方取 stderr 最后一行）
      if (e instanceof Error && e.stack !== undefined) err.push(e.stack)
      err.push(e instanceof Error ? e.message : String(e))
    } finally {
      await ctx.close().catch(() => undefined)
    }
    const res: EgoProcessResult = {
      exit_code: exit,
      timed_out: false,
      duration_ms: Date.now() - t0,
      stdout: out.join('\n'),
      stderr: err.join('\n'),
    }
    return res
  }
  return { spawn, log }
}
