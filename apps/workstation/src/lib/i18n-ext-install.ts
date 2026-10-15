/**
 * WP345（决策 871）：连接卡上「装插件」那一块的词条（中英各一份；在 `i18n.ts` 的 `TABLES` 并进去）。
 * 界面少字：一句 + 两个按钮 + 三步小字；没跟上新版时照实说一句。
 */
export const EXT_INSTALL_ZH: Record<string, string> = {
  'extinstall.line': '插件随工坊带着：在 Chrome 里装一次，以后跟着工坊自己更新。',
  'extinstall.folder': '打开插件文件夹',
  'extinstall.chrome': '打开 Chrome 扩展页',
  'extinstall.steps': '① 打开右上角「开发者模式」 ② 点「加载已解压的扩展程序」 ③ 选这个文件夹',
  'extinstall.steps.hint':
    '文件夹路径已经复制好了：Mac 在选择窗口里按 ⌘⇧G 粘贴，Windows 粘贴到地址栏。也可以把文件夹直接拖进选择窗口。装好后别关「开发者模式」，关了插件会被停用。',
  'extinstall.copied': '路径已复制',
  'extinstall.failed': '插件没换成新版 {version}（旧版照常能用，重开工坊会再试）：{error}',
  'extinstall.stuck':
    '浏览器里的插件还是 {running}，没跟上 {folder}：它是从别的文件夹装的。在扩展页删掉它，按下面三步重装一次。',
  'extinstall.version': '插件 {version}',
}

export const EXT_INSTALL_EN: Record<string, string> = {
  'extinstall.line':
    'The extension ships with Agents Workshop: add it to Chrome once and it updates with the app.',
  'extinstall.folder': 'Open extension folder',
  'extinstall.chrome': 'Open Chrome extensions',
  'extinstall.steps':
    '① Turn on “Developer mode” (top right) ② Click “Load unpacked” ③ Pick this folder',
  'extinstall.steps.hint':
    'The folder path is already copied: on Mac press ⌘⇧G in the picker and paste; on Windows paste it into the address bar. You can also drag the folder into the picker. Keep Developer mode on — turning it off disables the extension.',
  'extinstall.copied': 'Path copied',
  'extinstall.failed':
    'Could not switch the extension to {version} (the old one still works; reopening the app retries): {error}',
  'extinstall.stuck':
    'The extension in your browser is still {running}, not {folder}: it was added from another folder. Remove it on the extensions page and add it again with the three steps below.',
  'extinstall.version': 'Extension {version}',
}
