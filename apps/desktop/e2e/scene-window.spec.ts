/**
 * WP184（docs/79 §3.1）：官方场景在我们自己的独立窗口里打开。
 *
 * 起壳（临时用户目录、随机端口、临时工作区）→ 服务健康 → 托盘「切换场景 ▸ web」→
 * 壳里多一个「DeepSeek Harness（官方）」窗口：网址里**没有 token**、页面的 cookie 罐是空的，
 * 同源请求却是 200（凭据由壳在请求发出前补上）；页面上有官方认的原生目录选择，没有工作台的桥；
 * 关窗 = 隐藏。用真的捆绑 dsh（不联网）。
 *
 * 跑之前先 `tsc -b apps/desktop`（e2e 用的是 dist/）。截图存 `docs/assets/desktop/dsh-scene-window.png`。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = dirname(dirname(root))

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

interface MenuItem {
  id: string
  submenu?: MenuItem[]
}

interface TestHandle {
  menu(): MenuItem[]
  health(): { ok: boolean } | undefined
  invoke(action: string, scene?: string): void
  sceneWindows(): { name: string; url: string; title: string; visible: boolean }[]
  skipQuitConfirmation(): void
}

type MainGlobal = { __agentsws__?: TestHandle }

test('官方 web 场景开在壳自己的窗口里：网址不带 token、凭据只由壳补、关窗隐藏', async () => {
  const port = await freePort()
  const userData = mkdtempSync(join(tmpdir(), 'agentsws-desktop-scene-'))
  // 工作区根不能在应用数据目录里（服务进程会拒绝装配场景），单独一个临时目录
  const workspace = mkdtempSync(join(tmpdir(), 'agentsws-desktop-scene-ws-'))
  const fakeOfficialApp = join(userData, 'DeepSeek Harness.app')
  mkdirSync(fakeOfficialApp)
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
      // 其他场景的工作目录放临时目录，不去碰 ~/dsh-workspace
      AGENTSWS_DSH_WORKSPACE: workspace,
      // 把一个空目录当作「用户自己装的官方桌面端」——只看托盘上有没有那一行，不去点它
      AGENTSWS_OFFICIAL_DESKTOP_APP: fakeOfficialApp,
    },
  })

  try {
    await expect
      .poll(
        () => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.health()?.ok ?? false),
        { timeout: 90_000, intervals: [500] },
      )
      .toBe(true)

    // 场景清单 15 秒问一次：等「切换场景」子菜单出现，且带着官方桌面端那一行
    await expect
      .poll(
        () =>
          app.evaluate(() => {
            const sub = (globalThis as MainGlobal).__agentsws__
              ?.menu()
              .find((i) => i.id === 'submenu')
            return (sub?.submenu ?? []).map((i) => i.id)
          }),
        { timeout: 40_000, intervals: [1000] },
      )
      .toEqual(
        expect.arrayContaining([
          'switch-scene',
          'launch-official-desktop',
          'toggle-scene-in-browser',
        ]),
      )

    await app.evaluate(() => {
      ;(globalThis as MainGlobal).__agentsws__?.invoke('switch-scene', 'web')
    })
    await expect
      .poll(
        () => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.sceneWindows() ?? []),
        { timeout: 90_000, intervals: [500] },
      )
      .toEqual([
        expect.objectContaining({
          name: 'web',
          title: 'DeepSeek Harness（官方）',
          visible: true,
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
        }),
      ])

    const page = app.windows().find((w) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(w.url()))
    if (page === undefined) throw new Error('没找到官方场景窗口')
    await page.waitForLoadState('domcontentloaded')
    await expect
      .poll(() => page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0)
    const facts = await page.evaluate(async () => ({
      url: location.href,
      cookie: document.cookie,
      // 同源请求：页面自己没有 cookie，是壳在发出前补上的——拿得到 200 就说明补上了
      status: (await fetch('/', { cache: 'no-store' })).status,
      picker: typeof (window as { __DSH_DIRECTORY_PICKER__?: { pick?: unknown } })
        .__DSH_DIRECTORY_PICKER__?.pick,
      hostPaths: typeof (window as { __DSH_HOST_PATHS__?: { pathFor?: unknown } })
        .__DSH_HOST_PATHS__?.pathFor,
      bridge: typeof (window as { agentsws?: unknown }).agentsws,
    }))
    expect(facts.url).not.toContain('token')
    expect(facts.cookie).toBe('')
    expect(facts.status).toBe(200)
    expect(facts.picker).toBe('function')
    expect(facts.hostPaths).toBe('function')
    expect(facts.bridge).toBe('undefined')

    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(repo, 'docs', 'assets', 'desktop', 'dsh-scene-window.png') })

    // 关窗 = 隐藏：窗口还在（场景照跑），只是不显示
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle().startsWith('DeepSeek Harness'))
        ?.close()
    })
    await expect
      .poll(
        () => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.sceneWindows() ?? []),
        { timeout: 10_000 },
      )
      .toEqual([expect.objectContaining({ name: 'web', visible: false })])
  } finally {
    await app.evaluate(() => {
      ;(globalThis as MainGlobal).__agentsws__?.skipQuitConfirmation()
    })
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
