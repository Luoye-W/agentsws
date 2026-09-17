/**
 * 终端与沙箱策略（55 §8 Q7 那张表，WP89）。
 *
 * **工具面一个字都不是我们写的**：`bash` 这个工具来自官方 `@deepseek-ai/dsh-tool-bash`，
 * 跑命令的人是 `dsh-bash-sandbox`，关命令的笼子是 `dsh-sandbox-local`
 * （macOS Seatbelt / Linux bwrap→Landlock / Windows 受限令牌），档位由
 * `dsh-sandbox-policy` 统一解析。与 WP82 的浏览器同一条纪律：**我们这一侧只剩策略**。
 *
 * | 策略 | 落在哪 |
 * |---|---|
 * | 谁有终端 | {@link SHELL_ROLE_IDS} + `RunRequest.shell`，**两个都得成立**（`harness.ts` 才挂那一摞） |
 * | 档位 | `RunShell.mode`，契约里只有 `read-only` / `workspace-write`；升档（`sandbox_permissions`）一律拒 |
 * | 命令 allowlist | {@link checkShellCommand}，五个前缀各带子命令表，表外拒 |
 * | 发布物化成卡 | {@link checkShellCommand} 回 `publish`，门禁把它做成 `publish_theme` 的 staged change（永远 L1） |
 * | 越界写 | {@link checkShellCommand} 先判一道（人话理由），沙箱是第二道（内核说了算） |
 * | 凭据不经模型 | {@link shellCredentialPlan} + {@link AgentswsBashExecutor}：契约里只有名字与记录地址；值只在"这一条命令"的 spec 里活着，**一次都不进宿主进程的环境** |
 *
 * **两道墙不是重复**：我们这一道判的是"这条命令该不该跑"（会不会动线上、在不在职责范围内），
 * 沙箱那一道判的是"跑起来之后碰不碰得到"。allowlist 判得出意图、判不出 symlink；
 * 沙箱判得出真实路径、判不出"这是一次发布"。少哪一道都不行。
 */
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RunRequest, RunShell } from '@agentsws/contracts'
import type { Context } from '@deepseek-ai/cordis'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import {
  credentialRef,
  isCredentialRefName,
  parseCredentialKey,
} from '@deepseek-ai/dsh-credentials'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'

/** 官方 `dsh-tool-bash` 注册的那个工具名。 */
export const BASH_TOOL = 'bash'

/**
 * 有终端的职责（55 §8「谁需要」那一行）。
 *
 * `site.shopify-theme` 是 WP77 之后的正名，`site.builder` 是它的别名（旧的运行记录、
 * 回放包里都是这个）。**别往这张表里加东西**：客服 / 运营 / 红人职责一个都不给 shell，
 * 加一条就是给一条职责开一个能跑任意命令的口子。
 */
export const SHELL_ROLE_IDS: readonly string[] = ['site.shopify-theme', 'site.builder']

/** 这条职责能不能有终端。 */
export function shellRoleAllowed(role_id: string): boolean {
  return SHELL_ROLE_IDS.includes(role_id)
}

/**
 * 这次运行真的要挂终端吗（**两道都得过**）。
 *
 * 1. 请求里给了 `shell`（服务端算出来的工作副本目录与档位）；
 * 2. 这条职责在 {@link SHELL_ROLE_IDS} 里。
 *
 * 第二道是有意的冗余：契约说的是"怎么跑"，"谁能跑"不该由请求方说了算——
 * 哪天有人把 `shell` 写进了客服的 RunRequest，这里照样不挂。
 */
export function runShell(req: RunRequest): RunShell | undefined {
  const shell = req.shell
  if (shell === undefined) return undefined
  if (!shellRoleAllowed(req.actor.role_id)) return undefined
  if (!isAbsolute(shell.workspace_root)) return undefined
  return shell
}

