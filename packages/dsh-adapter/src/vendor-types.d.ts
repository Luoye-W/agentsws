/**
 * WP353：`@240xu/dsh-websearch`（MIT）没带类型声明。我们只用它的 `apply`
 * （`keyless-search.ts`），这里只声明这两样。
 */
declare module '@240xu/dsh-websearch' {
  export function apply(ctx: unknown, config: unknown): void
}
