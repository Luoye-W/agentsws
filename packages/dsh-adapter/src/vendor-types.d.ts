/**
 * WP353：`@240xu/dsh-websearch`（MIT）没带类型声明。我们只用它的 `apply`
 * （`keyless-search.ts`），这里只声明这两样。
 */
declare module '@240xu/dsh-websearch' {
  export function apply(ctx: unknown, config: unknown): void
}
/**
 * WP355：社区插件 `dsh-web-search-diy`（MIT）也没带类型声明。我们只借它导出的
 * `mapResponsesResponse`（OpenAI Responses `web_search` 结果 → `ctx.web` 标准来源），见 `native-search.ts`。
 */
declare module 'dsh-web-search-diy' {
  export function mapResponsesResponse(data: unknown): {
    content?: string
    sources: { url: string; title?: string; snippet?: string }[]
    truncated: boolean
  }
}
