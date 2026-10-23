/**
 * WP481（决策 1632）：右栏开着时主窗口向右加宽、关掉缩回；最大化时不动窗口、回 overlay（页面改浮层）。
 *
 * 直接调桥上的 `sidePane.sync`（页面那一侧怎么用它由工作台的单测与 `scripts/e2e-wp481-shots.mjs` 管），
 * 这里钉的是主进程那一截：通道接上了、只给主窗口、窗口真的变宽 / 缩回、左边位置不动、最大化走浮层。
 * 端口用 `AGENTSWS_E2E_PORT`（不给就随便挑一个空的）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function freePort(): Promise<number> {
  const wanted = Number(process.env.AGENTSWS_E2E_PORT ?? '0')
  if (wanted > 0) return Promise.resolve(wanted)
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
type SidePaneWindow = Window & {
  agentsws?: { sidePane?: { sync(width: number | null): Promise<string> } }
}

test('右栏开着窗口向右加宽、关掉缩回；最大化时回 overlay', async () => {
  const port = await freePort()
  const userData = mkdtempSync(join(tmpdir(), 'agentsws-desktop-sidepane-'))
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ port, openInBrowser: false, launchAtLogin: false, language: 'zh-CN' }),
  )
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
      await (globalThis as MainGlobal).__agentsws__?.openWorkstation('/onboarding')
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    const win = await app.browserWindow(page)
    // 放在屏幕左上、留出右边的地方
    await win.evaluate((w) => {
      w.setBounds({ x: 40, y: 60, width: 1000, height: 700 })
    })
    const bounds = () => win.evaluate((w) => w.getBounds())
    const sync = (width: number | null) =>
      page.evaluate((w) => (window as SidePaneWindow).agentsws?.sidePane?.sync(w), width)

    expect(await page.evaluate(() => typeof (window as SidePaneWindow).agentsws?.sidePane)).toBe(
      'object',
    )
    const before = await bounds()
    expect(await sync(300)).toBe('widened')
    const widened = await bounds()
    expect(widened.x).toBe(before.x)
    expect(widened.width).toBe(before.width + 300)
    expect(await sync(null)).toBe('none')
    expect((await bounds()).width).toBe(before.width)

    // 最大化：不动窗口，回 overlay
    await win.evaluate((w) => {
      w.maximize()
    })
    await expect.poll(() => win.evaluate((w) => w.isMaximized())).toBe(true)
    const max = await bounds()
    expect(await sync(300)).toBe('overlay')
    expect((await bounds()).width).toBe(max.width)
    expect(await sync(null)).toBe('none')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
