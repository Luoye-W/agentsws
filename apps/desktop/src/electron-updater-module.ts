/**
 * WP225：从 `electron-updater` 模块里拿 `autoUpdater`。
 *
 * 为什么要单独一个函数：`electron-updater` 是 CJS，`autoUpdater` 在它的 `main.js` 里是**惰性 getter**
 * （`Object.defineProperty(exports, 'autoUpdater', { get: () => _autoUpdater || doLoadAutoUpdater() })`）。
 * Node 从 ESM `import()` 一个 CJS 包时靠 cjs-module-lexer 静态认具名导出，这种 getter 它认不出——
 * 所以 `const { autoUpdater } = await import('electron-updater')` 拿到的是 **undefined**，
 * 只有 `default`（也就是 `module.exports`）上才有。WP218 的安装包在 Windows 真机上就是这么坏的：
 * `Cannot set properties of undefined (setting 'autoDownload')`。
 *
 * 这里只认「哪个对象上**有**这个属性」，不去读它：读 getter 会当场 new 一个 NsisUpdater / MacUpdater，
 * 那要 `require('electron')`——打包自检（`scripts/after-pack.mjs`）是用捆绑的 Node 跑的，没有 electron。
 */

/** 模块命名空间里，真正挂着 `autoUpdater` 的那个对象（具名导出那层，或 `default` 那层）。 */
export function autoUpdaterHolder(mod: unknown): Record<string, unknown> | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined
  const ns = mod as Record<string, unknown>
  // `in` 不触发 getter；具名导出层若在，值也是同一个 getter
  if ('autoUpdater' in ns && ns.autoUpdater !== undefined) return ns
  const cjs = ns.default
  if (typeof cjs === 'object' && cjs !== null && 'autoUpdater' in cjs)
    return cjs as Record<string, unknown>
  return undefined
}

/**
 * 取出 `autoUpdater`（这一步会触发 getter，只在 Electron 主进程里调）。拿不到就抛错——
 * 抛出来的话写进日志的是这一句，而不是三行之后的「Cannot set properties of undefined」。
 */
export async function loadAutoUpdater<T>(importer: () => Promise<unknown>): Promise<T> {
  const holder = autoUpdaterHolder(await importer())
  const updater = holder?.autoUpdater
  if (typeof updater !== 'object' || updater === null)
    throw new Error('electron-updater 里没有 autoUpdater（安装包里的依赖不全？）')
  return updater as T
}