/**
 * 这家店的主题工作副本目录：`<data>/themes/<workspace>/<store>/`。
 *
 * 与 `apps/server/src/shopify-theme.ts` 的 `workspaceOf()`（`<workdir>/themes/<shop>`）
 * **多了一层 workspace**：那一份的 `workdir` 本来就是按品牌开的，这一份要在一个
 * 数据目录下同时放得下多个品牌（52 O1：品牌 A 的副本在 B 的任何运行里都看不见）。
 * 两边指到同一个地方与否不影响正确性——`theme publish --theme <id>` 不读工作副本。
 */
export function themeWorkspaceRoot(dataDir: string, workspace_id: string, store: string): string {
  return join(dataDir, 'themes', segment(workspace_id), segment(store))
}

/** 目录名归一：路径分隔符与奇怪字符一律换成短横线（不让 store 里的 `../` 跑出去）。 */
function segment(value: string): string {
  const mapped = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|-+$/g, '')
  return mapped === '' ? 'x' : mapped
}

// ── 判定结果 ───────────────────────────────────────────────────────────

/** allowlist 放行时这条命令算哪一类副作用（16 §3）。 */
export type ShellEffect = 'local' | 'read_external'

export type ShellCheck =
  /** 放行；`effect` 交给门禁那一关按 `side_effect_policy` 再判一次。 */
  | { verdict: 'allow'; effect: ShellEffect; note: string }
  /** 拒；`reason` 就是给人看的那一句（门禁物化成 `tool.result{blocked}`）。 */
  | { verdict: 'deny'; reason: string }
  /**
   * 这是一次**发布**（换线上主题）。公司端**不直接拒**——门禁把它做成
   * 一条 `publish_theme` 的 staged change（15 §2：high 风险、hard_ceiling、永远 L1），
   * 批了才由服务端 `shopify-theme.ts` 真跑。
   */
  | { verdict: 'publish'; reason: string; theme_id?: string }

export interface ShellPolicyInput {
  /** 模型给的 `command`（`bash -c` 的那一整串）。 */
  command: string
  /** 模型给的 `workdir`（可选；相对路径按沙箱根解析）。 */
  workdir?: string
  /** 沙箱根 = 主题工作副本目录。 */
  root: string
  /** 模型给的 `sandbox_permissions`（要升档）；给了就一律拒。 */
  sandboxPermissions?: string
  /** 模型给的 `run_in_background`；给了就一律拒（17 §5.1 一次运行一棵树）。 */
  background?: boolean
}

// ── allowlist 表 ───────────────────────────────────────────────────────

/** `shopify theme <sub>`：读或"推一份副本"，线上一个字节不动。 */
const SHOPIFY_THEME_READ: readonly string[] = ['list', 'pull', 'check', 'info']
/** `shopify theme <sub>`：**会换线上那一份**，一律物化成 `publish_theme` 的卡。 */
const SHOPIFY_THEME_PUBLISH: readonly string[] = ['publish', 'delete', 'rename']
/**
 * `shopify theme <sub>`：**一律拒**。
 * `dev` / `console` / `language-server` 是长驻进程（17 §5.1：一次运行一棵树，
 * 跑完就销毁，长驻的东西没有主人）；`open` / `share` 会把预览抛到外面去。
 */
const SHOPIFY_THEME_FORBIDDEN: readonly string[] = [
  'dev',
  'console',
  'language-server',
  'open',
  'share',
  'serve',
  'profile',
]
/** `shopify <top>`：只有 `theme` 这一棵子树 + 两条无害的。 */
const SHOPIFY_TOP: readonly string[] = ['theme', 'version', 'help']

/**
 * `git <sub>`：**只有本地的那些**。
 * 没有 `push` / `pull` / `fetch` / `clone` / `remote` / `config` / `submodule`：
 * 前五个通网络（主题工作副本不该有远端），`config` 能设 `core.sshCommand` 这种
 * "下次 git 操作顺手跑一条命令"的字段——那等于把 allowlist 整个绕开。
 */
const GIT_LOCAL: readonly string[] = [
  'status',
  'diff',
  'log',
  'show',
  'add',
  'commit',
  'init',
  'branch',
  'checkout',
  'switch',
  'restore',
  'stash',
  'rev-parse',
  'ls-files',
]

