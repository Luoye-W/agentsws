/**
 * WP216：`/v1/platform-kit*` 的服务端那一半——**按品牌档案**把平台专属那一套算出来。
 *
 * 真源是 `@agentsws/contracts` 的 `PLATFORM_KITS`；这个文件里没有一个平台名。
 *
 * 三条（Fable 10-05 改）：
 *
 * 1. **平台没设 = 一样都不启用**（不按 Shopify 兜底）。
 * 2. 没设、但这个品牌已经连了某个平台的店铺（Shopify 就是 `shopify_admin`）→ 按它推断，并**写回档案**
 *    （界面上照样能改；档案还没建过就只在这次算数，不替人建档案）。推断在 {@link resolveBrandPlatform}。
 * 3. CLI 卡只给**真有那几条职责**的品牌（Reddit 代运营这种没有建站岗位的品牌永远不出）；
 *    没设平台的品牌在建站岗位页上出一行「先选一下你的建站平台」。
 */
import {
  ApiError,
  type PlatformCliState,
  type PlatformKitPort,
  type PlatformKitView,
} from '@agentsws/api'
import {
  type PlatformCliSpec,
  type PlatformKit,
  platformKitOf,
  platformPositions,
  STOREFRONT_PLATFORMS,
  type StorefrontPlatform,
} from '@agentsws/contracts'
import type { PlatformCliLoginStore, PlatformCliProbe, PlatformCliProber } from './platform-cli.js'
import { CliRunnerError, type PlatformCliRunner } from './platform-cli-runner.js'
import type { CliSession } from './platform-cli-session.js'

/** 推断平台要的几样事实（都按品牌问、每次现取）。 */
export interface BrandPlatformFacts {
  /** 档案里写的（没写 = undefined）。 */
  profile(workspace_id: string): StorefrontPlatform | undefined
  /** 这个品牌现在连着的店铺连接（连接目录里的 service，如 `shopify_admin`）。 */
  connectedServices(workspace_id: string): readonly string[]
  /** 推断出来之后写回档案（档案还没建过回 false）。 */
  writeBack(workspace_id: string, platform: StorefrontPlatform): boolean
}

/**
 * 这个品牌的建站平台：档案有就用档案；没有就看连了哪个平台的店铺（恰好一个才算），推断出来写回档案。
 * 都没有 → `undefined`（平台专属的东西一样都不启用）。
 */
export function resolveBrandPlatform(
  facts: BrandPlatformFacts,
  workspace_id: string,
): StorefrontPlatform | undefined {
  const set = facts.profile(workspace_id)
  if (set !== undefined) return set
  const services = new Set(facts.connectedServices(workspace_id))
  const hits = STOREFRONT_PLATFORMS.filter(
    (p) => p.connector_service !== undefined && services.has(p.connector_service),
  )
  if (hits.length !== 1) return undefined
  const inferred = hits[0]?.id
  if (inferred === undefined) return undefined
  facts.writeBack(workspace_id, inferred)
  return inferred
}

export interface PlatformKitPortOptions {
  now: () => string
  /** 这个品牌的平台（已经过 {@link resolveBrandPlatform}，每次现取）。 */
  platformOf(workspace_id: string): StorefrontPlatform | undefined
  /** 改档案上的平台（人在岗位页上选的那一下）。档案还没建过回 false。 */
  setPlatform(workspace_id: string, platform: StorefrontPlatform): boolean
  /** 这个品牌有没有人在做这几条职责（没撤销的分配）。 */
  hasRoles(workspace_id: string, role_ids: readonly string[]): boolean
  prober: PlatformCliProber
  /** 这个品牌的「我登好了」那一笔（按品牌的数据目录）。 */
  loginStoreOf(workspace_id: string): PlatformCliLoginStore
  /** 技能给人看的名字（frontmatter / 旁注里的 `display_name`）。 */
  displayNameOf?(name: string): { zh: string; en: string } | undefined
  /** 官方 MCP：这台机器上开着没（默认开）、下载起来没、现在能调哪几个工具。 */
  mcpStatus?(): { enabled: boolean; downloaded: boolean; tools: string[] }
  /** 首次设置同一份平台清单（灰显的照样给）。 */
  platformChoices?(): { key: string; label: string; supported: boolean }[]
  /**
   * WP245：替用户跑登记过的命令（一键安装 / 一键登录）。不给 = 卡上只有老的复制命令那一套。
   */
  runner?: PlatformCliRunner
  /** WP253：这个品牌的 CLI 会话（别名 + 配置目录；一个品牌一份）。不给 = 整台电脑共用一份。 */
  sessionOf?(workspace_id: string, spec: PlatformCliSpec): CliSession | undefined
  /** WP258：一键登录成功之后（记过「登好了」那一笔）——建站岗位接着去找这个账号下的店。 */
  onLoggedIn?(workspace_id: string, spec: PlatformCliSpec): void
  /** 记一笔事件（只有 CLI id / 状态，没有任何输出与凭据）。 */
  appendEvent?(workspace_id: string, type: string, payload: Record<string, unknown>): void
}

