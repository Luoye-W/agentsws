/**
 * 浏览器设置（55 §3 末段，WP82）：**这台机器上**的浏览器怎么配。
 *
 * 三件事，一件也不多：
 *
 * 1. **存**（`get` / `set`）：一个 JSON 文件，跟着这台服务的数据目录走。不按品牌分——
 *    attach 接的是用户自己电脑上那个 Chrome，它与卖哪个品牌无关。
 * 2. **探**（`probe`）：往 CDP 地址发一个 `GET /json/version`。这是 Chrome DevTools
 *    协议自己的发现端点，返回浏览器版本；连得上就说明那个 `--remote-debugging-port`
 *    真的开着。同一个函数也用来**自动探测**——把常见端口挨个试一遍。
 * 3. **判档**（`attachAllowed`）：只有个人档（本机运行）允许 attach。
 *
 * 凭据这条线上这个模块什么都不碰（13 §4）：CDP 地址不是凭据，浏览器里的登录态
 * 从头到尾在用户自己的 Chrome 里——我们既不读 cookie，也不存密码。
 *
 * **不在这里做的事**：起浏览器。把 Chrome 拉起来是桌面壳的活（托盘菜单那条
 * "打开工作用的浏览器"），服务端只负责记住地址、探一下通不通。服务端去 spawn
 * 用户的浏览器等于让一个后台服务在别人桌面上开窗口，那是桌面壳才该干的事。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  BrowserProbeResult,
  BrowserSettings,
  BrowserSettingsView,
  RunBrowser,
} from '@agentsws/contracts'

/** 探一次最多等多久。等太久等于连不上——用户要的是一个答案，不是一个转圈。 */
export const BROWSER_PROBE_TIMEOUT_MS = 2000

/**
 * 自动探测时挨个试的端口。
 *
 * 9222 是 Chrome 的老规矩（`--remote-debugging-port` 的文档例子），9223 / 9224 是
 * 同一台机器上开第二第三个实例时的顺延；9333 是我们桌面壳给"工作用的浏览器"
 * 挑的那一个（见 `apps/desktop`）。不扫全端口段：那是端口扫描，不是探测。
 */
export const BROWSER_PROBE_PORTS: readonly number[] = [9333, 9222, 9223, 9224]

const DEFAULT: BrowserSettings = { mode: 'off' }

interface StateFile {
  version: 1
  settings: BrowserSettings
}

export class BrowserSettingsError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'forbidden',
    message: string,
  ) {
    super(message)
    this.name = 'BrowserSettingsError'
  }
}

/** 一次 HTTP 探测（测试注入假的；缺省用 `fetch`）。 */
export type CdpProbe = (endpoint: string) => Promise<BrowserProbeResult>

export interface BrowserSettingsOptions {
  /** 落盘目录；不给就全内存（测试与一次性任务）。 */
  dir?: string
  /**
   * 这台服务跑在哪一档（`Workspace.runtime.mode`）。
   * `local` = 个人档（服务就在用户那台电脑上）→ 允许 attach；
   * `docker` / `hosted` = 公司档 / 托管档 → 只允许 launch headless。
   */
  runtimeMode(): 'local' | 'docker' | 'hosted'
  probe?: CdpProbe
  /**
   * WP92（55 §10）：这台机器上 `bsk` 装在哪（`AGENTSWS_DATA_DIR/bin/bsk`）。
   *
   * 用户没在设置里另填路径时用它。不给（没有数据目录的全内存档）= 这台服务
   * 装不了 bsk，`browserskill` 那一项就一直是"还没装"。
   */
  defaultBskPath?(): string | undefined
  /** 这个文件在不在（测试注入；缺省 `existsSync`）。 */
  bskExists?(path: string): boolean
}

export interface BrowserSettingsAssembly {
  get(): BrowserSettingsView
  set(input: BrowserSettings): BrowserSettingsView
  /** 给了地址就探那一个；不给就把常见端口挨个试一遍，第一个通的就是它。 */
  probe(endpoint?: string): Promise<BrowserProbeResult>
  /**
   * 组 `RunRequest.browser` 用的那一份。
   * `mode: 'off'`、或者设置与当前档位对不上（公司档配了 attach）→ `undefined`，
   * 也就是这次运行根本不开浏览器。
   */
  forRun(): RunBrowser | undefined
  /** WP92：这台机器上 `bsk` 该在哪（设置里填过就是那个）。 */
  bskPath(): string | undefined
}

/** CDP 的 endpoint 只允许 http(s) / ws(s)，且不能带空白（上游 provider 的同一条口径）。 */
export function validateEndpoint(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new BrowserSettingsError('invalid_input', '浏览器地址不能为空')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BrowserSettingsError(
      'invalid_input',
      `这不是一个地址：${value}（应该长这样：http://127.0.0.1:9222）`,
    )
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new BrowserSettingsError(
      'invalid_input',
      `地址要以 http:// 或 ws:// 开头，现在是 ${url.protocol}`,
    )
  }
  return value
}

/** 默认探测：`GET <endpoint>/json/version`，Chrome DevTools 协议自己的发现端点。 */
export async function probeCdpEndpoint(endpoint: string): Promise<BrowserProbeResult> {
  const base = endpoint.replace(/^ws(s?):/u, 'http$1:').replace(/\/+$/u, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BROWSER_PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const res = await fetch(`${base}/json/version`, { signal: controller.signal })
    if (!res.ok) return { ok: false, endpoint, detail: `浏览器回了 HTTP ${res.status}` }
    const body = (await res.json()) as { Browser?: unknown }
    const browser = typeof body.Browser === 'string' ? body.Browser : undefined
    return { ok: true, endpoint, ...(browser === undefined ? {} : { browser }) }
  } catch (e) {
    const detail =
      e instanceof Error && e.name === 'AbortError'
        ? `等了 ${BROWSER_PROBE_TIMEOUT_MS / 1000} 秒没回应`
        : '连不上（这个端口上没有开着调试口的浏览器）'
    return { ok: false, endpoint, detail }
  } finally {
    clearTimeout(timer)
  }
}