/** `node`：只有报版本，与跑工作副本里的一个脚本文件。 */
const NODE_FORBIDDEN_FLAGS: readonly string[] = [
  '-e',
  '--eval',
  '-p',
  '--print',
  '-i',
  '--interactive',
  '-r',
  '--require',
  '--import',
]

/** `pnpm <sub>`：装依赖与看依赖。没有 `run` / `exec` / `dlx` / `add`——那三个能跑任意东西。 */
const PNPM_SUB: readonly string[] = ['install', 'i', 'list', 'ls', '--version', '-v']

/** `npx` 后面只许跟这两个（再把余下的参数按 `shopify` 那张表重判一次）。 */
const NPX_PACKAGES: readonly string[] = ['shopify', '@shopify/cli']

/** 版本 / 帮助这种到处都一样的无害参数。 */
const VERSION_FLAGS: readonly string[] = ['--version', '-v', '--help', '-h', 'help', 'version']

// ── 语法：先把"能绕开 allowlist 的写法"整类拒掉 ────────────────────────

/**
 * 判之前先掐掉的写法。
 *
 * 这一组不是"某条命令不许"，是**某种写法不许**——它们都能让一条过了 allowlist
 * 的命令把另一条没过的带进来：管道（`curl … | sh`）、命令替换（`` `…` `` / `$(…)`）、
 * 进程替换（`<(…)`）、后台（`&`）。`;` / `&&` / `||` 不在这里：那三个只是把命令排成一串，
 * 每一条**各自**再过一遍 allowlist 就够了（见 {@link checkShellCommand} 的分段）。
 */
const SYNTAX_DENIALS: readonly { test: RegExp; reason: string }[] = [
  {
    test: /\|/,
    reason:
      'shell_pipe_forbidden: 这里不支持管道（`|`）。管道能把一条没被允许的命令接在' +
      '允许的命令后面跑（比如把下载到的东西直接交给 shell 执行），所以整类不放行。',
  },
  {
    test: /`|\$\(/,
    reason:
      'shell_substitution_forbidden: 这里不支持命令替换（`` ` `` 与 `$(…)`）。' +
      '括号里的东西会先被当成命令跑一遍，那一遍绕过了命令白名单。',
  },
  {
    test: /<\(|>\(/,
    reason:
      'shell_process_substitution_forbidden: 这里不支持进程替换（`<(…)` / `>(…)`），理由同命令替换。',
  },
]

/** 切成一条一条（`;` / `&&` / `||` / 换行）。 */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 极简分词：认单双引号，不认转义里的引号（认不出来就整条拒，见调用处）。 */
function tokenize(segment: string): string[] | undefined {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started || current !== '') out.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
  }
  if (quote !== undefined) return undefined
  if (started || current !== '') out.push(current)
  return out
}

/** 一个路径在不在沙箱根里面（**不解 symlink**：那一层由沙箱的内核规则兜底）。 */
export function insideRoot(root: string, path: string): boolean {
  if (path.startsWith('~')) return false
  const abs = isAbsolute(path) ? path : resolve(root, path)
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 这个词看着像不像一个路径（像才去判越界；`--theme` `123` 这种不判）。 */
function looksLikePath(token: string): boolean {
  if (token.startsWith('-')) return false
  if (token.startsWith('/') || token.startsWith('~')) return true
  return token.split('/').includes('..')
}

/**
 * 重定向：把 `> foo` / `>>foo` / `2> foo` / `< foo` 从 argv 里摘出来。
 * 回 `undefined` = 有一个目标跑到工作副本外面去了。
 */
function stripRedirects(
  tokens: readonly string[],
  root: string,
): { argv: string[]; targets: string[] } | undefined {
  const argv: string[] = []
  const targets: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    const m = /^(\d*)(>>|>|<)(.*)$/.exec(token)
    if (m === null) {
      argv.push(token)
      continue
    }
    let target = m[3] ?? ''
    if (target === '') {
      i += 1
      target = tokens[i] ?? ''
    }
    if (target === '' || !insideRoot(root, target)) return undefined
    targets.push(target)
  }
  return { argv, targets }
}

