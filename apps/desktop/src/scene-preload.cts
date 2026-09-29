/**
 * WP184（docs/79 §3.1）：官方场景窗口的 preload——只给官方页面它在官方桌面端里本来就认的两样：
 *
 * - `__DSH_DIRECTORY_PICKER__.pick()`：原生目录选择（`dsh-client-ui-directory-picker-native`
 *   看到它就不走 Host 那边的选择框；主进程只接这个窗口主 frame 发来的请求）；
 * - `__DSH_HOST_PATHS__.pathFor(file)`：拖进来 / 选中的文件的本机路径（对话框用 `@path` 引用，
 *   不用上传一份；dsh 就跑在这台电脑上，路径是真的）。
 *
 * 移植自官方桌面端（MIT）`deepseek-ai/deepseek-harness@4878cdabd87d4041bdaff61d04c966883b9fd07a`
 * `apps/desktop/src/preload-app.ts` 里这两段；别的（启动注入、更新、键位、账号浮层）都不借。
 * 只在主 frame、只在回环地址上挂；`sandbox: true` 的 preload 必须是 CommonJS（编译成 `.cjs`）。
 */
import electron = require('electron')

const { contextBridge, ipcRenderer, webUtils } = electron

const CHANNELS = { directoryPick: 'agentsws:scene-directory-pick' } as const

if (process.isMainFrame && location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(CHANNELS.directoryPick) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor: (file: File) => webUtils.getPathForFile(file),
  })
}
