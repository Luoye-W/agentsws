/**
 * dsh 的「场景」（Profile）——WP136，docs/79。
 *
 * Luoye 09-24 定：dsh 的 Profile 就是「不同的工作场景」。Agents 工坊只是其中**一个**
 * （跨境电商 / 出海营销）；用户想编程、做别的事，切到 dsh 官方的场景或自己建的，
 * 不必另装一份 dsh。其他场景不是我们做的，我们只提供入口，不维护它们。
 *
 * 这个文件只放「关于 dsh 的事实」：官方模板有哪几个、哪个能开网页、`dsh` 启动器在哪、
 * 起一个场景该带哪些环境变量、怎么从它的输出里认出网址。进程怎么起、怎么停在
 * `apps/server/src/dsh-scenes.ts`。**没有一行 import dsh 的运行期代码**——
 * 启动器永远以子进程跑（`<捆绑的 Node> <dsh 的 bin.js> --profile <名字>`）。
 *
 * 出处（全部查自 `@deepseek-ai/dsh@0.1.7-rc.1` 与 `@deepseek-ai/dsh-app-boot@0.1.7-rc.1`）：
 * - 模板表：`dsh-app-boot` 的 `PROFILE_TEMPLATES`（`lib/index.js`）；`test/scenes.test.ts` 逐项对照，
 *   上游加 / 删 / 改一个模板就红。
 * - `desktop` 这个名字归 Electron 版 dsh（`dsh` 的 `lib/bin.js` 里 `rejectElectronProfile`）。
 * - 非法名字：`resolveProfileDir` 拒绝空串、带 `/` `\`、`.`、`..`、`node_modules`。
 * - 网页场景的输出：`dsh-web-app` README「Starting the Web GUI」——启动后打一行
 *   `dsh web: <带一次性 token 的网址>`；`--no-open` 不开浏览器，`--port 0` 让系统挑端口，
 *   「cannot bind all network interfaces」（只能回环 / 显式可信主机）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Agents 工坊自己那个场景的 id。它**不是** `$DSH_HOME/profiles/` 下的目录（见 docs/79 §2）。 */
export const AGENTSWS_SCENE = 'agentsws'

/** 场景能不能在这里打开：`web` = 起一个本机网页；`cli` = 命令行 / 程序接口，工作台里打不开。 */
export type DshSceneSurface = 'web' | 'cli'

export interface DshSceneTemplate {
  /** 模板名，也是官方场景名（`dsh --profile <name>`）。 */
  name: string
  /** `dsh.profile.bundles`（与上游 `PROFILE_TEMPLATES` 逐字相同）。 */
  bundles: readonly string[]
  surface: DshSceneSurface
}

/**
 * 官方模板（dsh 0.1.7-rc.1）。顺序是界面上的顺序：能开网页的 `web` 在前。
 *
 * **只有 `web` 有界面**：`headless` 跑一件事就退出，`sdk` / `sdk-minimal` / `acp` 是给
 * 程序接的标准输入输出服务——列出来是为了"新建场景"时能选它当底子，也让用户知道有它们；
 * 工作台里点不开。
 */
export const DSH_SCENE_TEMPLATES: readonly DshSceneTemplate[] = [
  { name: 'web', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], surface: 'web' },
  {
    name: 'headless',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
    surface: 'cli',
  },
  { name: 'sdk', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], surface: 'cli' },
  { name: 'sdk-minimal', bundles: ['@deepseek-ai/dsh-sdk-minimal'], surface: 'cli' },
  { name: 'acp', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'], surface: 'cli' },
]

/** 网页场景靠这个 bundle 起网页（`dsh-web-app`：前端静态文件 + 本机网页服务）。 */
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** 用户不能拿来起名的：我们自己那个、Electron 版 dsh 的那个、官方模板名。 */
export const RESERVED_SCENE_NAMES: readonly string[] = [
  AGENTSWS_SCENE,
  'desktop',
  'node_modules',
  ...DSH_SCENE_TEMPLATES.map((t) => t.name),
]

export function sceneTemplate(name: string): DshSceneTemplate | undefined {
  return DSH_SCENE_TEMPLATES.find((t) => t.name === name)
}

/**
 * 一组 bundle 起出来有没有网页。
 *
 * 有 `dsh-web-app` 且不是 `headless` 组合（上游的 `INSTALLATION_OWNED_PROFILE_TUPLES`
 * 里 headless 也挂着 web-app，但它跑完一件事就退出、不开网页）。
 */
export function surfaceOfBundles(bundles: readonly string[]): DshSceneSurface {
  return bundles.includes(WEB_APP_BUNDLE) && !bundles.includes('@deepseek-ai/dsh-headless')
    ? 'web'
    : 'cli'
}

/** 自建场景名：小写字母开头，字母 / 数字 / 短横线，最长 32。比 dsh 自己的规则严——它要当目录名。 */
const SCENE_NAME = /^[a-z][a-z0-9-]{0,31}$/