// ── 主判定 ─────────────────────────────────────────────────────────────

/**
 * 一次 `bash` 调用过不过得了 allowlist 这一关。
 *
 * 三种结果见 {@link ShellCheck}。**整条命令里只要有一段是发布，整条就是发布**——
 * 不允许"前面跑几条正经的、最后偷偷挂一条 publish"。
 */
export function checkShellCommand(input: ShellPolicyInput): ShellCheck {
  const command = input.command
  if (typeof command !== 'string' || command.trim() === '') {
    return { verdict: 'deny', reason: 'shell_empty_command: 命令是空的' }
  }
  if (input.background === true) {
    return {
      verdict: 'deny',
      reason:
        'shell_background_forbidden: 这里不跑后台命令。一次任务跑完这棵树就销毁了，' +
        '后台进程会失去主人；要等的事情请把它拆成能在一次调用里跑完的几步。',
    }
  }
  if (input.sandboxPermissions !== undefined && input.sandboxPermissions !== '') {
    return {
      verdict: 'deny',
      reason:
        `shell_escalation_forbidden: 不给放宽沙箱（${input.sandboxPermissions}）。` +
        '这个岗位只能在主题工作副本目录里写东西，这一条没有例外。',
    }
  }
  // `&&` 要先拿掉，剩下的单个 `&` 才是"扔后台"
  const withoutAnd = command.replace(/&&/g, ' ')
  if (/&/.test(withoutAnd)) {
    return {
      verdict: 'deny',
      reason: 'shell_background_forbidden: 命令里有 `&`（扔后台跑）。这里只跑前台命令。',
    }
  }
  for (const rule of SYNTAX_DENIALS) {
    if (rule.test.test(command)) return { verdict: 'deny', reason: rule.reason }
  }
  if (input.workdir !== undefined && !insideRoot(input.root, input.workdir)) {
    return {
      verdict: 'deny',
      reason: `shell_workdir_outside: 只能在主题工作副本目录里干活，${input.workdir} 不在里面。`,
    }
  }

  const parts = segments(command)
  if (parts.length === 0) return { verdict: 'deny', reason: 'shell_empty_command: 命令是空的' }

  let effect: ShellEffect = 'local'
  let note = ''
  let publish: { reason: string; theme_id?: string } | undefined
  for (const part of parts) {
    const one = checkSegment(part, input.root)
    if (one.verdict === 'deny') return one
    if (one.verdict === 'publish') {
      // 一段是发布，整条就是发布（不允许把 publish 藏在一串正经命令后面）
      publish ??= {
        reason: one.reason,
        ...(one.theme_id === undefined ? {} : { theme_id: one.theme_id }),
      }
      continue
    }
    if (one.effect === 'read_external') effect = 'read_external'
    if (note === '') note = one.note
  }
  if (publish !== undefined) return { verdict: 'publish', ...publish }
  return { verdict: 'allow', effect, note }
}

