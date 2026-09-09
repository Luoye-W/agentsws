/**
 * Electron 冒烟（13 §5 的一条主路径）：
 * 起壳 → 托盘在 → 服务 sidecar 真的起来了 → 点"打开工作台" → 窗口拿到 `/v1/health` 的 ok。
 *
 * 服务进程是 `apps/server` 真起的（不是替身），端口随机，用户数据目录用临时目录。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

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

interface MenuItem {
  id: string
  label: string
  enabled: boolean
}

/** main.ts 挂在主进程 global 上的抓手（网页够不着；回调序列化后送进主进程执行）。 */
interface TestHandle {
  hasTray(): boolean
  menu(): MenuItem[]
  serverUrl(): string
  health(): { ok: boolean; status?: string } | undefined
  server(): { state: string }
  openWorkstation(path?: string): Promise<string>
}

type MainGlobal = { __agentsws__?: TestHandle }

test('托盘常驻，打开工作台能拿到 /v1/health 的 ok', async () => {
  const port = await freePort()
  const userData = mkdtempSync(join(tmpdir(), 'agentsws-desktop-e2e-'))
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ port, openInBrowser: false, launchAtLogin: false, language: 'zh-CN' }),
  )

  const app = await electron.launch({
    args: [join(root, 'dist', 'main.js')],
    env: {
      ...process.env,
      AGENTSWS_DESKTOP_USER_DATA: userData,
      // 别去戳真的 OpenConnector：那条路径另有单测。
      AGENTSWS_CONNECT_URL: `http://127.0.0.1:${port + 1}`,
    },
  })

  try {
    // 1. 托盘在，而且此时一个窗口都没有（"无主窗口启动"）
    await expect
      .poll(() => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.hasTray() ?? false), {
        timeout: 30_000,
      })
      .toBe(true)
    expect(app.windows()).toHaveLength(0)

    // 2. 菜单里 13 §5 要求的几项都在
    const ids = await app.evaluate(() => {
      const handle = (globalThis as MainGlobal).__agentsws__
      return handle === undefined ? [] : handle.menu().map((item) => item.id)
    })
    expect(ids).toEqual(
      expect.arrayContaining(['open-workstation', 'open-browser', 'toggle-pause', 'quit']),
    )

    // 3. 服务 sidecar 真起来了（apps/server，随机端口）
    await expect
      .poll(
        () => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.health()?.ok ?? false),
        { timeout: 90_000, intervals: [500] },
      )
      .toBe(true)
    const serverUrl = await app.evaluate(
      () => (globalThis as MainGlobal).__agentsws__?.serverUrl() ?? '',
    )
    expect(serverUrl).toBe(`http://127.0.0.1:${port}`)

    // 4. 点"打开工作台"——窗口加载本地 URL
    const url = await app.evaluate(async (_electronApi, path: string) => {
      const handle = (globalThis as MainGlobal).__agentsws__
      return handle === undefined ? '' : await handle.openWorkstation(path)
    }, '/v1/health')
    expect(url).toBe(`http://127.0.0.1:${port}/v1/health`)

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const body = await page.evaluate(() => document.body.innerText)
    expect(JSON.parse(body).data.status).toBe('ok')

    // 5. 服务健康之后，两个"打开"都可点了
    const openable = await app.evaluate(() => {
      const handle = (globalThis as MainGlobal).__agentsws__
      return handle?.menu().find((item) => item.id === 'open-workstation')?.enabled ?? false
    })
    expect(openable).toBe(true)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
