/**
 * 安装包里那份 Node 与那几个原生模块住在哪（WP111；13 §5「一个安装包把运行时带齐」）。
 *
 * `scripts/fetch-node.mjs` 把它们下到 `vendor/`，`electron-builder.yml` 的 `extraResources`
 * 把当前平台那一份摆进 `<resources>/node`；这里只回答"打包之后去哪儿找"，不碰文件系统
 * （`exists` 是注入的，所以四个平台的判定都能在 vitest 里跑）。
 *
 * **纪律：一份 Node，一套 ABI。** 捆绑的是 Node 22（`NODE_MODULE_VERSION` 127），
 * 一起带的 `better_sqlite3.node` 就必须是 v127 那一份——用开发机 Node 25 编出来的
 * 那份塞进去只会在用户那儿炸 `ERR_DLOPEN_FAILED`，而且是启动时炸。
 * 这条由 `scripts/after-pack.mjs` 在打包那一刻换文件保证，不靠运行期发现。
 */
import { join } from 'node:path'

/** 捆绑 Node 的 ABI（`node-runtime.lock.json` 的 `node.abi`；两处改要一起改）。 */
export const BUNDLED_NODE_ABI = 127

/** 捆绑 Node 的主版本（README 与 docs/62 里写的那个「不用装 Node」就是它）。 */
export const BUNDLED_NODE_MAJOR = 22

/**
 * `<resources>` 下找捆绑 Node 的顺序。
 *
 * 三条候选而不是一条：`vendor/node/<平台>/` 里 Windows 是平铺的 `node.exe`、
 * 其余平台是 `bin/node`；第三条是 WP16 留下的"直接摆一个叫 `node` 的文件"——
 * 那时还没有这个脚本，留着不碍事，换掉一个用户的旧安装反而更糟。
 */
export function bundledNodeCandidates(resourcesPath: string, platform: string): string[] {
  const dir = join(resourcesPath, 'node')
  return platform === 'win32'
    ? [join(dir, 'node.exe'), join(resourcesPath, 'node.exe'), dir]
    : [join(dir, 'bin', 'node'), join(dir, 'node'), dir]
}

/** 第一条存在的赢；一条都不存在 → undefined（调用方退回 `PATH` 上的 node）。 */
export function findBundledNode(
  resourcesPath: string | undefined,
  platform: string,
  exists: (path: string) => boolean,
): string | undefined {
  if (resourcesPath === undefined || resourcesPath === '') return undefined
  for (const candidate of bundledNodeCandidates(resourcesPath, platform)) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * `vendor/natives/<平台>/<包>/<版本>/build/Release/<文件>.node` 里的 `<平台>` 段。
 *
 * 就是 `process.platform`-`process.arch`；单独一个函数是为了让脚本与运行期
 * 说的是同一句话（脚本那边按同一个名字建目录）。
 */
export function nativeTarget(platform: string, arch: string): string {
  return `${platform}-${arch}`
}