/** 一段（`;` / `&&` 切出来的一条）过不过。 */
function checkSegment(segment: string, root: string): ShellCheck {
  const tokens = tokenize(segment)
  if (tokens === undefined) {
    return {
      verdict: 'deny',
      reason: 'shell_unbalanced_quotes: 命令里的引号没有配对，读不准它要干什么。',
    }
  }
  const stripped = stripRedirects(tokens, root)
  if (stripped === undefined) {
    return {
      verdict: 'deny',
      reason:
        'shell_write_outside_workspace: 这条命令要把东西写到主题工作副本目录之外。' +
        '这个岗位只能动那一份副本里的文件。',
    }
  }
  const argv = stripped.argv
  const head = argv[0]
  if (head === undefined || head === '') {
    return { verdict: 'deny', reason: 'shell_empty_command: 有一段是空的' }
  }
  // 路径越界先判（比"这条命令在不在表里"更该先说清楚）
  for (const token of argv.slice(1)) {
    const value =
      token.startsWith('--') && token.includes('=') ? token.slice(token.indexOf('=') + 1) : token
    if (looksLikePath(value) && !insideRoot(root, value)) {
      return {
        verdict: 'deny',
        reason: `shell_path_outside_workspace: ${value} 不在主题工作副本目录里，这个岗位碰不到它。`,
      }
    }
  }
  if (head === 'rm' || head === 'rmdir') {
    return {
      verdict: 'deny',
      reason:
        'shell_destructive_forbidden: 不跑 `rm`。要撤销改动就重新 `shopify theme pull` 拉一份干净的，' +
        '删文件这件事不该由 AI 直接做。',
    }
  }
  switch (head) {
    case 'shopify':
      return checkShopify(argv.slice(1))
    case 'git':
      return checkGit(argv.slice(1))
    case 'node':
      return checkNode(argv.slice(1), root)
    case 'npx':
      return checkNpx(argv.slice(1))
    case 'pnpm':
      return checkPnpm(argv.slice(1))
    default:
      return {
        verdict: 'deny',
        reason: `shell_command_not_allowed: 这个岗位只跑 shopify / git / node / npx / pnpm 这几条命令，\`${head}\` 不在里面。`,
      }
  }
}

/** `--live` / `--allow-live` 这种"就是要动线上"的标记。 */
function touchesLive(args: readonly string[]): boolean {
  return args.some((a) => a === '--live' || a === '--allow-live' || a.startsWith('--live='))
}

/** `--theme <id>` / `--theme=<id>`。 */
function themeIdOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string
    if (a === '--theme' || a === '-t') return args[i + 1]
    if (a.startsWith('--theme=')) return a.slice('--theme='.length)
  }
  return undefined
}

function publishVerdict(what: string, args: readonly string[]): ShellCheck {
  const theme_id = themeIdOf(args)
  return {
    verdict: 'publish',
    reason:
      `theme_publish_needs_approval: \`${what}\` 会换掉顾客看到的那一份主题。` +
      '我没有直接跑它，而是做了一张"发布主题"的卡放进待办——有人点头之后才会真的发布。',
    ...(theme_id === undefined ? {} : { theme_id }),
  }
}

function checkShopify(args: readonly string[]): ShellCheck {
  const sub = args[0]
  if (sub === undefined || VERSION_FLAGS.includes(sub)) {
    return { verdict: 'allow', effect: 'local', note: 'shopify 自报版本' }
  }
  if (!SHOPIFY_TOP.includes(sub)) {
    return {
      verdict: 'deny',
      reason: `shell_shopify_subcommand_not_allowed: 这个岗位只用 \`shopify theme\` 这一组命令，\`shopify ${sub}\` 不在里面。`,
    }
  }
  if (sub !== 'theme') return { verdict: 'allow', effect: 'local', note: `shopify ${sub}` }
  const action = args[1]
  if (action === undefined || VERSION_FLAGS.includes(action)) {
    return { verdict: 'allow', effect: 'local', note: 'shopify theme 帮助' }
  }
  const rest = args.slice(2)
  if (SHOPIFY_THEME_FORBIDDEN.includes(action)) {
    return {
      verdict: 'deny',
      reason:
        `shell_shopify_theme_forbidden: \`shopify theme ${action}\` 在这里跑不了——` +
        '它要么是个长驻的服务（这次任务跑完就没人管它了），要么会把预览抛到外面去。',
    }
  }
  if (SHOPIFY_THEME_PUBLISH.includes(action)) {
    return publishVerdict(`shopify theme ${action}`, rest)
  }
  if (action === 'push') {
    if (touchesLive(rest)) return publishVerdict('shopify theme push --live', rest)
    if (!rest.includes('--unpublished')) {
      return publishVerdict('shopify theme push（没带 --unpublished，等于推到线上那一份）', rest)
    }
    return {
      verdict: 'allow',
      effect: 'read_external',
      note: '把工作副本推成一份**未发布**的主题（线上一个字节不动，12 §2：副本就是 stage）',
    }
  }
  if (SHOPIFY_THEME_READ.includes(action)) {
    if (touchesLive(rest) && action !== 'pull') {
      return publishVerdict(`shopify theme ${action} --live`, rest)
    }
    return { verdict: 'allow', effect: 'read_external', note: `shopify theme ${action}` }
  }
  return {
    verdict: 'deny',
    reason: `shell_shopify_theme_not_allowed: \`shopify theme ${action}\` 不在这个岗位能跑的命令表里。`,
  }
}

