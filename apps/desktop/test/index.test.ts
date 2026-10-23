import { readFileSync } from 'node:fs'
/** 桶文件与桥接契约：前端只 `import type` 这些东西，改名会立刻在这里露出来。 */
import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS, BRIDGE_KEY, type DesktopBridge } from '../src/bridge-types.js'
import * as desktop from '../src/index.js'
import { memoryFileStore } from '../src/node-files.js'
// 纯类型模块：import 一次让覆盖率统计认得它（编译产物是空的 `export {}`）
import * as ports from '../src/ports.js'

describe('bridge-types', () => {
  it('桥面只有这几件能力（13 §5：桥接层要小；WP184 加了可选的「打开场景」，WP218 加了可选的「更新」）', () => {
    const bridge: Required<DesktopBridge> = {
      platform: 'darwin',
      version: '0.1.0',
      notify: async () => true,
      openExternal: async () => true,
      openScene: async () => ({ ok: true, where: 'window' }),
      update: {
        status: async () => ({ state: 'idle' }),
        onChange: () => () => undefined,
        download: async () => ({ state: 'idle' }),
        install: async () => 'not-ready',
      },
      searchBrowser: {
        pending: async () => null,
        onChange: () => () => undefined,
        place: async () => true,
        dismiss: async () => true,
      },
      // WP361：开机自启
      launchAtLogin: {
        get: async () => false,
        set: async (on) => on,
        onChange: () => () => undefined,
      },
    }
    expect(Object.keys(bridge).sort()).toEqual([
      'launchAtLogin',
      'notify',
      'openExternal',
      'openScene',
      'platform',
      'searchBrowser',
      'update',
      'version',
    ])
  })

  it('挂载名与 IPC 通道固定下来', () => {
    expect(BRIDGE_KEY).toBe('agentsws')
    expect(BRIDGE_CHANNELS).toEqual({
      info: 'agentsws:bridge-info',
      notify: 'agentsws:notify',
      // WP429：点了系统通知把地址交回页面
      notifyClicked: 'agentsws:notify-clicked',
      openExternal: 'agentsws:open-external',
      openScene: 'agentsws:open-scene',
      updateStatus: 'agentsws:update-status',
      updateChanged: 'agentsws:update-changed',
      updateDownload: 'agentsws:update-download',
      updateInstall: 'agentsws:update-install',
      // WP337：有任务在做时页面上三选一
      updateReadiness: 'agentsws:update-readiness',
      updateRestart: 'agentsws:update-restart',
      updateCancelWait: 'agentsws:update-cancel-wait',
      // WP409：下载断了时「去下载页」
      updateOpenPage: 'agentsws:update-open-page',
      // WP426：设置里「检查更新」
      updateCheck: 'agentsws:update-check',
      // WP353：搜索要人介入的那一页
      searchPending: 'agentsws:search-pending',
      searchChanged: 'agentsws:search-changed',
      searchPlace: 'agentsws:search-place',
      searchDismiss: 'agentsws:search-dismiss',
      // WP361：开机自启（设置弹窗里的开关）
      launchAtLoginGet: 'agentsws:launch-at-login-get',
      launchAtLoginSet: 'agentsws:launch-at-login-set',
      launchAtLoginChanged: 'agentsws:launch-at-login-changed',
      // WP358：会话丢了让壳重换
      sessionRenew: 'agentsws:session-renew',
      // WP424：藏了系统标题栏后，Windows 叠加按钮跟主题换色
      titleBarTheme: 'agentsws:title-bar-theme',
      // WP475：反馈框「附上截图」
      captureWindow: 'agentsws:capture-window',
      // WP480：数据放在哪（选文件夹 / 搬家进度 / 删旧目录 / 打开文件夹）
      dataLocationGet: 'agentsws:data-location-get',
      dataLocationChoose: 'agentsws:data-location-choose',
      dataLocationCheckDefault: 'agentsws:data-location-check-default',
      dataLocationMove: 'agentsws:data-location-move',
      dataLocationChanged: 'agentsws:data-location-changed',
      dataLocationDeleteOld: 'agentsws:data-location-delete-old',
      dataLocationReveal: 'agentsws:data-location-reveal',
    })
  })

  it('WP218：preload 里抄的通道名与这里逐字一致（preload 是 CJS，引不了这份常量）', () => {
    const preload = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8')
    for (const channel of Object.values(BRIDGE_CHANNELS)) expect(preload).toContain(`'${channel}'`)
  })

  it('特性检测：普通浏览器里 window.agentsws 不存在，UI 必须能退化', () => {
    const fakeWindow = {} as Window
    expect(fakeWindow.agentsws).toBeUndefined()
  })
})

describe('ports 纯类型模块', () => {
  it('只有类型，运行时是空模块', () => {
    expect(Object.keys(ports)).toEqual([])
  })
})

describe('index 桶文件', () => {
  it('导出各模块的入口', () => {
    for (const name of [
      'createSidecar',
      'createConfigStore',
      'createSecretVault',
      'createHaltControl',
      'createConnectRuntime',
      'createUpdateGate',
      'createLogger',
      'createRedactor',
      'buildTrayMenu',
      'decideNavigation',
      'withCsp',
      'desktopPaths',
      'probeHealth',
      'serverSpawnRequest',
      'backoffDelay',
      'nodeFileStore',
      'memoryFileStore',
      'strings',
      // WP36 / 40 §1.3：本机 / 公司服务器
      'resolveMode',
      'needsWizard',
      'normalizeServerUrl',
      'serverUrlFrom',
      'configPatchOf',
      'companyLabel',
      // WP361
      'createLaunchAtLogin',
      'loginItemSettings',
    ])
      expect(typeof (desktop as Record<string, unknown>)[name]).toBe('function')
  })
})

describe('memoryFileStore', () => {
  it('rename 不存在的文件会抛', () => {
    expect(() => memoryFileStore().rename('/a', '/b')).toThrowError(/ENOENT/)
  })

  it('seed 能预置内容', () => {
    expect(memoryFileStore({ '/a': 'x' }).readText('/a')).toBe('x')
  })
})
