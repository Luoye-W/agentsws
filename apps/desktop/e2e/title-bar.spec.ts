/**
 * WP424（Luoye 10-19 真机）：主窗口藏了系统标题栏，窗口按钮嵌进工作台自己的顶栏（学 Claude 桌面版）。
 *
 * 判据（Mac / Windows；Linux 照旧系统标题栏，只验桥上没有 `titleBar`）：
 * - 桥上有 `titleBar`，样子对（Mac `inset` / Windows `overlay`）；
 * - 工作台顶栏 44px、是拖动区（`-webkit-app-region: drag`），上面的按钮不是；
 * - Mac：左栏顶部那一行与顶栏同高、左边给红绿灯留出 84px；
 * - 首次设置那几屏照样在外壳里（顶栏能拖）。
 *
 * 设 `AGENTSWS_WP424_SHOTS=<目录>` 时顺手拍图（浅 / 深各一套：接上 AI、选岗位全选、连接清单）；
 * Mac 上再用 `screencapture -l <窗口号>` 连红绿灯一起拍整窗（没有屏幕录制权限时那几张会是空的，不算失败）。
 * 端口用 `AGENTSWS_E2E_PORT`（不给就随便挑一个空的）。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('藏了系统标题栏：顶栏是拖动区、Mac 左栏顶部给红绿灯留位置', async () => {
  const port = await freePort()
  const userData = mkdtempSync(join(tmpdir(), 'agentsws-desktop-titlebar-'))
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ port, openInBrowser: false, launchAtLogin: false, language: 'zh-CN' }),
  )
  const shots = process.env.AGENTSWS_WP424_SHOTS
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
      await (globalThis as MainGlobal).__agentsws__?.openWorkstation('/onboarding')
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    const win = await app.browserWindow(page)
    await win.evaluate((w) => {
      w.setContentSize(1280, 820)
    })

    const style = await page.evaluate(
      () =>
        (window as unknown as { agentsws?: { titleBar?: { style: string } } }).agentsws?.titleBar
          ?.style,
    )
    if (process.platform === 'linux') {
      expect(style).toBeUndefined()
      return
    }
    expect(style).toBe(process.platform === 'darwin' ? 'inset' : 'overlay')

    await page.getByTestId('onboarding-ai').waitFor({ timeout: 60_000 })
    const bar = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="top-bar"]') as HTMLElement
      const region = (e: Element) =>
        getComputedStyle(e).getPropertyValue('-webkit-app-region') ||
        (getComputedStyle(e) as unknown as Record<string, string>).webkitAppRegion
      const button = el.querySelector('button')
      const brand = document.querySelector('[data-testid="rail-brand-row"]') as HTMLElement | null
      return {
        height: el.getBoundingClientRect().height,
        region: region(el),
        button: button === null ? undefined : region(button),
        brand:
          brand === null
            ? undefined
            : {
                height: brand.getBoundingClientRect().height,
                paddingLeft: getComputedStyle(brand).paddingLeft,
                region: region(brand),
              },
      }
    })
    expect(bar.height).toBe(44)
    expect(bar.region).toBe('drag')
    if (bar.button !== undefined) expect(bar.button).toBe('no-drag')
    if (process.platform === 'darwin') {
      expect(bar.brand?.height).toBe(44)
      expect(bar.brand?.paddingLeft).toBe('84px')
      expect(bar.brand?.region).toBe('drag')
    }

    if (shots === undefined) return
    const windowId = Number(
      /^window:(\d+):/.exec(await win.evaluate((w) => w.getMediaSourceId()))?.[1] ?? '0',
    )
    const shoot = async (label: string) => {
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(shots, `${label}.png`) })
      if (process.platform === 'darwin' && windowId > 0) {
        try {
          execFileSync('screencapture', [
            '-x',
            '-o',
            `-l${String(windowId)}`,
            join(shots, `${label}-window.png`),
          ])
        } catch {
          // 没有屏幕录制权限：只有网页那一张
        }
      }
    }
    const setTheme = async (theme: 'light' | 'dark') => {
      await page.evaluate((t) => {
        localStorage.setItem('agentsws.theme', t)
      }, theme)
    }

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(theme)
      await page.goto(page.url().replace(/\/[^/]*$/, '/onboarding'))
      await page.getByTestId('onboarding-ai').waitFor({ timeout: 60_000 })
      await page.getByTestId('ai-card-account').waitFor()
      await shoot(`${theme}-1-ai`)
      // 「用我自己的模型接口」点开，换一家预设（表单跟着换）
      await page.getByTestId('ai-pick-own').click()
      const presets = page.getByTestId('ai-own-templates')
      if (await presets.isVisible()) {
        await presets.getByText('OpenAI / ChatGPT').click()
      }
      await shoot(`${theme}-1-ai-own-openai`)
      // 先逛逛 → 第 ② 步 → 下一步 → 第 ③ 步
      await page.getByTestId('ai-demo').click()
      await page.getByTestId('onboarding-business').waitFor()
      await page.getByTestId('onboarding-next').click()
      await page.getByTestId('onboarding-roles').waitFor()
      const web = page.locator(
        '[data-testid="onboarding-category-toggle"][data-category="web-ops"]',
      )
      await web.click()
      await page.locator('[data-testid="onboarding-category-all"][data-category="web-ops"]').click()
      await shoot(`${theme}-3-roles-all`)
      await page.getByTestId('onboarding-next').click()
      await page.getByTestId('onboarding-plan').waitFor({ timeout: 30_000 })
      const optional = page.getByTestId('onboarding-plan-optional-toggle')
      if (await optional.isVisible()) await optional.click()
      await shoot(`${theme}-4-plan`)
    }
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
