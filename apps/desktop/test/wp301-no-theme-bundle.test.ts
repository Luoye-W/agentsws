/**
 * WP301（决策 399 = A）：安装包里**不带任何 Shopify 主题代码**。
 *
 * 我们自己的主题（agentsws-theme）已改闭源；建站岗位改用店铺里 Shopify 官方的 Horizon（起底时在店里复制一份）。
 * 这里守住「打包 / 发版不再去 GitHub 取主题包、安装包里没有 theme-base、服务进程不再拿兜底包目录」。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateSecrets } from '../src/secrets.js'
import { type ServerSpawnInput, serverSpawnRequest } from '../src/server-process.js'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..', '..')
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')

describe('WP301：安装包不带主题', () => {
  it('取主题包的脚本没了', () => {
    expect(existsSync(join(desktop, 'scripts', 'fetch-theme-base.mjs'))).toBe(false)
  })

  it('electron-builder / dist / afterPack / Windows 装包冒烟都不再碰 theme-base', () => {
    for (const rel of [
      'apps/desktop/electron-builder.yml',
      'apps/desktop/scripts/dist.mjs',
      'apps/desktop/scripts/after-pack.mjs',
      'apps/desktop/scripts/win-install-smoke.mjs',
    ])
      expect(read(rel), rel).not.toMatch(/theme-base|fetchThemeBase|agentsws-theme/)
  })

  it('两个 workflow 打包前不再取主题包（也不缓存它）', () => {
    for (const rel of ['.github/workflows/desktop-windows.yml', '.github/workflows/release.yml']) {
      const text = read(rel)
      expect(text, rel).not.toMatch(/fetch-theme-base|theme-base|agentsws-theme/)
    }
  })

  it('服务进程不再拿兜底包目录（AGENTSWS_THEME_BASE_DIR 不设，服务端也不认）', () => {
    const input: ServerSpawnInput = {
      runtime: { kind: 'electron', execPath: '/Applications/agentsws.app/Contents/MacOS/agentsws' },
      entry: '/opt/server/dist/index.js',
      port: 4317,
      dataDir: '/data',
      halt: [],
      secrets: generateSecrets((n) => new Uint8Array(n).fill(7)),
      version: '0.1.0',
      baseEnv: { PATH: '/usr/bin' },
    }
    expect(serverSpawnRequest(input).env.AGENTSWS_THEME_BASE_DIR).toBeUndefined()
    expect(read('apps/server/src/server.ts')).not.toMatch(/AGENTSWS_THEME_BASE_DIR/)
  })
})