function checkGit(args: readonly string[]): ShellCheck {
  const sub = args[0]
  if (sub === undefined || VERSION_FLAGS.includes(sub)) {
    return { verdict: 'allow', effect: 'local', note: 'git 自报版本' }
  }
  if (!GIT_LOCAL.includes(sub)) {
    return {
      verdict: 'deny',
      reason:
        `shell_git_subcommand_not_allowed: \`git ${sub}\` 不在这个岗位能跑的命令表里——` +
        '这里的 git 只用来在工作副本里记一下自己改了什么，不连远端、不改配置。',
    }
  }
  return { verdict: 'allow', effect: 'local', note: `git ${sub}` }
}

function checkNode(args: readonly string[], root: string): ShellCheck {
  const first = args[0]
  if (first === undefined || VERSION_FLAGS.includes(first)) {
    return { verdict: 'allow', effect: 'local', note: 'node 自报版本' }
  }
  for (const a of args) {
    if (NODE_FORBIDDEN_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) {
      return {
        verdict: 'deny',
        reason:
          `shell_node_inline_script_forbidden: \`node ${a}\` 是"把一段代码直接交给 node 跑"。` +
          '那一段代码没经过任何检查，所以不放行；要跑脚本就把它写成工作副本里的一个文件。',
      }
    }
  }
  if (first.startsWith('-')) {
    return {
      verdict: 'deny',
      reason: `shell_node_flag_not_allowed: \`node ${first}\` 不在允许的用法里。`,
    }
  }
  if (!insideRoot(root, first)) {
    return {
      verdict: 'deny',
      reason: `shell_node_script_outside: 只能跑主题工作副本里的脚本，${first} 不在里面。`,
    }
  }
  return { verdict: 'allow', effect: 'local', note: `node ${first}` }
}

function checkNpx(args: readonly string[]): ShellCheck {
  const pkg = args[0]
  if (pkg === undefined || VERSION_FLAGS.includes(pkg)) {
    return { verdict: 'allow', effect: 'local', note: 'npx 自报版本' }
  }
  if (!NPX_PACKAGES.includes(pkg)) {
    return {
      verdict: 'deny',
      reason:
        `shell_npx_package_not_allowed: \`npx ${pkg}\` 不放行。npx 会去网上取一个包下来直接跑，` +
        '这个岗位只允许用它跑 Shopify 官方 CLI。',
    }
  }
  // 后面的参数按 `shopify` 那张表重判一次（`npx shopify theme publish` 照样是发布）
  const inner = checkShopify(args.slice(1))
  if (inner.verdict === 'allow') return { ...inner, effect: 'read_external' }
  return inner
}

function checkPnpm(args: readonly string[]): ShellCheck {
  const sub = args[0]
  if (sub === undefined || VERSION_FLAGS.includes(sub)) {
    return { verdict: 'allow', effect: 'local', note: 'pnpm 自报版本' }
  }
  if (!PNPM_SUB.includes(sub)) {
    return {
      verdict: 'deny',
      reason:
        `shell_pnpm_subcommand_not_allowed: \`pnpm ${sub}\` 不放行——` +
        '`run` / `exec` / `dlx` / `add` 这几个等于"跑任意东西"，绕过了命令白名单。',
    }
  }
  return { verdict: 'allow', effect: 'read_external', note: `pnpm ${sub}` }
}

// ── 凭据（13 §4：只有名字与地址，值不进契约、不进事件、不进模型）────────

