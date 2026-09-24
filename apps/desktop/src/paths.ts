/**
 * 用户数据目录布局。真实路径由 Electron `app.getPath('userData')` 给
 * （macOS `~/Library/Application Support/agentsws`、Windows `%APPDATA%\agentsws`）；
 * 这里只做纯粹的路径拼装，测试里传一个临时目录即可。
 */
import { join } from 'node:path'

export interface DesktopPaths {
  /** `app.getPath('userData')`。 */
  userData: string
  /** 配置文件；**不含任何密钥**。 */
  configFile: string
  /** safeStorage 密文；明文永不落盘。 */
  secretsFile: string
  /** 急停档位（托盘"暂停"写它，服务进程下次启动经 `AGENTSWS_HALT` 读它）。 */
  haltFile: string
  logDir: string
  /** 桌面壳自己的日志。 */
  logFile: string
  /** 服务进程日志（子进程 stdout / stderr，脱敏后）。 */
  serverLogFile: string
  /** 传给服务进程的 `AGENTSWS_DB_DIR`。 */
  serverDataDir: string
  /**
   * WP136（docs/79）：我们自己的 `DSH_HOME`——dsh 的各个场景（Profile）与本机凭据库都在这里。
   * 与 `data/` 平级而不是在它里面（备份 / 导出不把它打进去），也**不是** `~/.dsh`
   * （用户另装的那份 dsh 用它自己的，两个版本互不改配置）。
   */
  dshHome: string
}

/**
 * WP148：安装包里的第三方许可证说明（`scripts/after-pack.mjs` 写到 `<resources>/licenses/`）。
 * 没打包（开发时直接跑）就没有这个目录——回 `undefined`，托盘上那一项不出现。
 */
export function thirdPartyLicensesFile(resourcesPath: string | undefined): string | undefined {
  return resourcesPath === undefined
    ? undefined
    : join(resourcesPath, 'licenses', 'THIRD_PARTY_LICENSES.txt')
}

export function desktopPaths(userData: string): DesktopPaths {
  const logDir = join(userData, 'logs')
  return {
    userData,
    configFile: join(userData, 'config.json'),
    secretsFile: join(userData, 'secrets.bin'),
    haltFile: join(userData, 'halt.json'),
    logDir,
    logFile: join(logDir, 'desktop.log'),
    serverLogFile: join(logDir, 'server.log'),
    serverDataDir: join(userData, 'data'),
    dshHome: join(userData, 'dsh'),
  }
}
