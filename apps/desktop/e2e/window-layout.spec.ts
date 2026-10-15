/**
 * WP339：主窗口换大小 / 最大化 / 还原之后，网页必须铺满窗口并重新排版。
 *
 * Luoye 10-15 在 Windows 真机上见过：拖了窗口大小之后，界面停在左上一块、右边和下边留白，
 * 再怎么拖也不跟着变（重启后恢复）。这条把「窗口内容区 = 网页视口 = 页面根容器」钉成断言，
 * 在 mac 本机和 Windows CI（desktop-windows.yml）上都跑。
 *
 * 判据（都按 CSS 像素，容差 2）：
 * - 网页视口（innerWidth / innerHeight × 缩放）= 窗口内容区（getContentBounds）
 * - <html> 的宽高 = 视口（根元素没有被谁钉成固定尺寸）
 * - 外壳左栏（在的话）上下顶满视口；右侧图标轨（在的话）贴着视口右边
 *
 * 设 `AGENTSWS_LAYOUT_SHOTS=<目录>` 时每一步顺手截一张图（报告用）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, type Page, test } from '@playwright/test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        resolve(port)
      })
    })
  })
}

interface TestHandle {
  health(): { ok: boolean } | undefined
  openWorkstation(path?: string): Promise<string>
}
type MainGlobal = { __agentsws__?: TestHandle }

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Measure {
  content: Rect
  zoom: number
  innerWidth: number
  innerHeight: number
  html: { width: number; height: number }
  aside: Rect | null
  rail: Rect | null
  dpr: number
}

/** 网页这一侧量一次：视口、根元素、左栏、右侧图标轨。 */
async function measurePage(page: Page): Promise<Omit<Measure, 'content' | 'zoom'>> {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (el === null) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const html = document.documentElement
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      html: { width: html.clientWidth, height: html.clientHeight },
      aside: rect(document.querySelector('aside')),
      // 右侧 44px 图标轨（right-rail.tsx：sticky h-screen w-11）
      rail: rect(document.querySelector('[data-testid="right-rail"]')),
      dpr: window.devicePixelRatio,
    }
  })
}

const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol

test('换窗口大小 / 最大化 / 还原后，网页铺满窗口并重新排版', async () => {
  const port = await freePort()
  const userData = mkdtempSync(join(tmpdir(), 'agentsws-desktop-layout-'))
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ port, openInBrowser: false, launchAtLogin: false, language: 'zh-CN' }),
  )
  const shots = process.env.AGENTSWS_LAYOUT_SHOTS
  if (shots !== undefined) mkdirSync(shots, { recursive: true })

  const app = await electron.launch({
    args: [join(root, 'dist', 'main.js')],
    env: {
      ...process.env,
      AGENTSWS_DESKTOP_USER_DATA: userData,
      AGENTSWS_CONNECT_URL: `http://127.0.0.1:${port + 1}`,
      AGENTSWS_DESKTOP_BROWSER_EXECUTABLE: join(userData, 'no-such-chrome'),
    },
  })

  try {
    await expect
      .poll(
        () => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.health()?.ok ?? false),
        { timeout: 90_000, intervals: [500] },
      )
      .toBe(true)
    await app.evaluate(async () => {
      await (globalThis as MainGlobal).__agentsws__?.openWorkstation('/')
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    const win = await app.browserWindow(page)

    /** 让主进程把窗口摆成某个样子，等 resize 落定、网页跟上，再两边各量一次。 */
    const step = async (label: string, act: string, size?: [number, number]) => {
      await win.evaluate(
        (w, input) =>
          new Promise<void>((resolve) => {
            const done = () => setTimeout(resolve, 400)
            if (input.act === 'maximize') {
              if (w.isMaximized()) return done()
              w.once('maximize', done)
              w.maximize()
            } else if (input.act === 'unmaximize') {
              if (!w.isMaximized()) return done()
              w.once('unmaximize', done)
              w.unmaximize()
            } else if (input.size !== undefined) {
              w.setContentSize(input.size[0], input.size[1])
              done()
            }
            // 保底：有的窗口管理器不发事件
            setTimeout(resolve, 3000)
          }),
        { act, ...(size === undefined ? {} : { size }) },
      )
      await expect
        .poll(
          async () => {
            const [content, zoom] = await win.evaluate((w) => [
              w.getContentBounds(),
              w.webContents.getZoomFactor(),
            ])
            const p = await measurePage(page)
            return (
              near(p.innerWidth * (zoom as number), (content as Rect).width) &&
              near(p.innerHeight * (zoom as number), (content as Rect).height)
            )
          },
          { timeout: 10_000, intervals: [200] },
        )
        .toBe(true)
      const [content, zoom] = (await win.evaluate((w) => [
        w.getContentBounds(),
        w.webContents.getZoomFactor(),
      ])) as [Rect, number]
      const m: Measure = { content, zoom, ...(await measurePage(page)) }
      if (shots !== undefined) await page.screenshot({ path: join(shots, `${label}.png`) })
      return m
    }

    const checks: Array<[string, string, [number, number]?]> = [
      ['01-default', 'size', [1280, 800]],
      ['02-wide', 'size', [1600, 1000]],
      ['03-small', 'size', [960, 640]],
      ['04-narrow', 'size', [720, 600]],
      ['05-maximized', 'maximize'],
      ['06-restored', 'unmaximize'],
      ['07-back-to-wide', 'size', [1500, 900]],
    ]
    for (const [label, act, size] of checks) {
      const m = await step(label, act, size)
      const info = `${label}: ${JSON.stringify(m)}`
      // 根元素 = 视口（没有被固定尺寸钉住，也没有比视口小一截）
      expect(near(m.html.width, m.innerWidth, 20), info).toBe(true) // 竖滚动条最多吃掉十几像素
      expect(near(m.html.height, m.innerHeight), info).toBe(true)
      if (m.aside !== null) {
        expect(near(m.aside.y, 0), info).toBe(true)
        expect(near(m.aside.height, m.innerHeight), info).toBe(true)
      }
      if (m.rail !== null) {
        expect(near(m.rail.x + m.rail.width, m.html.width), info).toBe(true)
        expect(near(m.rail.height, m.innerHeight), info).toBe(true)
      }
      console.log(info)
    }
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