/** CLI 认的两个环境变量（与 `apps/server/src/shopify-theme.ts` 同名，故意的）。 */
export const THEME_TOKEN_ENV = 'SHOPIFY_CLI_THEME_TOKEN'
export const THEME_STORE_ENV = 'SHOPIFY_FLAG_STORE'

/** 一次运行要往子进程环境里放哪些名字（**这里也只有名字**）。 */
export interface ShellCredentialPlan {
  /** 直接有值的那些（店铺域名不是秘密）。 */
  literals: Record<string, string>
  /** 环境变量名 → 本机引用层的凭据引用名（`ctx.credentials.resolve`）。 */
  refs: Record<string, string>
  /** 环境变量名 → `ctx.credentials` 的记录地址（`<owner>/<id>`，取 `payload.access`）。 */
  records: Record<string, string>
}

/**
 * `RunShell` → 要往子进程放的那几个名字。
 *
 * `SHOPIFY_FLAG_STORE` 走 literal（店铺域名在提示词里本来就写着，不是秘密），
 * `SHOPIFY_CLI_THEME_TOKEN` 走记录层（OpenConnector 里这家店的 Shopify 连接）。
 * 两个都不进事件日志——{@link ShellCredentialPlan} 的调用方只拿名字去 `process.env`
 * 里放一下再还原，一个值都不记。
 */
export function shellCredentialPlan(shell: RunShell): ShellCredentialPlan {
  return {
    literals:
      shell.store === undefined || shell.store === '' ? {} : { [THEME_STORE_ENV]: shell.store },
    refs: { ...(shell.env_refs ?? {}) },
    records:
      shell.token_record === undefined || shell.token_record === ''
        ? {}
        : { [THEME_TOKEN_ENV]: shell.token_record },
  }
}

// ── 提示词 ─────────────────────────────────────────────────────────────

/**
 * 写进提示词的那一段（persona 的 `complete` 段里——别开新段，新段会被遮掉）。
 *
 * 四件事，都是**模型自己判不出来**的：能跑哪几条命令、只能在哪个目录里写、
 * 改动怎么给人看、为什么 `publish` 按不下去。官方 `tool-bash` 自己那句
 * "Check the [exit code: N] marker" 是独立注册的段，不受 complete 段遮蔽，
 * 所以这里不重复它。
 */
export function shellBrief(input: {
  root: string
  store?: string
  mode: RunShell['mode']
}): string {
  const lines = [
    '## 终端（主题工作副本）',
    `你可以用 \`bash\` 工具在这个目录里干活：\`${input.root}\`。${
      input.mode === 'read-only'
        ? '现在是只读档，写不了东西。'
        : '只有这个目录能写，别的地方一律写不进去。'
    }`,
    '能跑的命令只有这几条（别的一律被拦下来，不要试）：',
    '- `shopify theme list / pull / check / info`：看店里有哪些主题、把一份拉到本地。',
    '- `shopify theme push --unpublished --theme <名字>`：把改好的副本推成一份**未发布**的主题，' +
      '拿到预览链接给人看。这是你改动落地的唯一方式。',
    '- `git status / diff / add / commit` 等本地命令：记一下自己改了什么。',
    '- `node <副本里的脚本>` / `npx shopify …` / `pnpm install`。',
    '**发布是人的事**：`shopify theme publish`、任何带 `--live` 的命令，你按不下去——' +
      '你提一次，它会变成一张"发布主题"的卡进待办，由人点头之后才真的换线上那一份。',
    '管道（`|`）、命令替换（`` ` ``、`$(…)`）、后台（`&`）、`rm` 都跑不了；' +
      '要写文件就写在上面那个目录里。',
  ]
  if (input.store !== undefined && input.store !== '') {
    lines.push(`这次操作的店铺是 ${input.store}（CLI 已经知道，命令里不用再带 \`--store\`）。`)
  }
  return lines.join('\n')
}

