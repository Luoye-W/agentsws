/**
 * Electron 主进程：托盘常驻、无主窗口启动、sidecar 监督、原生桥接（13 §5）。
 *
 * 这个文件只做**装配**——所有判定（状态机、退避、URL 拦截、菜单模型、配置、密钥）
 * 都在旁边那些不 import electron 的模块里，那些才是被测试覆盖的部分。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron'
import { type ApiClient, createApiClient, type DesktopSession } from './api-client.js'
import { BRIDGE_CHANNELS, type BridgeInfo } from './bridge-types.js'
import { createConfigStore, type DesktopConfig } from './config.js'
import {
  type ConnectRuntimeStatus,
  connectUrlFrom,
  createConnectRuntime,
  type HardeningReportLike,
  notImplementedLauncher,
} from './connect-runtime.js'
import { withCsp } from './csp.js'
import { createHaltControl } from './halt.js'
import { type HealthSnapshot, probeHealth } from './health.js'
import { createLogger } from './logging.js'
import { buildTrayMenu, type MenuAction, type MenuItemModel, trayTooltip } from './menu.js'
import { decideNavigation, decideWindowOpen, isLocalOrigin, isSafeExternal } from './navigation.js'
import { nodeFileStore } from './node-files.js'
import {
  cryptoRandomBytes,
  nodeAbort,
  nodeSpawner,
  nodeTimers,
  systemClock,
} from './node-runtime.js'
import { desktopPaths } from './paths.js'
import { createRedactor } from './redact.js'
import { createSecretVault, type DesktopSecrets, secretLiterals, toHex } from './secrets.js'
import {
  resolveServerEntry,
  resolveServerRuntime,
  type ServerRuntime,
  serverSpawnRequest,
} from './server-process.js'
import { createSidecar, type SidecarSnapshot } from './sidecar.js'
import { TRAY_ICON_2X_DATA_URL, TRAY_ICON_DATA_URL } from './tray-icon.js'
import { createUpdateGate, type UpdaterPort } from './updater.js'

const here = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)

/** 开发 / e2e 用：把用户数据目录挪到别处，免得污染真实安装。 */
const userDataOverride = process.env.AGENTSWS_DESKTOP_USER_DATA
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride)
}

/** playwright `_electron` 的抓手（只在主进程里可见，网页够不着）。 */
interface TestHandle {
  hasTray(): boolean
  menu(): MenuItemModel[]
  serverUrl(): string
  health(): HealthSnapshot | undefined
  server(): SidecarSnapshot
  openWorkstation(path?: string): Promise<string>
  invoke(action: MenuAction): void
}

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  image.addRepresentation({
    scaleFactor: 2,
    dataURL: TRAY_ICON_2X_DATA_URL,
  })
  image.setTemplateImage(true)
  return image
}

