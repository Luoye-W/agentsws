/** 桶文件与桥接契约：前端只 `import type` 这些东西，改名会立刻在这里露出来。 */
import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS, BRIDGE_KEY, type DesktopBridge } from '../src/bridge-types.js'
import * as desktop from '../src/index.js'
import { memoryFileStore } from '../src/node-files.js'
// 纯类型模块：import 一次让覆盖率统计认得它（编译产物是空的 `export {}`）
import * as ports from '../src/ports.js'

describe('bridge-types', () => {
  it('桥面只有四件能力（13 §5：桥接层要小）', () => {
    const bridge: DesktopBridge = {
      platform: 'darwin',
      version: '0.1.0',
      notify: async () => true,
      openExternal: async () => true,
    }
    expect(Object.keys(bridge).sort()).toEqual(['notify', 'openExternal', 'platform', 'version'])
  })

  it('挂载名与 IPC 通道固定下来', () => {
    expect(BRIDGE_KEY).toBe('agentsws')
    expect(BRIDGE_CHANNELS).toEqual({
      info: 'agentsws:bridge-info',
      notify: 'agentsws:notify',
      openExternal: 'agentsws:open-external',
    })
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
