/**
 * electron-builder 的 `afterExtract` 钩子（WP148）。
 *
 * Electron 发行包刚解到输出目录的那一刻，根目录里有它自带的两份许可证：`LICENSE`（Electron，MIT）
 * 与 `LICENSES.chromium.html`（Chromium 及其全部依赖）。**mac 上 electron-builder 之后会把它们丢掉**
 * （只留 `.app`，实测 26.15.3），`afterPack` 那一刻已经找不到了——所以在这里先存一份到
 * `<输出目录的上一级>/.electron-licenses/<输出目录名>/`，`after-pack.mjs` 再拷进
 * `<resources>/licenses/`，拷完删掉存档。win / linux 上它们本来就留着，存一份也无妨。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Electron 发行包根目录里的那两份。 */
export const ELECTRON_DIST_LICENSES = ['LICENSE', 'LICENSES.chromium.html']

/** 存档目录：放在输出目录外面，免得被当成安装包的一部分。 */
export function stashDirOf(appOutDir) {
  return join(dirname(appOutDir), '.electron-licenses', basename(appOutDir))
}

/** 把找得到的那几份存下来；回存了哪些。 */
export function stashElectronLicenses(appOutDir) {
  const stash = stashDirOf(appOutDir)
  const saved = []
  for (const name of ELECTRON_DIST_LICENSES) {
    const source = join(appOutDir, name)
    if (!existsSync(source)) continue
    mkdirSync(stash, { recursive: true })
    copyFileSync(source, join(stash, name))
    saved.push(name)
  }
  return saved
}

export default async function afterExtract(context) {
  const saved = stashElectronLicenses(context.appOutDir)
  process.stdout.write(
    `  • afterExtract 存下 Electron 自带的许可证：${saved.join(', ') || '没找到'}\n`,
  )
}