async function bootstrap(): Promise<void> {
  const paths = desktopPaths(app.getPath('userData'))
  const files = nodeFileStore()
  files.ensureDir(paths.userData)
  files.ensureDir(paths.logDir)
  files.ensureDir(paths.serverDataDir)

  const logger = createLogger({
    files,
    path: paths.logFile,
    clock: systemClock,
    mirror: (line) => {
      process.stdout.write(`${line}\n`)
    },
  })
  const version = app.getVersion()
  logger.info('桌面壳启动', { version, userData: paths.userData })

  const configStore = createConfigStore(files, paths.configFile)
  let config: DesktopConfig = configStore.load()
  const halt = createHaltControl(files, paths.haltFile)

  // ── 首次运行：生成密钥并用 safeStorage 加密落盘；明文只在内存与子进程 env 里存在。
  const vault = createSecretVault({
    files,
    path: paths.secretsFile,
    safeStorage,
    randomBytes: cryptoRandomBytes,
  })
  let secrets: DesktopSecrets
  try {
    const loaded = vault.loadOrCreate()
    secrets = loaded.secrets
    logger.info(loaded.created ? '已生成本机密钥（safeStorage 加密）' : '已读取本机密钥')
  } catch (err) {
    logger.error('密钥不可用，桌面壳无法启动', { error: String(err) })
    throw err
  }
  // 从这一刻起，日志里出现这三个值一律遮罩。
  logger.setRedactor(createRedactor(secretLiterals(secrets)))

  const serverEntry = resolveServerEntry(
    [
      // 打包后：extraResources 里单独摆的一份 server（留给将来做增量更新）
      app.isPackaged ? join(process.resourcesPath, 'server', 'dist', 'index.js') : undefined,
      // node 解析：开发期走 workspace 链接，打包后走 Resources/app/node_modules
      tryResolve('@agentsws/server'),
      // 兜底：按目录结构猜
      join(here, '..', 'node_modules', '@agentsws', 'server', 'dist', 'index.js'),
      join(here, '..', '..', 'server', 'dist', 'index.js'),
    ],
    (p) => files.exists(p),
  )
  const serverRuntime: ServerRuntime = resolveServerRuntime({
    env: process.env,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    exists: (p) => files.exists(p),
    electronExecPath: process.execPath,
  })
  logger.info('服务进程入口', { entry: serverEntry, runtime: serverRuntime.kind })

  const serverLog = createLogger({
    files,
    path: paths.serverLogFile,
    clock: systemClock,
    redactor: createRedactor(secretLiterals(secrets)),
  })

  let boundPort = config.port
  const serverUrl = (): string => `http://127.0.0.1:${boundPort}`

  const server = createSidecar({
    name: 'server',
    spawner: nodeSpawner(),
    timers: nodeTimers(),
    clock: systemClock,
    logger,
    stableAfterMs: 10_000,
    backoff: { baseMs: 1000, maxMs: 30_000, jitter: 0.2 },
    random: () =>
      cryptoRandomBytes(2)[0] === undefined ? 0 : (cryptoRandomBytes(2)[0] ?? 0) / 256,
    request: () =>
      serverSpawnRequest({
        runtime: serverRuntime,
        entry: serverEntry,
        port: config.port,
        dataDir: paths.serverDataDir,
        // 13 §5：急停的真源是这个文件，两边共用。服务进程启动读它、每次改写回它，
        // 所以托盘按下的暂停不必再靠重启 sidecar 生效。
        haltFile: paths.haltFile,
        halt: halt.read(),
        ...(connectUrlFrom(process.env) === undefined
          ? {}
          : { connectUrl: connectUrlFrom(process.env) as string }),
        secrets,
        version,
        baseEnv: process.env,
      }),
    onOutput: (stream, line) => {
      // 服务进程启动时会打印 `internal token: …`——脱敏器负责让它进不了日志。
      serverLog.raw(`[${stream}] ${line}`)
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line)
      const port = match?.[1]
      if (port !== undefined) boundPort = Number(port)
    },
  })

  // ── OpenConnector runtime：v1 只检测 + 加固检查，不负责拉起（08 §5）。
  //     地址只有一个出处（`AGENTSWS_CONNECT_URL`，见 apps/server/src/connect-url.ts）；
  //     桌面壳不再自带默认值，读不到就用服务进程那边的同一个常量。
  // `@agentsws/server` 是唯一定默认值的地方；动态 import 免得把整个服务进程拖进主进程启动路径。
  const { DEFAULT_CONNECT_URL: SERVER_DEFAULT_CONNECT_URL } = await import('@agentsws/server')
  const connectUrl = connectUrlFrom(process.env) ?? SERVER_DEFAULT_CONNECT_URL
  const connect = createConnectRuntime({
    baseUrl: connectUrl,
    clock: systemClock,
    launcher: notImplementedLauncher('docker'),
    probe: async (baseUrl): Promise<HardeningReportLike> => {
      const { assertRuntimeHardened } = await import('@agentsws/connect-adapter')
      return assertRuntimeHardened(baseUrl, {
        env: {
          OOMOL_CONNECT_ENCRYPTION_KEY: secrets.connectEncryptionKey,
          OOMOL_CONNECT_ADMIN_TOKEN: secrets.connectAdminToken,
          OOMOL_CONNECT_BLOCKED_PROXIES: '*',
        },
      })
    },
  })

  let health: HealthSnapshot | undefined
  let connectStatus: ConnectRuntimeStatus | undefined
  let tray: Tray | undefined
  let window: BrowserWindow | undefined

  const allowedOrigins = (): string[] => [serverUrl()]

  // ── 安全：CSP 只允许 self，覆盖服务端可能发的任何一份。
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: withCsp(details.responseHeaders ?? {}) })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      const decision = decideNavigation(url, allowedOrigins())
      if (decision.action === 'allow') return
      event.preventDefault()
      if (decision.action === 'external') void shell.openExternal(decision.url)
      else logger.warn('拒绝导航', { url, reason: decision.reason })
    })
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, allowedOrigins())
      if (decision.action === 'external') void shell.openExternal(decision.url)
      else if (decision.action === 'allow') void contents.loadURL(url)
      else logger.warn('拒绝开窗', { url, reason: decision.reason })
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })

  // ── 原生桥接：只有四件能力，且只接受本地源的窗口发来的调用。
  const fromLocalWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    isLocalOrigin(event.senderFrame?.url ?? '', allowedOrigins())

  ipcMain.on(BRIDGE_CHANNELS.info, (event) => {
    const info: BridgeInfo = { platform: process.platform, version }
    event.returnValue = info
  })
  ipcMain.handle(BRIDGE_CHANNELS.notify, (event, raw: unknown) => {
    if (!fromLocalWindow(event)) return false
    if (!Notification.isSupported()) return false
    const input = raw as { title?: unknown; body?: unknown } | null
    const title = typeof input?.title === 'string' ? input.title : ''
    if (title === '') return false
    const body = typeof input?.body === 'string' ? input.body : undefined
    new Notification({ title, ...(body === undefined ? {} : { body }) }).show()
    return true
  })
  ipcMain.handle(BRIDGE_CHANNELS.openExternal, async (event, raw: unknown) => {
    if (!fromLocalWindow(event)) return false
    if (typeof raw !== 'string' || !isSafeExternal(raw)) return false
    await shell.openExternal(raw)
    return true
  })

  // ── 服务进程的 /v1：换会话 cookie、运行期急停、换密钥（13 §5 / 28 §1）。
  //     会话密钥只在主进程里出现，换回来的 cookie 也只在主进程里；渲染进程与 URL 里一个字都没有。
  const api: ApiClient = createApiClient({
    baseUrl: serverUrl(),
    sessionKey: secrets.serverSessionKey,
    fetchImpl: globalThis.fetch as never,
    abort: nodeAbort,
    timeoutMs: 5000,
  })
  let sessionCache: DesktopSession | undefined
  let assignmentCache: string | undefined

  /**
   * 换一次会话并把 cookie 装进 Electron 的 session（开窗前必须先做这一步）。
   *
   * 两条路里选了这一条：**主进程换、`session.cookies.set` 装**。另一条是先开一个
   * `/session` 路由页、由页面自己去换——那样会话密钥必须传进渲染进程，
   * 而「token 一次都不进 URL、不进渲染进程」正是这条接口存在的理由（13 §5 / 20 §3）。
   */
  const ensureSession = async (): Promise<DesktopSession | undefined> => {
    if (sessionCache !== undefined) return sessionCache
    const out = await api.session()
    if (!out.ok) {
      logger.warn('换会话失败', { reason: out.reason })
      return undefined
    }
    sessionCache = out.value
    try {
      await session.defaultSession.cookies.set({
        url: serverUrl(),
        name: out.value.name,
        value: out.value.value,
        httpOnly: true,
        sameSite: 'strict',
      })
    } catch (err) {
      // cookie 装不进去不致命：窗口会走登录页
      logger.warn('写入会话 cookie 失败', { error: String(err) })
    }
    return sessionCache
  }

  /** `PUT /v1/halt` 与 `POST /v1/secrets/rotate` 都要 `X-Assignment`。 */
  const ensureAssignment = async (s: DesktopSession): Promise<string | undefined> => {
    if (assignmentCache !== undefined) return assignmentCache
    const out = await api.assignment(s)
    if (!out.ok) {
      logger.warn('取岗位分配失败', { reason: out.reason })
      return undefined
    }
    assignmentCache = out.value
    return assignmentCache
  }

  /** 服务进程重启（换端口 / 换实例）后，旧 cookie 与旧 assignment 都作废。 */
  const forgetSession = (): void => {
    sessionCache = undefined
    assignmentCache = undefined
  }

  const openWindow = async (path = '/'): Promise<string> => {
    await ensureSession()
    const url = `${serverUrl()}${path}`
    if (window === undefined || window.isDestroyed()) {
      window = new BrowserWindow({
        width: 1280,
        height: 840,
        show: false,
        title: 'agentsws',
        webPreferences: {
          preload: join(here, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          spellcheck: false,
        },
      })
      window.on('closed', () => {
        window = undefined
      })
      window.once('ready-to-show', () => {
        window?.show()
      })
    }
    await window.loadURL(url)
    window.show()
    window.focus()
    return url
  }

  const openWorkstation = async (path = '/'): Promise<string> => {
    if (config.openInBrowser) {
      const url = `${serverUrl()}${path}`
      await shell.openExternal(url)
      return url
    }
    return openWindow(path)
  }

  const toTemplate = (items: MenuItemModel[]): MenuItemConstructorOptions[] =>
    items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' }
      const action = item.id as MenuAction
      return {
        label: item.label,
        enabled: item.enabled,
        ...(item.type === 'checkbox' ? { type: 'checkbox' as const, checked: item.checked } : {}),
        ...(item.id === 'status'
          ? {}
          : {
              click: () => {
                invoke(action)
              },
            }),
      }
    })

  const model = (): MenuItemModel[] =>
    buildTrayMenu({
      language: config.language,
      serverUrl: serverUrl(),
      version,
      server: server.snapshot(),
      health,
      paused: halt.isPaused(),
      connect: connectStatus,
      launchAtLogin: config.launchAtLogin,
    })

  const refreshTray = (): void => {
    if (tray === undefined) return
    tray.setContextMenu(Menu.buildFromTemplate(toTemplate(model())))
    tray.setToolTip(
      trayTooltip({
        language: config.language,
        serverUrl: serverUrl(),
        version,
        server: server.snapshot(),
        health,
        paused: halt.isPaused(),
        connect: connectStatus,
        launchAtLogin: config.launchAtLogin,
      }),
    )
  }

  /**
   * 托盘「暂停」：调 `PUT /v1/halt`（28 §1「急停一个变量」的运行期入口）。
   *
   * 不再重启 sidecar——那会把一个正在处理的运行硬生生打断。急停的真源是
   * `AGENTSWS_HALT_FILE` 指的那个文件，服务进程改完会写回去，所以这里只需要
   * 把自己的缓存刷一遍。服务没起来时才退回「写文件 + 重启」的老路。
   */
  async function togglePause(): Promise<void> {
    const wanted = !halt.isPaused()
    const s = await ensureSession()
    const assignment = s === undefined ? undefined : await ensureAssignment(s)
    if (s !== undefined && assignment !== undefined) {
      const out = await api.setHalt(s, assignment, 'all', wanted, '桌面壳托盘')
      if (out.ok) {
        const scopes = halt.reload()
        logger.info(wanted ? '已暂停（急停 all）' : '已恢复', { scopes, via: 'PUT /v1/halt' })
        await pollHealth()
        return
      }
      logger.warn('运行期急停失败，退回写文件 + 重启', { reason: out.reason })
    }
    // 兜底：服务还没起来（或路由不可用），写文件再重启——重启后启动读得到
    const scopes = wanted ? halt.set(['all']) : halt.set([])
    logger.info(wanted ? '已暂停（急停 all）' : '已恢复', { scopes, via: 'halt.json + restart' })
    forgetSession()
    server.restart()
    refreshTray()
  }

  /**
   * 「轮换本机密钥」：生成一把新的 `AGENTSWS_SECRETS_KEY` → **先**落 safeStorage
   * → 调 `POST /v1/secrets/rotate` 整库重加密 → 重启服务进程用新密钥。
   *
   * 顺序不能反：先换库后落盘，中间崩一次就再也解不开了。反过来最坏情况是
   * safeStorage 里躺着一把还没用上的新密钥——重试一次就好。
   */
  async function rotateSecretsKey(): Promise<void> {
    const s = await ensureSession()
    const assignment = s === undefined ? undefined : await ensureAssignment(s)
    if (s === undefined || assignment === undefined) {
      logger.warn('轮换密钥失败：换不到会话')
      return
    }
    const next = toHex(cryptoRandomBytes(32))
    const rotated = await api.rotateSecretsKey(s, assignment, next)
    if (!rotated.ok) {
      logger.warn('轮换密钥失败，本机密钥未动', { reason: rotated.reason })
      return
    }
    secrets = { ...secrets, serverSecretsKey: next }
    vault.write(secrets)
    // 新密钥立刻进遮罩表；旧的那把留着也无妨（日志里出现照样遮）
    logger.setRedactor(createRedactor(secretLiterals(secrets)))
    serverLog.setRedactor(createRedactor(secretLiterals(secrets)))
    logger.info('已轮换本机秘密库密钥', { rotated: rotated.value.rotated })
    forgetSession()
    server.restart()
    refreshTray()
  }

  function invoke(action: MenuAction): void {
    switch (action) {
      case 'open-workstation':
        void openWindow()
        break
      case 'open-browser':
        void shell.openExternal(serverUrl())
        break
      case 'toggle-pause':
        void togglePause()
        break
      case 'rotate-secrets-key':
        void rotateSecretsKey()
        break
      case 'restart-server':
        forgetSession()
        server.restart()
        break
      case 'open-logs':
        void shell.openPath(paths.logDir)
        break
      case 'toggle-launch-at-login': {
        config = configStore.update({ launchAtLogin: !config.launchAtLogin })
        setLoginItem(config.launchAtLogin)
        refreshTray()
        break
      }
      case 'quit':
        quitting = true
        server.stop()
        app.quit()
        break
    }
  }

  /** 未签名 / 非标准位置的应用会被系统拒（"Operation not permitted"）——记一笔就够，不该挡住启动。 */
  function setLoginItem(openAtLogin: boolean): void {
    try {
      app.setLoginItemSettings({ openAtLogin })
    } catch (err) {
      logger.warn('设置开机自启失败', { error: String(err) })
    }
  }

  let quitting = false
  app.on('before-quit', () => {
    quitting = true
    server.stop()
  })

  server.subscribe(() => {
    refreshTray()
  })
  server.start()

  // ── 健康轮询：托盘状态、"打开工作台"是否可点都看它。
  const pollHealth = async (): Promise<void> => {
    health = await probeHealth(serverUrl(), {
      fetchImpl: globalThis.fetch as never,
      timeoutMs: 2500,
      abort: nodeAbort,
    })
    refreshTray()
  }
  const healthTimer = setInterval(() => {
    void pollHealth()
  }, 5000)
  healthTimer.unref?.()
  void pollHealth()

  const pollConnect = async (): Promise<void> => {
    connectStatus = await connect.check()
    refreshTray()
  }
  const connectTimer = setInterval(() => {
    void pollConnect()
  }, 60_000)
  connectTimer.unref?.()
  void pollConnect()

  // ── 自动更新：只有骨架，默认关（没有更新源）；打开时"冒烟不过不切换"。
  const updater: UpdaterPort = {
    checkForUpdates: () => Promise.resolve(undefined),
    downloadUpdate: () => Promise.resolve(),
    quitAndInstall: () => undefined,
  }
  const updateGate = createUpdateGate({
    updater,
    logger,
    enabled: process.env.AGENTSWS_DESKTOP_UPDATES === '1',
    smoke: async () =>
      (await probeHealth(serverUrl(), { fetchImpl: globalThis.fetch as never, abort: nodeAbort }))
        .ok,
  })
  void updateGate.run().then((outcome) => {
    logger.info('更新检查', {
      state: outcome.state,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    })
  })

  // ── 托盘常驻、无主窗口启动（13 §5）。
  tray = new Tray(trayImage())
  refreshTray()
  app.dock?.hide()
  setLoginItem(config.launchAtLogin)

  const handle: TestHandle = {
    hasTray: () => tray !== undefined && !tray.isDestroyed(),
    menu: model,
    serverUrl,
    health: () => health,
    server: () => server.snapshot(),
    openWorkstation: (path) => openWorkstation(path),
    invoke,
  }
  ;(globalThis as { __agentsws__?: TestHandle }).__agentsws__ = handle

  app.on('window-all-closed', () => {
    // 托盘壳：关掉窗口不退出应用（13 §5「托盘常驻」）。
    if (!quitting) return
    app.quit()
  })
}

/**
 * `@agentsws/server` 的 `exports` 只声明了 `import` 条件，`require.resolve` 会
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`；所以先用 ESM 解析，再退回 CJS 解析。
 */
function tryResolve(specifier: string): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve(specifier))
  } catch {
    // 继续试 CJS
  }
  try {
    return require_.resolve(specifier)
  } catch {
    return undefined
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const handle = (globalThis as { __agentsws__?: TestHandle }).__agentsws__
    void handle?.openWorkstation()
  })
  app
    .whenReady()
    .then(() => bootstrap())
    .catch((err: unknown) => {
      process.stderr.write(`agentsws desktop 启动失败：${String(err)}\n`)
      app.exit(1)
    })
}
