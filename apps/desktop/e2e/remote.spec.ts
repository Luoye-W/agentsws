/**
 * 「连接公司服务器」冒烟（WP36 交付 4；40 §1.3、41 §2.1）。
 *
 * 40 §1.3 的验收条：**两台机器，一台跑服务一台只跑桌面壳，能登录**。
 * 这里把那两台机器放进同一个进程树里演：先起一个真的 `apps/server`（当"公司那台"），
 * 再起一个 `mode: 'remote'` 的桌面壳指向它，然后钉住三件事：
 *
 * 1. 壳**一个 sidecar 进程都不拉**（`server().pid` 是空的、状态是 stopped）；
 * 2. 壳**一把本机密钥都不生成**（用户数据目录里没有 `secrets.bin`）；
 * 3. 窗口直连公司服务器，`/v1/health` 拿得到 ok；托盘上写的是「已连接 …」，
 *    「重启服务」「轮换本机密钥」两项不出现。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

interface TestHandle {
  hasTray(): boolean
  menu(): MenuItem[]
  serverUrl(): string
  health(): { ok: boolean } | undefined
  server(): { state: string; pid?: number }
  mode(): 'local' | 'remote'
  openWorkstation(path?: string): Promise<string>
  invoke(action: string): void
}

type MainGlobal = { __agentsws__?: TestHandle }

test('remote 模式：不拉 sidecar、不生成本机密钥，窗口直连公司服务器', async () => {
  const port = await freePort()
  // ①「公司那台机器」：一个真的服务进程，自己的数据目录
  const companyData = mkdtempSync(join(tmpdir(), 'agentsws-company-'))
  const { createServer: createAgentswsServer } = (await import('@agentsws/server')) as {
    createServer: (o: Record<string, unknown>) => Promise<{
      listen: (p?: number) => Promise<{ url: string }>
      close: () => Promise<void>
    }>
  }
  const company = await createAgentswsServer({ quiet: true, dbDir: companyData })
  const { url: companyUrl } = await company.listen(port)

  // ②「员工电脑」：只有壳，配置里写死 remote
  const userData = mkdtempSync(join(tmpdir(), 'agentsws-desktop-remote-'))
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({
      port: 0,
      openInBrowser: false,
      launchAtLogin: false,
      language: 'zh-CN',
      mode: 'remote',
      serverUrl: companyUrl,
    }),
  )

  const app = await electron.launch({
    args: [join(root, 'dist', 'main.js')],
    env: { ...process.env, AGENTSWS_DESKTOP_USER_DATA: userData },
  })

  try {
    await expect
      .poll(() => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.hasTray() ?? false), {
        timeout: 30_000,
      })
      .toBe(true)

    // 1. 这一档就是 remote，而且窗口连的是公司那台
    expect(await app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.mode())).toBe('remote')
    expect(await app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.serverUrl())).toBe(
      companyUrl,
    )

    // 2. **一个 sidecar 进程都没有**（40 §1.3 那句话就落在这一行）
    const sidecar = await app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.server())
    expect(sidecar?.state).toBe('stopped')
    expect(sidecar?.pid).toBeUndefined()

    // 3. 本机一把密钥都没生成
    expect(existsSync(join(userData, 'secrets.bin'))).toBe(false)

    // 4. 健康探到的是公司那台
    await expect
      .poll(
        () => app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.health()?.ok ?? false),
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true)

    // 5. 托盘：说「已连接」，两项本机运维不出现
    const menu = await app.evaluate(() => (globalThis as MainGlobal).__agentsws__?.menu() ?? [])
    const ids = menu.map((item) => item.id)
    expect(ids).not.toContain('restart-server')
    expect(ids).not.toContain('rotate-secrets-key')
    expect(menu.some((item) => item.label.includes('已连接'))).toBe(true)

    // 6. 窗口直连公司服务器（登录走它自己的邀请链接 / magic-link，壳不换会话）
    const url = await app.evaluate(async (_api, path: string) => {
      const handle = (globalThis as MainGlobal).__agentsws__
      return handle === undefined ? '' : await handle.openWorkstation(path)
    }, '/v1/health')
    expect(url).toBe(`${companyUrl}/v1/health`)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const body = await page.evaluate(() => document.body.innerText)
    expect(JSON.parse(body).data.status).toBe('ok')

    // 7. 壳退出之后，公司那台照常活着——它不归这台电脑管
    await app.close()
    expect((await (await fetch(`${companyUrl}/v1/health`)).json()).data.status).toBe('ok')
  } finally {
    await app.close().catch(() => undefined)
    await company.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(companyData, { recursive: true, force: true })
  }
})
