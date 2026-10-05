/**
 * WP216：`/v1/platform-kit*` 的服务端那一半——**按品牌档案**把平台专属那一套算出来。
 *
 * 真源是 `@agentsws/contracts` 的 `PLATFORM_KITS`；这个文件里没有一个平台名。
 * 品牌的平台每次现取（品牌改了平台，下一次刷新就跟着变）；平台那一行没有 CLI 就**不检测**本机。
 */
import type { PlatformCliState, PlatformKitPort, PlatformKitView } from '@agentsws/api'
import {
  DEFAULT_STOREFRONT_PLATFORM,
  type PlatformCliSpec,
  type PlatformKit,
  platformKitOf,
  type StorefrontPlatform,
} from '@agentsws/contracts'
import type { PlatformCliLoginStore, PlatformCliProbe, PlatformCliProber } from './platform-cli.js'

export interface PlatformKitPortOptions {
  now: () => string
  /** 这个品牌的平台（品牌档案，每次现取）。 */
  platformOf(workspace_id: string): StorefrontPlatform | undefined
  prober: PlatformCliProber
  /** 这个品牌的「我登好了」那一笔（按品牌的数据目录）。 */
  loginStoreOf(workspace_id: string): PlatformCliLoginStore
  /** 技能给人看的名字（frontmatter / 旁注里的 `display_name`）。 */
  displayNameOf?(name: string): { zh: string; en: string } | undefined
  /** 官方 MCP 这台机器上开着没、现在能调哪几个工具。 */
  mcpStatus?(): { enabled: boolean; tools: string[] }
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
    return {
      spec,
      probe,
      ...(login_confirmed_at === undefined ? {} : { login_confirmed_at }),
      state,
      degraded_roles: state === 'ready' ? [] : [...spec.roles],
    }
  }

  const build = async (
    ws: string,
    input: { position_id?: string; fresh?: boolean },
  ): Promise<PlatformKitView> => {
    const platform = options.platformOf(ws) ?? DEFAULT_STOREFRONT_PLATFORM
    const kit = platformKitOf(platform)
    if (kit === undefined || !hasAnything(kit)) return { platform, kit: null }
    const cli = kit.cli
    // CLI 卡只出在平台那一行写的岗位页上（连接页不带 position_id，永远出）
    const wantCli =
      cli !== undefined &&
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
          : { mcp: { ...mcp, ...(options.mcpStatus?.() ?? { enabled: false, tools: [] }) } }),
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
      const platform = options.platformOf(actor.workspace_id)
      const cli = platformKitOf(platform)?.cli
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
  }
}
