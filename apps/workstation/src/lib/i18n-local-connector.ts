/**
 * WP247：本机连接器（按需下载、跟着工作台开关）的文案。单独一张表，免得与别的单在 `i18n.ts` 里撞行。
 * 界面少字（Luoye）：卡面与顶上那一行只一句，长一点的话进问号。
 */
export const LOCAL_CONNECTOR_ZH: Record<string, string> = {
  'connector.local.not_installed': '连接器还没下载',
  'connector.local.not_installed.detail':
    '连店铺、广告和数据后台要用到连接器。它不在安装包里，第一次用时下载一次（约 {mb} MB），之后跟着工作台一起开关，不用装别的软件。邮箱不经过它，现在就能连。',
  'connector.local.download': '下载（约 {mb} MB）',
  'connector.local.preparing': '正在准备下载…',
  'connector.local.downloading': '正在下载连接器 {pct}%',
  'connector.local.verifying': '正在检查下载的文件…',
  'connector.local.starting': '连接器正在启动…',
  'connector.local.stopped': '连接器停着',
  'connector.local.start': '启动',
  'connector.local.cancel': '取消',
  'connector.local.retry': '重试',
  'connector.local.error': '连接器出错了',
  'connector.local.err.network': '连不上下载源，检查一下网络（或代理）再试。',
  'connector.local.err.timeout': '下载太久没完成，网络可能太慢，再试一次。',
  'connector.local.err.disk_full': '磁盘空间不够，清出约 300 MB 再试。',
  'connector.local.err.permission': '没有权限写入应用的数据目录。',
  'connector.local.err.integrity': '下载的文件校验没通过，已经丢掉了，再试一次。',
  'connector.local.err.busy': '连接器还在运行，没能停下来，稍后再试。',
  'connector.local.err.failed': '下载没成功，再试一次。',
  'connector.local.err.crashed': '连接器起不来。',
  'connector.local.err.unhardened': '连接器起来了，但安全设置没生效，暂时不能用。',
  'connector.local.detail.code': '原因码：{code}',
  'connector.local.confirm.title': '要先下载连接器',
  'connector.local.confirm.body': '约 {mb} MB，只下载这一次。下好后接着连{service}。',
  'connector.local.confirm.ok': '下载',
  'connector.local.confirm.cancel': '先不了',
  'diagnostics.connector.title': '连接器',
  'diagnostics.connector.hint':
    '连店铺与数据后台用的本机连接器（开源的 OpenConnector）。下载一次，之后跟着工作台开关；账号凭据加密存在这台电脑上。',
  'diagnostics.connector.none': '还没下载',
  'diagnostics.connector.version': '版本 {v}',
  'diagnostics.connector.update': '更新到 {v}',
  'diagnostics.connector.restart': '重启',
  'diagnostics.connector.rollback': '换回 {v}',
  'diagnostics.connector.remove': '删除下载',
  'diagnostics.connector.remove.confirm':
    '删除下载的连接器程序？已经连上的账号不会丢，下次要用时再下载一次。',
}

export const LOCAL_CONNECTOR_EN: Record<string, string> = {
  'connector.local.not_installed': 'Connector not downloaded yet',
  'connector.local.not_installed.detail':
    'Stores, ads and analytics connect through the connector. It is not in the installer: it downloads once the first time you need it (about {mb} MB) and then starts and stops with the workstation. Nothing else to install. Email does not use it and works now.',
  'connector.local.download': 'Download (about {mb} MB)',
  'connector.local.preparing': 'Getting ready to download…',
  'connector.local.downloading': 'Downloading the connector {pct}%',
  'connector.local.verifying': 'Checking the download…',
  'connector.local.starting': 'Connector is starting…',
  'connector.local.stopped': 'Connector is stopped',
  'connector.local.start': 'Start',
  'connector.local.cancel': 'Cancel',
  'connector.local.retry': 'Retry',
  'connector.local.error': 'Connector problem',
  'connector.local.err.network':
    'Could not reach the download source. Check your network (or proxy) and retry.',
  'connector.local.err.timeout': 'The download took too long. The network may be slow; try again.',
  'connector.local.err.disk_full': 'Not enough disk space. Free about 300 MB and retry.',
  'connector.local.err.permission': 'No permission to write to the app data folder.',
  'connector.local.err.integrity':
    'The download failed its integrity check and was discarded. Try again.',
  'connector.local.err.busy':
    'The connector is still running and would not stop. Try again shortly.',
  'connector.local.err.failed': 'The download did not finish. Try again.',
  'connector.local.err.crashed': 'The connector will not start.',
  'connector.local.err.unhardened':
    'The connector is up but its security settings are not in effect, so it cannot be used yet.',
  'connector.local.detail.code': 'Code: {code}',
  'connector.local.confirm.title': 'Download the connector first',
  'connector.local.confirm.body':
    'About {mb} MB, one time only. Once it is ready we continue connecting {service}.',
  'connector.local.confirm.ok': 'Download',
  'connector.local.confirm.cancel': 'Not now',
  'diagnostics.connector.title': 'Connector',
  'diagnostics.connector.hint':
    'The local connector (open-source OpenConnector) that stores and analytics connect through. Downloaded once, then starts and stops with the workstation; account credentials stay encrypted on this computer.',
  'diagnostics.connector.none': 'Not downloaded',
  'diagnostics.connector.version': 'Version {v}',
  'diagnostics.connector.update': 'Update to {v}',
  'diagnostics.connector.restart': 'Restart',
  'diagnostics.connector.rollback': 'Switch back to {v}',
  'diagnostics.connector.remove': 'Delete download',
  'diagnostics.connector.remove.confirm':
    'Delete the downloaded connector? Connected accounts are kept; it downloads again next time you need it.',
}
