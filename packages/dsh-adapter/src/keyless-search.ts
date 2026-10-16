/**
 * WP353（Luoye 10-16，决策 912）：联网搜索**最后一道兜底**——社区插件 `@240xu/dsh-websearch`（MIT）
 * 的搜索提供方，只开它两家**免 key 的公开匿名口**（Exa / Parallel 的公开 MCP）。
 *
 * 前面几道（工坊内置浏览器搜 Google / Bing、云端 Google）都不行时才用它；结果照实标「来自公开搜索服务」。
 *
 * 插件我们**原样挂**（`apply` + 官方 `ctx.web` 那一套提供方接口），外面只包三件事——都是为了守纪律：
 *
 * 1. **不读进程环境变量**：插件在没有 `launchEnvironment` 服务时会退回读 `process.env`
 *    （找 `DSH_UNIFIED_SEARCH_BACKENDS` 与各家 key 名）。这里给它一个**空的**环境快照、
 *    不给 `credentials` 服务、显式列出要开的两家——于是它既不会自己多开别的后端，也摸不到任何 key；
 * 2. **不落盘**：搜索历史、结果缓存都关（7 天缓存在我们自己那一层，`apps/server` 的 web-browser）；
 * 3. **不挂它的设置页 / 健康路由**（`inject` 不应答）。
 *
 * 实测（10-16，本机、未填任何 key）：`site:reddit.com smart glasses` 10 / 10 条 reddit.com。
 */
import * as UnifiedSearch from '@240xu/dsh-websearch'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'

/** 只开这两家（都是公开匿名 MCP，不要 key）。 */
export const KEYLESS_SEARCH_BACKENDS = ['exa', 'parallel'] as const

/** 插件读环境变量的那一口：永远回「没有」。 */
const EMPTY_ENVIRONMENT = { get: (): undefined => undefined }

/**
 * 造一个兜底搜索提供方（每次现造也行，插件本身无状态；熔断计数在提供方闭包里）。
 * 插件导入失败（包坏了 / 没装）回 `undefined`，调用方当「这一道没有」。
 */
export function keylessWebSearch(): WebSearchProvider | undefined {
  let provider: WebSearchProvider | undefined
  const ctx = {
    // 设置页 / 健康路由：不应答（这两个服务我们不挂）
    inject: (): undefined => undefined,
    get: (name: string): unknown => (name === 'launchEnvironment' ? EMPTY_ENVIRONMENT : undefined),
    web: {
      registerSearchProvider: (p: WebSearchProvider): (() => void) => {
        provider = p
        return () => undefined
      },
    },
  }
  // 配置直接给解析好的普通对象（插件的 `Config` 在这一版 schemastery 下回的是只读包装，读不出字段）
  UnifiedSearch.apply(ctx, {
    enabledBackends: [...KEYLESS_SEARCH_BACKENDS],
    historyEnabled: false,
    cacheEnabled: false,
    numResults: 10,
  })
  return provider
}