/** 名字合不合用；合用回 `undefined`，不合用回一句人话。 */
export function sceneNameProblem(name: string): string | undefined {
  if (!SCENE_NAME.test(name)) return '名字只能用小写英文字母、数字和短横线，字母开头，最长 32 个字'
  if (RESERVED_SCENE_NAMES.includes(name)) return `「${name}」是保留名字，换一个`
  return undefined
}

/**
 * `$DSH_HOME/profiles/<name>`，并确认它真在 `profiles/` 下面一层（防 `..`、防绝对路径）。
 * 名字不合法就抛——调用方在这之前应当已经用 {@link sceneNameProblem} 或列目录拿到的名字。
 */
export function sceneDir(dshHome: string, name: string): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..')
    throw new Error(`不是合法的场景名：${JSON.stringify(name)}`)
  const root = resolve(dshHome, 'profiles')
  const dir = resolve(root, name)
  if (dirname(dir) !== root) throw new Error(`不是合法的场景名：${JSON.stringify(name)}`)
  return dir
}

/** `child` 是不是 `parent` 本身或在它里面（都先 `resolve`）。 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

// ── 启动器 ────────────────────────────────────────────────────────────────

export interface DshLauncher {
  /** `@deepseek-ai/dsh` 的 `bin.dsh`（`lib/bin.js`）的绝对路径。 */
  bin: string
  /** 它自己的版本（`package.json` 的 `version`）。 */
  version: string
}

/**
 * 装在这份 Agents 工坊里的 `dsh` 启动器。
 *
 * 从**这个包**的位置解析（`@deepseek-ai/dsh` 是 dsh-adapter 的直接依赖）：开发期走 pnpm 链接，
 * 安装包里走 `<resources>/app/node_modules`。不走 PATH、不走全局安装——
 * 用户另装的那份 dsh 版本可能不同，两边混用会互改配置（docs/79 §3）。
 */
export function dshLauncher(from: string = import.meta.url): DshLauncher {
  const require = createRequire(from)
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
    version?: string
    bin?: { dsh?: string }
  }
  const binRel = pkg.bin?.dsh
  if (binRel === undefined) throw new Error(`${manifest} 里没有 bin.dsh`)
  return { bin: join(dirname(manifest), binRel), version: pkg.version ?? '' }
}

/** 网页场景的启动参数：不开浏览器（我们来开）、只听回环、端口让系统挑。 */
export function webSceneArgs(): string[] {
  return ['--no-open', '--host', '127.0.0.1', '--port', '0']
}

/**
 * 从网页场景的输出里认出那一行 `dsh web: http://127.0.0.1:<端口>/?token=…`。
 *
 * 只认回环地址——我们传了 `--host 127.0.0.1`，打出别的来说明参数没生效，宁可认不出。
 * **网址里带一次性 token**：调用方只把它交给打开它的那一方，不进日志。
 */
export function parseWebSceneUrl(line: string): string | undefined {
  const m = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d{1,5}\/\S*)/.exec(line)
  return m?.[1]
}

/** 网址 → 端口。 */
export function portOfUrl(url: string): number | undefined {
  try {
    const port = Number(new URL(url).port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/** 把网址里的 token 抹掉（进日志、进状态快照都用这一份）。 */
export function redactSceneUrl(url: string): string {
  return url.replace(/([?&](?:token|t)=)[^&#\s]+/gi, '$1…')
}

// ── 环境变量 ──────────────────────────────────────────────────────────────

/**
 * 其他场景从服务进程**继承**的变量——白名单，一条一条列。
 *
 * 服务进程自己的环境里有我们的密钥（`AGENTSWS_*`、`OOMOL_CONNECT_*`、会话密钥、秘密库密钥），
 * 全量继承就等于把它们交给一个我们不维护的程序。所以：只给系统必需的、代理（dsh 自己认
 * `HTTP(S)_PROXY`，国内用户常要）、dsh 的遥测开关（用户在宿主环境里关了，就一路关着）。
 * 任何名字里带 KEY / TOKEN / SECRET / PASSWORD 的都不在表上，`sceneEnv` 还会再挡一遍。
 */
export const SCENE_INHERITED_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ComSpec',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'DSH_TELEMETRY_DISABLED',
] as const

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION)/i

export interface SceneEnvInput {
  base: Readonly<Record<string, string | undefined>>
  /** 我们应用数据目录里那份 `DSH_HOME`（不是 `~/.dsh`）。 */
  dshHome: string
}

/** 起一个其他场景用的环境：白名单继承 + `DSH_HOME`。 */
export function sceneEnv(input: SceneEnvInput): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of SCENE_INHERITED_ENV) {
    const value = input.base[name]
    if (value !== undefined && !SECRETISH.test(name)) out[name] = value
  }
  out.DSH_HOME = input.dshHome
  return out
}