/**
 * WP89（55 §8「凭据」那一行）：**跑命令的那一跳**才把 CLI 的凭据交给子进程，命令一结束就撤。
 *
 * 为什么不像 preset 那样经 `process.env`（实测出来的一条硬事实）：官方
 * `dsh-subprocess` 对**继承来的**环境有一道自己的清洗——`SENSITIVE_ENV_PATTERN =`
 * `/KEY|PASSWORD|SECRET|TOKEN/i` 的名字一律**不往子进程传**（上游原话：the harness's own
 * `DEEPSEEK_API_KEY`/secrets must not leak into a spawned process implicitly）。
 * `SHOPIFY_CLI_THEME_TOKEN` 正好撞这条，放进 `process.env` 它到不了 CLI 手里。
 *
 * 上游给的那条路是"显式 env 在清洗之后合进去"，而显式 env 来自 `ShellExecSpec.env`
 * ——官方 `tool-bash` 不填它（它有意不把 `env` 开给模型）。所以我们**继承执行器**，
 * 在 `resolve()` 里把这一跳要用的几个名字合进去。结果比 preset 那条路更紧：
 *
 * - 令牌**一次都不进这个进程的环境**（`process.env` 里查不到）；
 * - 它只在"这一条命令"的 spec 里活着，`tools/post-execute` 一到就清空（`gate.ts`）；
 * - 事件日志、模型面、生成的文件三处都只看得见名字。
 */
export class AgentswsBashExecutor extends SandboxBashExecutor {
  /** 这一条命令要用的环境变量（**值**）。命令之间它是空的。 */
  private commandEnv: Record<string, string> = {}

  /** 门禁在 `tools/pre-execute` 里放，`tools/post-execute` 里清（一条命令一开一合）。 */
  setCommandEnv(env: Record<string, string>): void {
    this.commandEnv = env
  }

  clearCommandEnv(): void {
    this.commandEnv = {}
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    if (Object.keys(this.commandEnv).length === 0) return spec
    // 调用方自己给的 env 优先（上游的合并顺序：显式 env 压 ENV_OVERRIDES）
    return { ...spec, env: { ...this.commandEnv, ...spec.env } }
  }
}

/**
 * 按 {@link ShellCredentialPlan} 取出这一跳要用的值。
 *
 * 三条纪律：
 * 1. **只在这一跳里存在**：返回值由调用方交给执行器，命令跑完就清；
 * 2. **取不到就不给**：连接没接上、跨工作区、地址不合法，一律当"没有这把凭据"——
 *    CLI 自己会报一句 401，那比在这里抛一个看不懂的错好；
 * 3. **一个字都不进事件、不进模型**：这里既不发事件也不记日志，名字都不记。
 */
export async function resolveShellEnv(
  ctx: Context,
  plan: ShellCredentialPlan,
  hasCredentials: boolean,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(plan.literals)) {
    if (value !== '') out[name] = value
  }
  if (!hasCredentials) return out
  for (const [name, ref] of Object.entries(plan.refs)) {
    if (!isCredentialRefName(ref)) continue
    const hit = await ctx.credentials.resolve(credentialRef(ref))
    if (hit !== undefined && hit.value !== '') out[name] = hit.value
  }
  for (const [name, address] of Object.entries(plan.records)) {
    const value = await readGrantAccess(ctx, address)
    if (value !== undefined && value !== '') out[name] = value
  }
  return out
}

/** `<owner>/<id>` → 这条连接现在能用的那把凭证（`CompositeCredentials.readRecord` 的 payload）。 */
async function readGrantAccess(ctx: Context, address: string): Promise<string | undefined> {
  try {
    const record = await ctx.credentials.readRecord(parseCredentialKey(address))
    // 记录是个 tagged union（`ApiKeyRecord | GrantRecord`）；OpenConnector 那条永远是
    // `grant`，`payload.access` 就是"代这条职责去调"的那把凭证（`credentials-openconnector`
    // 的 `ConnectionGrantPayload`）。别的形状一律当"没有这把凭据"。
    if (record === undefined || record.kind !== 'grant') return undefined
    const payload = record.payload as { access?: unknown }
    return typeof payload.access === 'string' ? payload.access : undefined
  } catch {
    return undefined
  }
}