export function createBrowserSettings(options: BrowserSettingsOptions): BrowserSettingsAssembly {
  const file = options.dir === undefined ? undefined : join(options.dir, 'browser.json')
  const probe = options.probe ?? probeCdpEndpoint
  let settings: BrowserSettings = load()

  function load(): BrowserSettings {
    if (file === undefined) return { ...DEFAULT }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as StateFile
      return parsed.version === 1 ? parsed.settings : { ...DEFAULT }
    } catch {
      // 没有这个文件、或者文件坏了：回到"谁都不许开浏览器"。这是安全的那一侧。
      return { ...DEFAULT }
    }
  }

  function persist(): void {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    const state: StateFile = { version: 1, settings }
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const attachAllowed = (): boolean => options.runtimeMode() === 'local'
  /*
   * WP92：「我正在用的浏览器」与 attach 同一条判据——`bsk` 与浏览器扩展都在
   * **用户那台电脑**上，服务不在那台电脑上就连不过去。
   */
  const browserSkillAllowed = attachAllowed
  const bskExists = options.bskExists ?? ((path: string) => existsSync(path))
  const bskPathOf = (): string | undefined => settings.bsk_path ?? options.defaultBskPath?.()

  const view = (): BrowserSettingsView => ({
    ...settings,
    attach_allowed: attachAllowed(),
    ...(attachAllowed()
      ? {}
      : {
          attach_blocked_reason:
            '这台服务不在你自己的电脑上（Docker / 托管档），连不到你的 Chrome；' +
            '这一档只能用「独立的 Chrome」那一种。',
        }),
    browserskill_allowed: browserSkillAllowed(),
    ...(browserSkillAllowed()
      ? {}
      : {
          browserskill_blocked_reason:
            '这台服务不在你自己的电脑上（Docker / 托管档）：bsk 与浏览器扩展都装在你那台' +
            '电脑上，连不过来。这一档只能用「独立的 Chrome」那一种。',
        }),
  })

  return {
    get: view,
    set(input) {
      if (input.mode === 'attach') {
        if (!attachAllowed()) {
          throw new BrowserSettingsError(
            'forbidden',
            '这一档不能接你电脑上的 Chrome（55 §3：只有个人档允许 attach）',
          )
        }
        settings = { mode: 'attach', endpoint: validateEndpoint(input.endpoint ?? '') }
      } else if (input.mode === 'launch') {
        const path = (input.executable_path ?? '').trim()
        if (path === '') {
          throw new BrowserSettingsError(
            'invalid_input',
            '要指一个 Chrome / Chromium 的可执行文件——我们不替你下载浏览器',
          )
        }
        settings = {
          mode: 'launch',
          executable_path: path,
          headless: input.headless ?? true,
        }
      } else if (input.mode === 'browserskill') {
        /*
         * WP92（55 §10）：用**用户正在用的那个浏览器**。这里只记"选了这一种"和
         * `bsk` 在哪；扩展装没装、daemon 起没起由 `bsk doctor` 说了算（设置页第 ③ 步），
         * 存设置这一刻不去跑它——存一个设置不该等一个子进程。
         */
        if (!browserSkillAllowed()) {
          throw new BrowserSettingsError(
            'forbidden',
            '这一档不能用你正在用的浏览器（55 §10：bsk 与扩展都在用户那台电脑上）',
          )
        }
        const path = (input.bsk_path ?? '').trim()
        settings = { mode: 'browserskill', ...(path === '' ? {} : { bsk_path: path }) }
      } else {
        settings = { mode: 'off' }
      }
      persist()
      return view()
    },
    async probe(endpoint) {
      if (endpoint !== undefined) return probe(validateEndpoint(endpoint))
      // 自动探测：常见端口挨个试，第一个通的就是它
      let last: BrowserProbeResult | undefined
      for (const port of BROWSER_PROBE_PORTS) {
        const result = await probe(`http://127.0.0.1:${port}`)
        if (result.ok) return result
        last = result
      }
      return (
        last ?? {
          ok: false,
          endpoint: '',
          detail: '没找到开着调试口的浏览器',
        }
      )
    },
    forRun() {
      if (settings.mode === 'attach') {
        // 档位变了（本机档的库被搬进了 Docker）也不放行：以当下这一档为准
        if (!attachAllowed() || settings.endpoint === undefined) return undefined
        return { mode: 'attach', endpoint: settings.endpoint }
      }
      if (settings.mode === 'browserskill') {
        /*
         * WP92：**装好了才给**。没装（或者档位变了）就当这次运行没有浏览器——
         * 与"没配浏览器"是同一种结果。给一个指不到文件的 `bsk_path` 更糟：
         * 适配器那一层会让整次运行失败（见 `dsh-adapter/src/browserskill.ts`
         * 的 `bskBinaryUsable`：插件卸载时会把 SIGINT 发到我们自己头上）。
         */
        if (!browserSkillAllowed()) return undefined
        const path = bskPathOf()
        if (path === undefined || !bskExists(path)) return undefined
        return { mode: 'browserskill', bsk_path: path }
      }
      if (settings.mode === 'launch') {
        return {
          mode: 'launch',
          headless: settings.headless ?? true,
          ...(settings.executable_path === undefined
            ? {}
            : { executable_path: settings.executable_path }),
        }
      }
      return undefined
    },
    bskPath: bskPathOf,
  }
}
