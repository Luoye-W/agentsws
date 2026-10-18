/**
 * WP345（决策 871）：连接卡上「装插件」那一块的词条（中英各一份；在 `i18n.ts` 的 `TABLES` 并进去）。
 * 界面少字：一句 + 两个按钮 + 三步小字；没跟上新版时照实说一句。
 */
export const EXT_INSTALL_ZH: Record<string, string> = {
  'extinstall.line': '插件随工坊带着：在 Chrome 里装一次，以后跟着工坊自己更新。',
  'extinstall.folder': '打开插件文件夹',
  'extinstall.chrome': '打开 Chrome 扩展页',
  // WP409（内测 10-18 #3）：「打开插件文件夹」改成在访达 / 资源管理器里选中它，人把它拖进扩展页就装好
  'extinstall.steps': '在 Chrome 扩展页打开右上角「开发者模式」，把这个文件夹拖进扩展页',
  'extinstall.steps.hint':
    '点「打开插件文件夹」会在访达 / 资源管理器里选中 chrome-extension 这个文件夹，按住它拖进扩展页就装好了。拖不了也可以点「加载已解压的扩展程序」选它（路径已复制好：Mac 按 ⌘⇧G 粘贴，Windows 粘贴到地址栏）。装好后别关「开发者模式」，关了插件会被停用。',
  'extinstall.copied': '路径已复制',
  'extinstall.selected': '已选中 chrome-extension 文件夹：把它拖进 Chrome 扩展页',
  'extinstall.chrome.copied':
    '{address} 已复制：在要装插件的那个 Chrome 窗口（有好几个 Chrome 用户的，就在那个用户的窗口）地址栏粘贴、回车',
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
    'On the Chrome extensions page, turn on “Developer mode” (top right) and drag this folder onto the page',
  'extinstall.steps.hint':
    '“Open extension folder” selects the chrome-extension folder in Finder / File Explorer — drag it onto the extensions page and it is installed. If dragging does not work, click “Load unpacked” and pick it (the path is copied: on Mac press ⌘⇧G and paste; on Windows paste it into the address bar). Keep Developer mode on — turning it off disables the extension.',
  'extinstall.copied': 'Path copied',
  'extinstall.selected':
    'The chrome-extension folder is selected: drag it onto the Chrome extensions page',
  'extinstall.chrome.copied':
    '{address} copied: paste it into the address bar of the Chrome window you want the extension in (with several Chrome profiles, use that profile’s window) and press Enter',
  'extinstall.failed':
    'Could not switch the extension to {version} (the old one still works; reopening the app retries): {error}',
  'extinstall.stuck':
    'The extension in your browser is still {running}, not {folder}: it was added from another folder. Remove it on the extensions page and add it again with the three steps below.',
  'extinstall.version': 'Extension {version}',
}
