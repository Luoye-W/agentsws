/**
 * WP111：安装包里那份 Node 找得着吗、找不着退到哪儿。
 *
 * Windows 是第一优先（第一位内测用户用 Windows），所以每条判定都两个平台各跑一遍，
 * 路径里还塞了中文用户名与空格——`C:\Users\小雨 的电脑\AppData\…` 在真机上就是这样。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_NODE_ABI,
  BUNDLED_NODE_MAJOR,
  bundledNodeCandidates,
  findBundledNode,
  nativeTarget,
} from '../src/bundled-node.js'
import { resolveServerRuntime } from '../src/server-process.js'

/** 只认清单里那几条路径存在。 */
const only =
  (...paths: string[]) =>
  (p: string): boolean =>
    paths.includes(p)

const WIN_RESOURCES = 'C:\\Users\\小雨 的电脑\\AppData\\Local\\Programs\\agentsws\\resources'
const MAC_RESOURCES = '/Applications/agentsws.app/Contents/Resources'

describe('bundledNodeCandidates', () => {
  it('Windows 找 node.exe，其余平台找 bin/node', () => {
    expect(bundledNodeCandidates(WIN_RESOURCES, 'win32')[0]).toBe(
      join(WIN_RESOURCES, 'node', 'node.exe'),
    )
    expect(bundledNodeCandidates(MAC_RESOURCES, 'darwin')[0]).toBe(
      join(MAC_RESOURCES, 'node', 'bin', 'node'),
    )
    expect(bundledNodeCandidates(MAC_RESOURCES, 'linux')[0]).toBe(
      join(MAC_RESOURCES, 'node', 'bin', 'node'),
    )
  })

  it('每个平台都留了三条候选（WP16 那种「直接摆一个 node 文件」也还认）', () => {
    expect(bundledNodeCandidates(MAC_RESOURCES, 'darwin')).toHaveLength(3)
    expect(bundledNodeCandidates(WIN_RESOURCES, 'win32')).toHaveLength(3)
  })
})

describe('findBundledNode', () => {
  it('第一条存在的赢', () => {
    const first = bundledNodeCandidates(MAC_RESOURCES, 'darwin')[0] as string
    const second = bundledNodeCandidates(MAC_RESOURCES, 'darwin')[1] as string
    expect(findBundledNode(MAC_RESOURCES, 'darwin', only(first, second))).toBe(first)
    expect(findBundledNode(MAC_RESOURCES, 'darwin', only(second))).toBe(second)
  })

  it('一条都不存在 → undefined', () => {
    expect(findBundledNode(MAC_RESOURCES, 'darwin', () => false)).toBeUndefined()
  })

  it('没打包（resourcesPath 为空）→ undefined，一次文件系统都不问', () => {
    let asked = 0
    const counting = (): boolean => {
      asked += 1
      return true
    }
    expect(findBundledNode(undefined, 'darwin', counting)).toBeUndefined()
    expect(findBundledNode('', 'darwin', counting)).toBeUndefined()
    expect(asked).toBe(0)
  })
})

describe('nativeTarget', () => {
  it('就是 platform-arch —— 脚本建的目录名与运行期读的是同一句话', () => {
    expect(nativeTarget('win32', 'x64')).toBe('win32-x64')
    expect(nativeTarget('darwin', 'arm64')).toBe('darwin-arm64')
  })
})

describe('resolveServerRuntime（WP111 之后）', () => {
  const base = { electronExecPath: '/Applications/agentsws.app/Contents/MacOS/agentsws' }

  it('装好之后走包里那份 Node —— 用户不必自己装 Node', () => {
    const bundled = join(MAC_RESOURCES, 'node', 'bin', 'node')
    expect(
      resolveServerRuntime({
        ...base,
        env: {},
        resourcesPath: MAC_RESOURCES,
        exists: only(bundled),
        platform: 'darwin',
      }),
    ).toEqual({ kind: 'node', execPath: bundled })
  })

  it('Windows 上走 node.exe（路径含中文与空格也一样）', () => {
    const bundled = bundledNodeCandidates(WIN_RESOURCES, 'win32')[0] as string
    expect(
      resolveServerRuntime({
        ...base,
        env: {},
        resourcesPath: WIN_RESOURCES,
        exists: only(bundled),
        platform: 'win32',
      }),
    ).toEqual({ kind: 'node', execPath: bundled })
  })

  it('包里那份不见了 → 退到 PATH 上的 node（退化，不是起不来）', () => {
    expect(
      resolveServerRuntime({
        ...base,
        env: {},
        resourcesPath: WIN_RESOURCES,
        exists: () => false,
        platform: 'win32',
      }),
    ).toEqual({ kind: 'node', execPath: 'node' })
  })

  it('AGENTSWS_NODE 压过包里那份', () => {
    expect(
      resolveServerRuntime({
        ...base,
        env: { AGENTSWS_NODE: '/opt/homebrew/bin/node' },
        resourcesPath: MAC_RESOURCES,
        exists: () => true,
        platform: 'darwin',
      }),
    ).toEqual({ kind: 'node', execPath: '/opt/homebrew/bin/node' })
  })

  it('逃生口：明确要求借 Electron 自带的 Node', () => {
    expect(
      resolveServerRuntime({
        ...base,
        env: { AGENTSWS_SIDECAR_RUNTIME: 'electron' },
        resourcesPath: MAC_RESOURCES,
        exists: () => true,
        platform: 'darwin',
      }),
    ).toEqual({ kind: 'electron', execPath: base.electronExecPath })
  })

  it('不给 platform 就按当前进程的（旧调用点不必改）', () => {
    expect(
      resolveServerRuntime({ ...base, env: {}, resourcesPath: undefined, exists: () => false }),
    ).toEqual({ kind: 'node', execPath: 'node' })
  })
})

describe('捆绑的是哪一版 Node', () => {
  it('ABI 与主版本写死在代码里，和 node-runtime.lock.json 对得上', () => {
    expect(BUNDLED_NODE_MAJOR).toBe(22)
    expect(BUNDLED_NODE_ABI).toBe(127)
  })
})