/** 四档：没装 → Node 不够 → 没登录 → 好了。 */
export function cliStateOf(
  probe: PlatformCliProbe | undefined,
  confirmedAt: string | undefined,
): PlatformCliState {
  if (probe === undefined || !probe.installed) return 'missing'
  if (!probe.node_ok) return 'node_old'
  if (confirmedAt === undefined) return 'needs_login'
  return 'ready'
}

function hasAnything(kit: PlatformKit): boolean {
  return kit.skills.length > 0 || kit.mcp !== undefined || kit.cli !== undefined
}

export function createPlatformKitPort(options: PlatformKitPortOptions): PlatformKitPort {
  const cliView = async (
    ws: string,
    spec: PlatformCliSpec,
    fresh: boolean,
  ): Promise<NonNullable<NonNullable<PlatformKitView['kit']>['cli']>> => {
    const probe = await options.prober.probe(spec, { fresh })
    const login_confirmed_at = options.loginStoreOf(ws).confirmedAt(spec.id)
    const state = cliStateOf(probe, login_confirmed_at)
    const runner = options.runner
    const job = runner?.job(spec.id)
    return {
      spec,
      probe,
      ...(runner === undefined
        ? {}
        : {
            can: {
              install: runner.toolsDir !== undefined,
              login: (spec.login_args?.length ?? 0) > 0,
            },
          }),
      ...(job === undefined ? {} : { job }),
      ...(login_confirmed_at === undefined ? {} : { login_confirmed_at }),
      state,
      degraded_roles: state === 'ready' ? [] : [...spec.roles],
    }
  }

  const build = async (
    ws: string,
    input: { position_id?: string; fresh?: boolean },
  ): Promise<PlatformKitView> => {
    const platform = options.platformOf(ws)
    if (platform === undefined) {
      // 没设平台：一样都不启用。只在平台专属工具会出现的那个岗位页上提示一句「先选一下」
      const ask = input.position_id !== undefined && platformPositions().includes(input.position_id)
      return {
        kit: null,
        ...(ask ? { choose_platform: { choices: options.platformChoices?.() ?? [] } } : {}),
      }
    }
    const kit = platformKitOf(platform)
    if (kit === undefined || !hasAnything(kit)) return { platform, kit: null }
    const cli = kit.cli
    // CLI 卡：这个品牌真有那几条职责（没有建站岗位的品牌永远不出），并且是那一行写的岗位页（连接页不带 position_id）
    const wantCli =
      cli !== undefined &&
      options.hasRoles(ws, cli.roles) &&
      (input.position_id === undefined || cli.positions.includes(input.position_id))
    const mcp = kit.mcp
    return {
      platform,
      kit: {
        skills: kit.skills.map((name) => {
          const display_name = options.displayNameOf?.(name)
          return display_name === undefined ? { name } : { name, display_name }
        }),
        ...(kit.skill_source === undefined ? {} : { skill_source: kit.skill_source }),
        ...(mcp === undefined
          ? {}
          : {
              mcp: {
                ...mcp,
                ...(options.mcpStatus?.() ?? { enabled: false, downloaded: false, tools: [] }),
              },
            }),
        ...(wantCli && cli !== undefined
          ? { cli: await cliView(ws, cli, input.fresh === true) }
          : {}),
      },
    }
  }

  return {
    view: (actor, input) => build(actor.workspace_id, input),
    checkCli: async (actor) => {
      const view = await build(actor.workspace_id, { fresh: true })
      const cli = view.kit?.cli
      if (cli !== undefined)
        options.appendEvent?.(actor.workspace_id, 'platform_cli.checked', {
          cli: cli.spec.id,
          state: cli.state,
          ...(cli.probe?.version === undefined ? {} : { version: cli.probe.version }),
        })
      return view
    },
    confirmLogin: async (actor, input) => {
      const cli = platformKitOf(options.platformOf(actor.workspace_id))?.cli
      // 平台没有 CLI：什么都不记（非 Shopify 的品牌点不到这里，点到了也不落东西）
      if (cli !== undefined) {
        options
          .loginStoreOf(actor.workspace_id)
          .set(cli.id, input.confirmed ? options.now() : undefined)
        options.appendEvent?.(actor.workspace_id, 'platform_cli.login_confirmed', {
          cli: cli.id,
          confirmed: input.confirmed,
        })
      }
      return build(actor.workspace_id, {})
    },
    runCli: async (actor, input) => {
      const ws = actor.workspace_id
      const action = input.action
      // 「报版本」= 再查一次（不走缓存），走检测那条路
      if (action === 'version') return build(ws, { fresh: true })
      const runner = options.runner
      if (runner === undefined)
        throw new ApiError('not_implemented', '这个服务进程不能替用户跑命令')
      const view = await build(ws, {})
      const cli = view.kit?.cli
      // 平台没有 CLI / 这个品牌没有那几条职责：没有可跑的（不接受「替我跑别的」）
      if (cli === undefined) throw new ApiError('not_found', '这个品牌的平台没有要装的命令行工具')
      const spec = cli.spec
      if (action === 'login' && cli.probe?.installed !== true)
        throw new ApiError('conflict', `${spec.label} 还没装好，先装再登录`)
      try {
        const session = options.sessionOf?.(ws, spec)
        runner.start(spec, action, {
          ...(session === undefined ? {} : { session }),
          onLoginOk: () => {
            options.loginStoreOf(ws).set(spec.id, options.now())
            try {
              options.onLoggedIn?.(ws, spec)
            } catch {
              // 找店失败不影响「登好了」
            }
          },
          onFinished: (job) => {
            options.prober.invalidate?.(spec.id)
            options.appendEvent?.(ws, `platform_cli.${job.action}_finished`, {
              cli: spec.id,
              phase: job.phase,
              ...(job.error === undefined ? {} : { error: job.error.code }),
            })
          },
        })
      } catch (err) {
        if (err instanceof CliRunnerError)
          throw new ApiError(
            err.code === 'conflict'
              ? 'conflict'
              : err.code === 'not_supported'
                ? 'invalid_input'
                : 'not_implemented',
            err.message,
          )
        throw err
      }
      options.appendEvent?.(ws, `platform_cli.${action}_started`, { cli: spec.id })
      return build(ws, {})
    },
    cancelCli: async (actor) => {
      const cli = platformKitOf(options.platformOf(actor.workspace_id))?.cli
      if (cli !== undefined) options.runner?.cancel(cli.id)
      return build(actor.workspace_id, {})
    },
    setPlatform: async (actor, input) => {
      const spec = STOREFRONT_PLATFORMS.find((p) => p.id === input.storefront_platform)
      if (spec === undefined || !spec.supported)
        throw new ApiError('invalid_input', `选不了这个平台：${input.storefront_platform}`)
      if (!options.setPlatform(actor.workspace_id, spec.id))
        throw new ApiError('conflict', '这个品牌还没做首次设置，先去设置里填一下公司信息')
      return build(
        actor.workspace_id,
        input.position_id === undefined ? {} : { position_id: input.position_id },
      )
    },
  }
}
